import fs from 'node:fs';
import { boundSnapshot } from './observation.mjs';
import { getDriver } from './drivers/index.mjs';
import {
  DEFAULT_SEND_TIMEOUT,
  durationToMs,
  JOB_EXIT_CODES,
  MAX_BACKGROUND_MS,
} from './cli-args.mjs';
import { findJob, liveJobStatus, repoRoot } from './job-store.mjs';
import { readTextRetry } from './state-lock.mjs';

export const CRASH_SANDBOX_HINT =
  'The worker pid is not visible from this process. If the job was started from an ' +
  'unsandboxed/MCP context, rerun wait/status/result from the same context before ' +
  'treating it as crashed.';

export function isTimeoutReason(reason) {
  return reason === 'response_timeout' || reason === 'hard_timeout';
}

export function readTail(file, limit = 8192) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function timeoutRecovery(job) {
  const previous = durationToMs(job.timeout) || durationToMs(DEFAULT_SEND_TIMEOUT);
  const next = Math.min(previous * 2, MAX_BACKGROUND_MS);
  const suggested = next % 60000 === 0 ? `${next / 60000}m` : `${Math.round(next / 1000)}s`;
  const hasConv = Boolean(job.conversation_id);
  return {
    inspect: 'git status --short; git diff; git diff --cached',
    requires_user_confirmation: true,
    suggested_timeout: suggested,
    at_timeout_ceiling: next <= previous,
    continue: hasConv
      ? `cospan continue --id ${job.id} --timeout ${suggested} ` +
        '--prompt "Continue after inspecting partial workspace changes"'
      : null,
    restart: `cospan restart ${job.id} --timeout ${suggested}`,
    note: hasConv
      ? `Ask the user whether to continue with a larger timeout (suggested: ${suggested}) ` +
        'or inspect the workspace first.'
      : 'No conversation ID is available yet. ' +
        'Inspect workspace changes and ask the user before restarting.',
  };
}

function computeLogState(logBytes) {
  if (logBytes === null) return 'missing';
  return logBytes === 0 ? 'empty' : 'present';
}

function buildRecoveryHint(job) {
  if (isTimeoutReason(job.reason)) return timeoutRecovery(job);
  return {
    inspect: 'git status --short; git diff',
    continue: job.conversation_id
      ? `cospan continue --id ${job.id} ` +
        '--prompt "Continue after inspecting partial workspace changes"'
      : null,
    restart: `cospan restart ${job.id}`,
  };
}

export function diagnosticPacket(job) {
  let logBytes = null;
  try {
    logBytes = fs.statSync(job.log_file).size;
  } catch {}
  return {
    job_id: job.id,
    target: job.target,
    readonly: Boolean(job.readonly),
    cwd: job.cwd || process.cwd(),
    status: liveJobStatus(job),
    started_at: job.started_at,
    worker_started_at: job.worker_started_at || null,
    finished_at: job.finished_at || null,
    pid: job.pid,
    target_pid: job.target_pid || null,
    log_bytes: logBytes,
    log_state: computeLogState(logBytes),
    result_exists: fs.existsSync(job.result_file),
    log_file: job.log_file,
    events_file: job.events_file || null,
    conversation_id: job.conversation_id || null,
    model: job.model || null,
    effort: job.effort || null,
    ...(job.native ? { native: job.native } : {}),
    recovery: buildRecoveryHint(job),
  };
}

export function readObservation(job) {
  let snapshot = {
    recent_activities: [],
    latest_text: null,
    last_event_at: null,
    warnings: ['No activity record is available for this job yet.'],
  };
  try {
    snapshot = JSON.parse(readTextRetry(job.progress_file));
  } catch {}
  return boundSnapshot({
    ...snapshot,
    job_id: job.id,
    target: job.target,
    readonly: Boolean(job.readonly),
    status: liveJobStatus(job),
    started_at: job.started_at,
    observed_at: new Date().toISOString(),
    elapsed_seconds: Math.max(0, Math.round((Date.now() - Date.parse(job.started_at)) / 1000)),
    details: {
      raw_output: job.events_file || null,
      diagnostics: job.log_file,
      result: job.result_file,
    },
  });
}

function defaultFailureReason(status) {
  if (status === 'crashed') return 'worker_crashed';
  if (status === 'canceled') return 'canceled';
  return 'job_error';
}

