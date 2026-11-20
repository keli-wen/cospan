import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createParser, excerpt, boundSnapshot } from './observation.mjs';
import { replaceFile } from './state-lock.mjs';
import {
  isInspectionUnavailable,
  matchesProcessIdentity,
  processTable,
  stopExecution,
  tree,
} from './process-tree.mjs';

export {
  bornAfterParent,
  parseBorn,
  parseWindowsProcessTable,
  processIdentity,
  processTable,
  signalGroup,
  stopExecution,
  tree,
  windowsProcessTable,
} from './process-tree.mjs';

export function atomicJSON(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
  replaceFile(tmp, file);
}

function createDescendantTracker(getChildPid) {
  let root = null;
  const tracked = new Map();
  const track = () => {
    const rows = processTable();
    if (!rows) return null;
    for (const [pid, old] of tracked) {
      if (!rows.some((row) => row.pid === pid && row.born === old.born)) tracked.delete(pid);
    }
    const childPid = getChildPid();
    if (!root && childPid) root = rows.find((row) => row.pid === childPid) || null;
    if (matchesProcessIdentity(rows, root)) {
      for (const row of tree(root.pid, rows)) tracked.set(row.pid, row);
    }
    if (root && !rows.some((row) => row.pid === root.pid && row.born !== root.born)) {
      for (const row of rows) {
        if (row.pid !== root.pid && row.group === root.pid) tracked.set(row.pid, row);
      }
    }
    return rows;
  };
  return {
    track,
    getRoot: () => root,
    getKnown: () => [...tracked.values()],
  };
}

async function drainChildStreams(child, closed, session, displayName) {
  let drainTimer;
  const drained = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => {
      drainTimer = setTimeout(() => resolve(false), 500);
    }),
  ]);
  clearTimeout(drainTimer);
  if (!drained) {
    session.warn(
      `${displayName} exited but inherited output pipes did not close; output drain was bounded.`
    );
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

function buildMissingResultError({ driver, job, outcome, stdoutTail, stderr, native }) {
  let message =
    `${driver.id} did not return a parseable JSON result ` +
    `(exit ${outcome.exit}, signal ${outcome.killedSignal || 'none'}). ` +
    `stdout: see ${job.events_file}\nstderr: ${stderr || '(empty)'}`;
  if (/operation not permitted/i.test(stderr)) {
    message +=
      '\nThis looks like a harness command sandbox blocking the target CLI. ' +
      'Run unsandboxed or via the cospan MCP wrapper.';
  }
  return Object.assign(new Error(message), {
    reason: 'missing_result',
    diagnosticText: `${stdoutTail}\n${stderr}`,
    native,
  });
}

function evaluateFinalizedStream({
  driver,
  binary,
  job,
  session,
  finalized,
  outcome,
  reason,
  spawnError,
  streamError,
  stdoutTail,
  stderr,
}) {
  if (streamError)
    throw Object.assign(streamError, { reason: 'stream_error', native: finalized.native });

  let nextStderr = stderr;
  const hasResponse =
    typeof finalized.payload?.response === 'string' && Boolean(finalized.payload.response.trim());
  if (reason === 'hard_timeout' && hasResponse) {
    const warning =
      'Worker hard execution limit reached after a response was received; ' +
      'delivering the response with a cleanup warning.';
    session.warn(warning);
    nextStderr = `${nextStderr}\n${warning}`.trim();
    process.stderr.write(`cospan warning: ${warning}\n`);
  } else if (reason) {
    const msg =
      reason === 'hard_timeout' ? 'Worker hard execution limit reached.' : 'Execution canceled.';
    throw Object.assign(new Error(msg), { reason, native: finalized.native });
  }

  if (spawnError) {
    const hint = spawnError.code === 'ENOENT' ? `\n${driver.installHint || ''}` : '';
    throw Object.assign(
      new Error(`failed to launch ${driver.id} (${binary}): ${spawnError.message}${hint}`),
      {
        reason: 'launch_error',
        native: finalized.native,
      }
    );
  }
  if (finalized.streamFailure) {
    throw Object.assign(new Error(finalized.streamFailure), {
      reason: 'target_error',
      diagnosticText: `${stdoutTail}\n${nextStderr}`,
      native: finalized.native,
    });
  }
  if (!finalized.payload) {
    throw buildMissingResultError({
      driver,
      job,
      outcome,
      stdoutTail,
      stderr: nextStderr,
      native: finalized.native,
    });
  }

  return {
    payload: finalized.payload,
    stderr: nextStderr,
    exit: outcome.exit ?? 1,
    observationWarnings: session.snapshot().warnings,
    native: finalized.native,
  };
}

function spawnTargetChild(binary, args, { cwd, env, stdinText, windowsVerbatimArguments = false }) {
  const child = spawn(binary, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: Boolean(windowsVerbatimArguments),
    stdio: [stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (stdinText !== null && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdinText, 'utf8');
  }
  return child;
}

function createStreamLifecycle({ job, driver, session, procTracker, state }) {
  const publish = () => {
    state.lastPublish = Date.now();
    atomicJSON(
      job.progress_file,
      boundSnapshot({ job_id: job.id, target: driver.id, ...session.snapshot() })
    );
  };
  const cleanup = async (initialRows = null) => {
    if (
      !procTracker.getRoot() &&
      state.child?.exitCode === null &&
      state.child.signalCode === null
    ) {
      state.child.kill('SIGTERM');
    }
    let rows = initialRows;
    const table = () => {
      const first = rows;
      rows = null;
      return first || processTable();
    };
    await stopExecution(procTracker.getRoot(), procTracker.getKnown(), table);
    if (state.child?.exitCode === null && state.child.signalCode === null)
      state.child.kill('SIGKILL');
  };
  const stop = (why) => {
    if (why === 'canceled') state.reason = why;
    if (state.stopping) return;
    state.reason = why;
    clearInterval(state.trackingTimer);
    state.stopping = cleanup(procTracker.track());
  };
  const safely = (action) => {
    try {
      action();
    } catch (error) {
      state.streamError ||= error;
      stop('stream_error');
    }
  };
  return { publish, cleanup, stop, abort: () => stop('canceled'), safely };
}

function wireChildOutputPipes({ child, rawFd, session, procTracker, state, publish, safely }) {
  const parser = createParser(
    (event) => {
      if (session.acceptEvent(event) && state.child?.exitCode === null) procTracker.track();
      if (Date.now() - state.lastPublish >= 100) publish();
      else if (!state.publishTimer) {
        state.publishTimer = setTimeout(() => {
          state.publishTimer = null;
          safely(publish);
        }, 100);
      }
    },
    session.warn,
    64 * 1024 * 1024
  );
  child.stdout.on('data', (chunk) =>
    safely(() => {
      fs.writeSync(rawFd, chunk);
      state.stdoutTail = excerpt(state.stdoutTail + chunk.toString('utf8'), 8192, true).text;
      parser.write(chunk);
    })
  );
  child.stderr.on('data', (chunk) =>
    safely(() => {
      process.stderr.write(chunk);
      session.writeStderr(chunk);
      state.stderr = excerpt(state.stderr + chunk.toString('utf8'), 8192, true).text;
    })
  );
  return parser;
}

function createStreamState() {
  return {
    exitCode: null,
    stderr: '',
    stdoutTail: '',
    lastPublish: 0,
    child: null,
    deadline: null,
    publishTimer: null,
    trackingTimer: null,
    stopping: null,
    reason: null,
    spawnError: null,
    streamError: null,
  };
}

function observeChildLifecycle(child, state) {
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      state.spawnError = error;
      resolve({ exit: null, killedSignal: null });
    });
    child.once('exit', (exit, killedSignal) => resolve({ exit, killedSignal }));
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { exited, closed };
}

