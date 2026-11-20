import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { computePorcelainDelta, gitBranch, gitPorcelain, wrapPrompt } from './envelope.mjs';
import { getDriver } from './drivers/index.mjs';
import { COSPAN_BIN_PATH } from './installer-templates.mjs';
import { processIdentity, runStreaming } from './stream-worker.mjs';
import {
  buildSpawnCommand,
  loadEffectiveConfig,
  resolveEffectivePermissions,
  resolveJobModelAndEffort,
  resolveTargetBinary,
} from './targets.mjs';
import { die, durationToMs, JOB_EXIT_CODES, setWorkerMode } from './cli-args.mjs';
import { diagnosticPacket, isTimeoutReason, readObservation } from './job-diagnostics.mjs';
import {
  finishJob,
  loadState,
  makeJobId,
  repoRoot,
  updateJob,
  updateState,
  workspaceStateDir,
} from './job-store.mjs';

function buildJobArtifactPaths(jobsDir, id) {
  return {
    spec_file: path.join(jobsDir, `${id}.spec.json`),
    events_file: path.join(jobsDir, `${id}.events.jsonl`),
    progress_file: path.join(jobsDir, `${id}.progress.json`),
    result_file: path.join(jobsDir, `${id}.result.md`),
    log_file: path.join(jobsDir, `${id}.log`),
  };
}

function spawnDetachedWorkerProcess(id, cwd, logFile) {
  const logFd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [COSPAN_BIN_PATH, '_worker', id], {
      cwd,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(logFd);
  }
}

function buildInitialJobRecord(p) {
  return {
    id: p.id,
    target: p.driverId,
    ...p.baseMeta,
    status: 'running',
    pid: p.pid,
    worker_identity: null,
    started_at: new Date().toISOString(),
    conversation_id: p.conversationId,
    ...(p.continuedFrom ? { continued_from: p.continuedFrom } : {}),
    ...(p.restartedFrom ? { restarted_from: p.restartedFrom } : {}),
    ...p.paths,
  };
}

function resolveCallerAttribution(callerHost, callerSessionId) {
  return {
    caller_host: callerHost || process.env.COSPAN_CALLER_HOST || null,
    caller_session_id:
      callerSessionId ||
      process.env.COSPAN_CALLER_SESSION_ID ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      null,
  };
}