function attachNonDoneObservationFields(snapshot, job, final, status) {
  const reason = job.reason || final.reason || defaultFailureReason(status);
  const packet = diagnosticPacket({ ...job, ...final, reason });
  Object.assign(snapshot, {
    reason,
    summary:
      status === 'attention'
        ? 'Timeout with a resumable conversation; ask the user whether to continue.'
        : `Job ${status}; inspect the retained report and diagnostics.`,
    conversation_id: job.conversation_id || null,
    model: job.model || null,
    effort: job.effort || null,
    log_state: packet.log_state,
    log_bytes: packet.log_bytes,
    details: {
      diagnostics: job.log_file,
      raw_output: job.events_file || null,
      snapshot: job.progress_file || null,
    },
    recovery: packet.recovery,
  });
  if (status === 'crashed') snapshot.liveness_note = CRASH_SANDBOX_HINT;
}

export function readTerminalObservation(job, status) {
  let final = {};
  try {
    final = JSON.parse(readTextRetry(job.result_file + '.status.json'));
  } catch {}
  const finishedAt = job.finished_at || final.finished_at || null;
  const native = final.native || job.native;
  const endMs = Date.parse(finishedAt) || Date.now();
  const snapshot = {
    job_id: job.id,
    target: job.target,
    readonly: Boolean(job.readonly),
    status,
    started_at: job.started_at,
    finished_at: finishedAt,
    observed_at: new Date().toISOString(),
    elapsed_seconds: Math.max(0, Math.round((endMs - Date.parse(job.started_at)) / 1000)),
    result_file: job.result_file,
    result_available: fs.existsSync(job.result_file),
    ...(native ? { native } : {}),
    collection: {
      command: `cospan result ${job.id}`,
      instruction:
        'Collect the existing wait session if one is pending; ' +
        'otherwise use `result` for the full output.',
    },
  };
  if (status !== 'done') {
    attachNonDoneObservationFields(snapshot, job, final, status);
  }
  return boundSnapshot(snapshot);
}

function writeStoredJobDeliverable(job, status) {
  const accessLabel = job.readonly ? 'readonly' : 'writable';
  let resumeCmd = null;
  try {
    resumeCmd = getDriver(job.target).humanResumeCommand?.(job.conversation_id) || null;
  } catch {}
  process.stdout.write(
    `# Job ${job.id} (target=${job.target}, ${accessLabel}, status=${status}` +
      (job.conversation_id ? `, session=${job.conversation_id}` : '') +
      `)\n` +
      (resumeCmd ? `<!-- interactive_resume: ${resumeCmd} -->\n` : '') +
      `\n`
  );
  process.stdout.write(readTextRetry(job.result_file));
}

function writeMissingResultDiagnostics(job, status) {
  process.stdout.write(
    `Job ${job.id} (${job.target}) finished with status ${status} and no stored result. ` +
      `Log: ${job.log_file}\n`
  );
  process.stdout.write(JSON.stringify(diagnosticPacket(job), null, 2) + '\n');
  if (status === 'crashed') process.stdout.write(`\n${CRASH_SANDBOX_HINT}\n`);
}

export function renderJobResponse(initial, { observeOnly = false } = {}) {
  const root = repoRoot();
  let job = findJob(initial.id, root);
  let status = liveJobStatus(job);
  if (status === 'running') {
    const snapshot = readObservation(job);
    job = findJob(job.id, root);
    status = liveJobStatus(job);
    if (status === 'running') {
      process.stdout.write(JSON.stringify(snapshot) + '\n');
      process.exitCode = 2;
      return;
    }
  }
  if (observeOnly) {
    process.stdout.write(JSON.stringify(readTerminalObservation(job, status)) + '\n');
    process.exitCode = JOB_EXIT_CODES[status] ?? 1;
    return;
  }
  if (job.status === 'running') {
    try {
      job = { ...job, ...JSON.parse(readTextRetry(job.result_file + '.status.json')) };
    } catch {}
  }
  if (fs.existsSync(job.result_file)) writeStoredJobDeliverable(job, status);
  else writeMissingResultDiagnostics(job, status);
  if (status === 'done' && job.warnings) {
    process.stderr.write(
      `Job diagnostics (tail, up to 8192 bytes). Full log: ${job.log_file}\n` +
        `${readTail(job.log_file)}\n`
    );
  }
  process.exitCode = JOB_EXIT_CODES[status] ?? 1;
}