function startChildTracking(opts, ctx, hardDeadline) {
  const { binary, args, stdinText = null, cwd, env = process.env, update, signal } = opts;
  const { state, procTracker, abort, stop } = ctx;
  state.child = spawnTargetChild(binary, args, {
    cwd,
    env,
    stdinText,
    windowsVerbatimArguments: opts.windowsVerbatimArguments,
  });
  const lifecycle = observeChildLifecycle(state.child, state);
  procTracker.track();
  state.trackingTimer = setInterval(procTracker.track, process.platform === 'win32' ? 5000 : 1000);
  update({
    target_pid: state.child.pid,
    execution_started_at: new Date().toISOString(),
    hard_deadline_at: new Date(hardDeadline).toISOString(),
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  state.deadline = setTimeout(() => stop('hard_timeout'), Math.max(0, hardDeadline - Date.now()));
  return lifecycle;
}

async function finishChildExecution(opts, ctx, { exited, closed, parser }) {
  const { driver, binary, job } = opts;
  const { state, session, procTracker, publish, cleanup, safely } = ctx;
  const outcome = await exited;
  state.exitCode = outcome.exit;
  clearTimeout(state.deadline);
  clearInterval(state.trackingTimer);
  if (!state.stopping) state.stopping = cleanup(procTracker.track());
  await state.stopping;
  await drainChildStreams(state.child, closed, session, driver.displayName);
  safely(() => parser.end());
  const finalized = session.finalize(state.exitCode);
  clearTimeout(state.publishTimer);
  if (isInspectionUnavailable()) {
    session.warn(
      'Process-tree inspection unavailable; ' +
        'verify descendant cleanup from the original unsandboxed context.'
    );
  }
  publish();
  return evaluateFinalizedStream({ ...state, driver, binary, job, session, finalized, outcome });
}

/**
 * Execute a target harness CLI in a detached process group, streaming NDJSON
 * events through `driver.createStreamSession` while tracking descendant PIDs.
 */
export async function runStreaming(opts) {
  const { driver, job, budget, signal, conversation } = opts;
  const hardDeadline = Date.now() + Math.max(0, budget);
  const rawFd = fs.openSync(job.events_file, 'a');
  const session = driver.createStreamSession({ onConversation: conversation });
  const state = createStreamState();
  const procTracker = createDescendantTracker(() => state.child?.pid);
  const life = createStreamLifecycle({ job, driver, session, procTracker, state });
  const ctx = { state, session, procTracker, ...life };

  try {
    life.publish();
    const { exited, closed } = startChildTracking(opts, ctx, hardDeadline);
    const parser = wireChildOutputPipes({ child: state.child, rawFd, ...ctx });
    return await finishChildExecution(opts, ctx, { exited, closed, parser });
  } catch (error) {
    if (!state.stopping && state.child?.pid) await life.cleanup();
    if (!error.native) {
      try {
        error.native = session.finalize(state.exitCode).native;
      } catch {}
    }
    throw error;
  } finally {
    clearInterval(state.trackingTimer);
    clearTimeout(state.deadline);
    clearTimeout(state.publishTimer);
    signal.removeEventListener('abort', life.abort);
    fs.closeSync(rawFd);
  }
}
