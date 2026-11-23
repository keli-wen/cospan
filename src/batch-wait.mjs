import { die, JOB_EXIT_CODES } from './cli-args.mjs';
import { writeSettledJobResponse } from './job-diagnostics.mjs';
import { liveJobStatus, loadState, lookupJob } from './job-store.mjs';
import { bytes, excerpt } from './observation.mjs';
import { readTextRetry } from './state-lock.mjs';

const BATCH_SUMMARY_MAX_BYTES = 8192;

const BATCH_EXIT_SEVERITY = {
  0: 0, // done
  5: 1, // attention
  4: 2, // canceled
  3: 3, // error / crashed
  1: 4, // unknown error
};

export function collectUniqueWaitIds(opts) {
  const raw = [];
  if (opts.id) raw.push(opts.id);
  if (Array.isArray(opts._)) raw.push(...opts._);
  const seen = new Set();
  const ids = [];
  for (const token of raw) {
    const id = String(token || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function computeBatchExitCode(statuses) {
  let worstCode = 0;
  let worstSeverity = -1;
  for (const status of statuses) {
    const code = JOB_EXIT_CODES[status] ?? 1;
    const severity = BATCH_EXIT_SEVERITY[code] ?? 4;
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worstCode = code;
    }
  }
  return worstCode;
}

function readJsonSafe(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(readTextRetry(filePath));
  } catch {
    return null;
  }
}

function computeElapsedSeconds(startedAt, endMs) {
  const startMs = Date.parse(startedAt || '');
  return Number.isFinite(startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;
}

function summarizeBatchJob(job, status) {
  const base = {
    job_id: job.id,
    target: job.target,
    readonly: Boolean(job.readonly),
    status,
    started_at: job.started_at || null,
  };
  if (status === 'running') {
    const progress = readJsonSafe(job.progress_file);
    return {
      ...base,
      elapsed_seconds: computeElapsedSeconds(job.started_at, Date.now()),
      phase: progress?.phase || null,
      last_event_at: progress?.last_event_at || null,
    };
  }
  const final = readJsonSafe(job.result_file ? `${job.result_file}.status.json` : null);
  const finishedAt = job.finished_at || final?.finished_at || null;
  const endMs = Date.parse(finishedAt || '') || Date.now();
  return {
    ...base,
    finished_at: finishedAt,
    elapsed_seconds: computeElapsedSeconds(job.started_at, endMs),
  };
}

function trimIdListForBudget(out, key) {
  while (bytes(out) + 1 > BATCH_SUMMARY_MAX_BYTES && out[key].length > 0) {
    out[key].pop();
    out.truncated = true;
  }
}

export function boundBatchRunningSummary(summary) {
  const out = structuredClone(summary);
  if (bytes(out) + 1 <= BATCH_SUMMARY_MAX_BYTES) return out;

  out.truncated = true;
  if (Array.isArray(out.jobs)) {
    out.jobs = out.jobs.map((j) => ({
      job_id: excerpt(j.job_id || '', 128).text,
      target: excerpt(j.target || '', 32).text,
      status: j.status,
    }));
  }
  if (bytes(out) + 1 <= BATCH_SUMMARY_MAX_BYTES) return out;

  delete out.hint;
  if (Array.isArray(out.jobs)) {
    let omitted = 0;
    while (bytes(out) + 1 > BATCH_SUMMARY_MAX_BYTES && out.jobs.length > 0) {
      out.jobs.pop();
      omitted += 1;
      out.jobs_omitted = omitted;
    }
  }
  if (bytes(out) + 1 <= BATCH_SUMMARY_MAX_BYTES) return out;

  out.completed_count = out.completed_ids.length;
  out.pending_count = out.pending_ids.length;
  trimIdListForBudget(out, 'completed_ids');
  trimIdListForBudget(out, 'pending_ids');
  if (bytes(out) + 1 <= BATCH_SUMMARY_MAX_BYTES) return out;

  return {
    status: 'running',
    completed_ids: [],
    pending_ids: [],
    completed_count: out.completed_count,
    pending_count: out.pending_count,
    truncated: true,
  };
}

export function buildBatchRunningSummary(entries) {
  const completedIds = [];
  const pendingIds = [];
  const jobs = [];
  for (const { job, status } of entries) {
    if (status === 'running') pendingIds.push(job.id);
    else completedIds.push(job.id);
    jobs.push(summarizeBatchJob(job, status));
  }
  return boundBatchRunningSummary({
    status: 'running',
    observed_at: new Date().toISOString(),
    completed_ids: completedIds,
    pending_ids: pendingIds,
    jobs,
    hint:
      `Still waiting on ${pendingIds.length}/${entries.length} job(s). ` +
      'Re-run `cospan wait` with the same IDs (or `cospan observe <id>` for details).',
  });
}

function readBatchEntries(ids, rootsById, defaultRoot, missingMessage) {
  const stateByRoot = new Map();
  const jobsForRoot = (targetRoot) => {
    if (!stateByRoot.has(targetRoot)) stateByRoot.set(targetRoot, loadState(targetRoot).jobs || []);
    return stateByRoot.get(targetRoot);
  };
  return ids.map((id) => {
    const knownRoot = rootsById.get(id);
    let job = knownRoot ? jobsForRoot(knownRoot).find((j) => j.id === id) || null : null;
    if (!job && !knownRoot) {
      const found = lookupJob(id, defaultRoot);
      if (found) {
        rootsById.set(id, found.root);
        job = found.job;
      }
    }
    if (!job) die(missingMessage(id));
    return { id, job, status: liveJobStatus(job) };
  });
}

function writeSettledBatchDeliverables(entries) {
  let prevEndedWithNewline = true;
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      process.stdout.write(prevEndedWithNewline ? '\n---\n\n' : '\n\n---\n\n');
    }
    const { job, status } = entries[i];
    prevEndedWithNewline = writeSettledJobResponse(job, status);
  }
  process.exitCode = computeBatchExitCode(entries.map((e) => e.status));
}

export async function waitForBatchJobs(ids, { root, budget, pollMs = 200 }) {
  const rootsById = new Map();
  const readInitial = () =>
    readBatchEntries(ids, rootsById, root, (id) => `no job "${id}" in this repository`);
  const readActive = () =>
    readBatchEntries(
      ids,
      rootsById,
      root,
      (id) => `job record "${id}" disappeared from state.json`
    );

  let entries = readInitial();
  const start = Date.now();
  while (entries.some((e) => e.status === 'running') && Date.now() - start < budget) {
    await new Promise((r) => setTimeout(r, Math.min(pollMs, budget - (Date.now() - start))));
    entries = readActive();
  }

  if (entries.some((e) => e.status === 'running')) {
    const summary = buildBatchRunningSummary(entries);
    entries = readActive();
    if (entries.some((e) => e.status === 'running')) {
      process.stdout.write(JSON.stringify(summary) + '\n');
      process.exitCode = 2;
      return;
    }
  }

  // Ensure every settled entry reflects fresh state before writing deliverables
  entries = readActive();
  const hasRunning = entries.some((e) => e.status === 'running');
  if (hasRunning) {
    process.stdout.write(JSON.stringify(buildBatchRunningSummary(entries)) + '\n');
    process.exitCode = 2;
    return;
  }
  writeSettledBatchDeliverables(entries);
}