export function launchDetachedJob({
  target,
  prompt,
  readonly,
  permissions = null,
  explicitConfigPath = null,
  raw,
  model,
  effort,
  timeout,
  prior = null,
  conversationId = null,
  continuedFrom = null,
  restartedFrom = null,
  callerHost = null,
  callerSessionId = null,
  cwd = process.cwd(),
}) {
  const driver = getDriver(target);
  const binary = resolveTargetBinary(driver.id);
  if (!binary) {
    const hint = driver.installHint || '';
    die(`target CLI "${driver.id}" is not installed or not found on PATH.\n${hint}`);
  }
  const root = repoRoot(cwd);
  const { config } = loadEffectiveConfig({ workspaceRoot: root, explicitConfigPath });
  const effectivePermissions = permissions || resolveEffectivePermissions(config, driver.id);
  const resolvedCfg = resolveJobModelAndEffort({ driver, model, effort, config, prior });
  const id = makeJobId(driver.id);
  const paths = buildJobArtifactPaths(path.join(workspaceStateDir(root), 'jobs'), id);

  const baseMeta = {
    readonly: Boolean(readonly),
    permissions: effectivePermissions,
    raw: Boolean(raw),
    model: resolvedCfg.model,
    effort: resolvedCfg.effort,
    model_inherit: resolvedCfg.model === null,
    effort_inherit: driver.id !== 'agy' && resolvedCfg.effort === null,
    timeout,
    cwd,
    ...resolveCallerAttribution(callerHost, callerSessionId),
  };
  const spec = {
    id,
    target: driver.id,
    binary,
    prompt,
    ...baseMeta,
    conversation_id: conversationId,
    continued_from: continuedFrom,
    restarted_from: restartedFrom,
    root,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(paths.spec_file, JSON.stringify(spec, null, 2) + '\n');

  const child = spawnDetachedWorkerProcess(id, cwd, paths.log_file);
  const record = buildInitialJobRecord({
    id,
    driverId: driver.id,
    baseMeta,
    pid: child.pid,
    conversationId,
    continuedFrom,
    restartedFrom,
    paths,
  });

  updateState((state) => {
    state.jobs.push(record);
  }, root);

  return record;
}

function appendWorkspaceDeltaReport(baseDeliverable, spec, delta, initialWarnings) {
  let deliverable = baseDeliverable;
  let hasWarnings = initialWarnings;
  if (spec.readonly && delta.length > 0) {
    hasWarnings = true;
    deliverable +=
      '\n\n---\n[cospan warning] Job ran with --readonly, ' +
      'but working-tree changes were detected during execution:\n' +
      delta.map((d) => `- ${d}`).join('\n');
  } else if (!spec.readonly && !spec.raw && delta.length > 0) {
    deliverable +=
      `\n\n---\n[cospan workspace delta]\n` +
      delta
        .slice(0, 50)
        .map((d) => `- ${d}`)
        .join('\n') +
      (delta.length > 50 ? `\n- ... (${delta.length - 50} more)` : '');
  }
  return { deliverable, hasWarnings };
}

function classifyFailedStatus(job, reason) {
  if (job.status === 'canceled' || reason === 'canceled') return 'canceled';
  if (isTimeoutReason(reason) && job.conversation_id) return 'attention';
  return 'error';
}

function recordWorkerFailure(jobId, error, root) {
  const existing = loadState(root).jobs?.find((j) => j.id === jobId);
  if (!existing) throw error;
  const reason = existing.cancel_requested_at ? 'canceled' : error.reason || 'target_error';
  const status = classifyFailedStatus(existing, reason);
  const job = finishJob(
    jobId,
    (completed) => {
      const report = {
        ...diagnosticPacket(completed),
        result_exists: true,
        reason: completed.reason,
        last_snapshot: readObservation(completed),
      };
      const heading = completed.status === 'attention' ? 'Job needs attention' : 'Job failed';
      const detail = completed.reason === 'canceled' ? 'Execution canceled.' : error.message;
      return `${heading}:\n${detail}\n\n${JSON.stringify(report, null, 2)}\n`;
    },
    (current) => ({
      ...(current.cancel_requested_at
        ? { status: 'canceled', reason: 'canceled' }
        : { status, reason }),
      ...(error.native ? { native: error.native } : {}),
    }),
    root
  );
  process.exitCode = JOB_EXIT_CODES[job.status] ?? 1;
}

function finalizeCompletedWorkerJob({
  jobId,
  spec,
  driver,
  started,
  beforePorcelain,
  runResult,
  root,
}) {
  const delta = computePorcelainDelta(beforePorcelain, gitPorcelain(spec.cwd));
  const { deliverable, hasWarnings } = appendWorkspaceDeltaReport(
    (runResult.payload?.response || '').trimEnd(),
    spec,
    delta,
    Boolean(runResult.observationWarnings?.length)
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const effortTag = spec.effort ? ` effort=${spec.effort}` : '';
  const permTag = spec.permissions || 'unrestricted';
  const sessionTag = runResult.payload?.conversation_id || 'none';
  process.stderr.write(
    `[cospan] target=${driver.id} model=${spec.model || 'default'}${effortTag} ` +
      `permissions=${permTag} duration=${elapsed}s session=${sessionTag}\n`
  );

  const job = finishJob(
    jobId,
    deliverable + '\n',
    {
      status: 'done',
      warnings: hasWarnings,
      native: runResult.native,
      ...(runResult.payload?.usage ? { usage: runResult.payload.usage } : {}),
    },
    root
  );
  if (job.status === 'done' && !job.warnings && job.progress_file) {
    try {
      fs.unlinkSync(job.progress_file);
    } catch {}
  }
}

function rememberWorkerSession(jobId, driverId, convId, root) {
  updateState((state) => {
    const j = state.jobs.find((x) => x.id === jobId);
    if (j) j.conversation_id = convId;
    state.sessions[jobId] = {
      target: driverId,
      conversation_id: convId,
      updated_at: new Date().toISOString(),
    };
  }, root);
}

async function waitForJobRecord(jobId, root, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const readRecord = () => (loadState(root).jobs || []).find((j) => j.id === jobId) || null;
  let job = readRecord();
  while (!job && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    job = readRecord();
  }
  if (!job) throw new Error(`Worker could not find job "${jobId}" in state.`);
  return job;
}

function publishWorkerStartup(jobId, root) {
  const identity = processIdentity(process.pid);
  updateJob(
    jobId,
    { pid: process.pid, worker_identity: identity, worker_started_at: new Date().toISOString() },
    root
  );
  process.stderr.write(`[cospan] worker started ${jobId} pid=${process.pid}\n`);
}

export async function cmdWorker(jobId) {
  setWorkerMode(true);
  const started = Date.now();
  const root = repoRoot();
  const job = await waitForJobRecord(jobId, root);
  const spec = JSON.parse(fs.readFileSync(job.spec_file, 'utf8'));
  const driver = getDriver(spec.target);
  const controller = new AbortController();

  const checkCancel = () => {
    if (fs.existsSync(job.spec_file + '.cancel')) controller.abort();
  };
  const onSignal = () => controller.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const cancelTimer = setInterval(checkCancel, 100);

  publishWorkerStartup(jobId, root);

  try {
    checkCancel();
    if (controller.signal.aborted)
      throw Object.assign(new Error('Execution canceled.'), { reason: 'canceled' });

    const beforePorcelain = gitPorcelain(spec.cwd);
    const wrappedPrompt = wrapPrompt({
      prompt: spec.prompt,
      cwd: spec.cwd,
      branch: gitBranch(spec.cwd),
      readonly: spec.readonly,
      preExistingPorcelain: beforePorcelain,
      isContinuation: Boolean(spec.conversation_id),
      raw: spec.raw,
    });
    const inv = driver.buildInvocation({
      kind: 'send',
      prompt: wrappedPrompt,
      model: spec.model,
      effort: spec.effort,
      timeout: spec.timeout,
      workspace: spec.root,
      readonly: spec.readonly,
      permissions: spec.permissions || 'unrestricted',
      conversationId: spec.conversation_id,
    });
    const spawnCmd = buildSpawnCommand(spec.binary, inv.args);
    const rememberSession = (convId) => rememberWorkerSession(jobId, driver.id, convId, root);

    const runResult = await runStreaming({
      driver,
      binary: spawnCmd.cmd,
      args: spawnCmd.args,
      windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
      stdinText: inv.stdinText,
      cwd: inv.cwd || spec.cwd,
      job,
      budget: durationToMs(spec.timeout),
      signal: controller.signal,
      update: (fields) => updateJob(jobId, fields, root),
      conversation: rememberSession,
    });
    if (runResult.payload?.conversation_id) rememberSession(runResult.payload.conversation_id);
    if (controller.signal.aborted) {
      throw Object.assign(new Error('Execution canceled.'), {
        reason: 'canceled',
        native: runResult.native,
      });
    }
    finalizeCompletedWorkerJob({ jobId, spec, driver, started, beforePorcelain, runResult, root });
  } catch (error) {
    recordWorkerFailure(jobId, error, root);
  } finally {
    clearInterval(cancelTimer);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}
