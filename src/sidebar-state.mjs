import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestSafeJobCancellation, terminateVerifiedWorker } from './commands/lifecycle.mjs';
import { diagnosticPacket, readTail } from './job-diagnostics.mjs';
import { liveJobStatus, loadState, pidAlive, repoRoot } from './job-store.mjs';
import { excerpt } from './observation.mjs';
import { resolveFamilyTrajectories } from './repo-family.mjs';
import { readTextRetry } from './state-lock.mjs';

const PROMPT_PREVIEW_BYTES = 260;
const PROMPT_DETAIL_BYTES = 4096;
const LATEST_TEXT_PREVIEW_BYTES = 320;
const RESULT_MAX_BYTES = 16384;
const LOG_TAIL_MAX_BYTES = 4096;
const MAX_SPEC_CACHE_ENTRIES = 500;
const specMetaCache = new Map();

export function resolveBoardWorkspace(workspaceInput) {
  let candidate = typeof workspaceInput === 'string' ? workspaceInput.trim() : '';
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      candidate = decodeURIComponent(candidate.replace(/^file:\/\//i, ''));
    }
  }
  if (!candidate) return repoRoot(process.cwd());
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      candidate = path.dirname(candidate);
    }
  } catch {}
  return repoRoot(candidate);
}

function readJsonSafe(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(readTextRetry(filePath));
  } catch {
    return null;
  }
}

function readHeadBounded(filePath, byteLimit) {
  if (!filePath) return { text: '', truncated: false };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { text: '', truncated: false };
    const readCap = Math.min(size, byteLimit * 4);
    const buf = Buffer.alloc(readCap);
    fs.readSync(fd, buf, 0, readCap, 0);
    const ex = excerpt(buf.toString('utf8'), byteLimit);
    return { text: ex.text, truncated: ex.truncated || size > readCap };
  } catch {
    return { text: '', truncated: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function extractProgressText(progress) {
  const raw = progress?.latest_text;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.text === 'string') return raw.text;
  return '';
}

function extractCleanTaskPrompt(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  if (!text) return '';
  const taskTag = '\n\n[Task]\n';
  const taskIdx = text.indexOf(taskTag);
  if (taskIdx !== -1 && text.startsWith('[cospan delegation context]')) {
    return text.slice(taskIdx + taskTag.length).trim();
  }
  const followPrefix = /^\[cospan follow-up \|[^\]]*\]\s*/u;
  if (followPrefix.test(text)) {
    return text.replace(followPrefix, '').trim();
  }
  const mdTaskIdx = text.indexOf('## Task\n');
  if (mdTaskIdx !== -1 && mdTaskIdx < 600) {
    return text.slice(mdTaskIdx + '## Task\n'.length).trim();
  }
  return text;
}

function normalizeWhitespacePreview(rawPrompt, byteLimit) {
  const cleaned = extractCleanTaskPrompt(rawPrompt);
  const lines = cleaned
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^#+\s*(?:context|background|task|goal|summary|背景|任务|目标)\s*$/iu.test(line)) {
      continue;
    }
    const plain = line.replace(/^#+\s*/u, '').trim();
    if (plain.length > 1) return excerpt(plain, byteLimit).text;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  return collapsed ? excerpt(collapsed, byteLimit).text : '';
}

function computeElapsedMs(startedAt, finishedAt, status) {
  const startMs = Date.parse(startedAt || '');
  if (!Number.isFinite(startMs)) return 0;
  const endMs = status === 'running' ? Date.now() : Date.parse(finishedAt || '') || Date.now();
  return Math.max(0, endMs - startMs);
}

function enrichTerminalFields(job, status) {
  if (status === 'running') {
    return { finishedAt: job.finished_at || null, reason: job.reason || null };
  }
  const final = job.result_file ? readJsonSafe(`${job.result_file}.status.json`) : null;
  return {
    finishedAt: job.finished_at || final?.finished_at || null,
    reason: job.reason || final?.reason || null,
  };
}

function extractBoardProgressSummary(progress) {
  const touchedFiles = Array.isArray(progress?.touched_files)
    ? progress.touched_files.slice(0, 8).map((f) => excerpt(String(f), 160).text)
    : [];
  const rawLatest = extractProgressText(progress);
  return {
    phase: progress?.phase || null,
    touched_files: touchedFiles,
    recent_activities: Array.isArray(progress?.recent_activities)
      ? progress.recent_activities.slice(-5)
      : [],
    latest_text: rawLatest ? excerpt(rawLatest, LATEST_TEXT_PREVIEW_BYTES).text : '',
    last_event_at: progress?.last_event_at || null,
  };
}

function readCachedSpecMeta(specFile) {
  if (!specFile) return null;
  if (specMetaCache.has(specFile)) return specMetaCache.get(specFile);
  const spec = readJsonSafe(specFile);
  if (!spec) return null;
  const meta = {
    caller_host: spec.caller_host || null,
    caller_session_id: spec.caller_session_id || null,
    prompt_preview: normalizeWhitespacePreview(spec.prompt || '', PROMPT_PREVIEW_BYTES),
  };
  if (specMetaCache.size >= MAX_SPEC_CACHE_ENTRIES) specMetaCache.clear();
  specMetaCache.set(specFile, meta);
  return meta;
}

function loadTrajectoryStateDir(trajDir) {
  const parsed = readJsonSafe(path.join(trajDir, 'state.json'));
  return parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

function findJobInFamily(workspace, jobId) {
  for (const entry of resolveFamilyTrajectories(workspace)) {
    const job = loadTrajectoryStateDir(entry.trajectory_dir).find((j) => j.id === jobId);
    if (job) return { job, entry };
  }
  return null;
}

function extractCallerSummary(job, specMeta, normalizedCallerSessionId) {
  const callerHost = job.caller_host || specMeta?.caller_host || null;
  const callerSession = job.caller_session_id || specMeta?.caller_session_id || null;
  return {
    caller_host: callerHost,
    caller_session_id: callerSession,
    caller_match: Boolean(normalizedCallerSessionId && callerSession === normalizedCallerSessionId),
  };
}

function resolveWorktreeName(familyEntry) {
  return familyEntry && !familyEntry.is_primary ? familyEntry.worktree_name : null;
}

function buildBoardJobItem(job, normalizedCallerSessionId, familyEntry = null) {
  const status = liveJobStatus(job);
  const specMeta = readCachedSpecMeta(job.spec_file);
  const progress = readJsonSafe(job.progress_file);
  const { finishedAt, reason } = enrichTerminalFields(job, status);

  return {
    id: job.id,
    target: job.target,
    status,
    model: job.model || null,
    effort: job.effort || null,
    readonly: Boolean(job.readonly),
    permissions: job.permissions || 'unrestricted',
    started_at: job.started_at || null,
    finished_at: finishedAt,
    elapsed_ms: computeElapsedMs(job.started_at, finishedAt, status),
    ...extractCallerSummary(job, specMeta, normalizedCallerSessionId),
    prompt_preview: specMeta?.prompt_preview || '',
    ...extractBoardProgressSummary(progress),
    conversation_id: job.conversation_id || null,
    continued_from: job.continued_from || null,
    restarted_from: job.restarted_from || null,
    workspace_root: familyEntry?.workspace_root || job.cwd || null,
    worktree_name: resolveWorktreeName(familyEntry),
    reason,
    has_result: Boolean(job.result_file && fs.existsSync(job.result_file)),
  };
}

function compareBoardJobs(a, b) {
  const aRank = a.status === 'running' ? 0 : 1;
  const bRank = b.status === 'running' ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  const aTime = Date.parse(a.started_at || '') || 0;
  const bTime = Date.parse(b.started_at || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(b.id || '').localeCompare(String(a.id || ''));
}

export function listWorkspaceBoard(workspaceInput, { callerSessionId = null } = {}) {
  const workspace = resolveBoardWorkspace(workspaceInput);
  const normalizedCaller =
    typeof callerSessionId === 'string' && callerSessionId.trim() ? callerSessionId.trim() : null;
  const seen = new Set();
  const jobs = [];
  for (const entry of resolveFamilyTrajectories(workspace)) {
    for (const job of loadTrajectoryStateDir(entry.trajectory_dir)) {
      if (!job?.id || seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(buildBoardJobItem(job, normalizedCaller, entry));
    }
  }
  jobs.sort(compareBoardJobs);
  return {
    workspace,
    caller_session_id: normalizedCaller,
    updated_at: new Date().toISOString(),
    jobs,
  };
}

function sanitizeProgressDetail(progress) {
  if (!progress || typeof progress !== 'object') return null;
  const latest = extractProgressText(progress);
  return {
    phase: progress.phase || null,
    last_event_at: progress.last_event_at || null,
    touched_files: Array.isArray(progress.touched_files)
      ? progress.touched_files.slice(0, 25).map((f) => excerpt(String(f), 200).text)
      : [],
    recent_activities: Array.isArray(progress.recent_activities)
      ? progress.recent_activities.slice(-5)
      : [],
    latest_text: latest ? excerpt(latest, 2048, true).text : '',
    warnings: Array.isArray(progress.warnings) ? progress.warnings.slice(0, 5) : [],
  };
}

export function readBoardJobDetail(workspaceInput, jobId) {
  const workspace = resolveBoardWorkspace(workspaceInput);
  const targetId = typeof jobId === 'string' ? jobId.trim() : '';
  if (!targetId) {
    return { ok: false, workspace, job_id: null, error: 'Job ID is required.' };
  }
  const found = findJobInFamily(workspace, targetId);
  if (!found) {
    return {
      ok: false,
      workspace,
      job_id: targetId,
      error: `No job "${targetId}" recorded in this workspace.`,
    };
  }
  const { job: rawJob, entry } = found;
  const item = buildBoardJobItem(rawJob, null, entry);
  const spec = readJsonSafe(rawJob.spec_file);
  const progress = sanitizeProgressDetail(readJsonSafe(rawJob.progress_file));
  const promptEx = excerpt(extractCleanTaskPrompt(spec?.prompt || ''), PROMPT_DETAIL_BYTES);
  const resultEx = readHeadBounded(rawJob.result_file, RESULT_MAX_BYTES);
  const enrichedRaw = { ...rawJob, finished_at: item.finished_at, reason: item.reason };

  return {
    ok: true,
    workspace,
    job_id: item.id,
    job: item,
    prompt: promptEx.text,
    prompt_truncated: promptEx.truncated,
    diagnostics: diagnosticPacket(enrichedRaw),
    progress,
    result_text: resultEx.text,
    result_truncated: resultEx.truncated,
    log_tail: readTail(rawJob.log_file, LOG_TAIL_MAX_BYTES),
  };
}

async function awaitJobTermination(workspace, targetId, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    const current = (loadState(workspace).jobs || []).find((j) => j.id === targetId);
    const status = current ? liveJobStatus(current) : 'canceled';
    if (status !== 'running' && !pidAlive(current?.pid)) {
      const msg =
        status === 'canceled' ? `Canceled job ${targetId}.` : `Job ${targetId} is ${status}.`;
      return { ok: true, job_id: targetId, status, message: msg };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    ok: true,
    job_id: targetId,
    status: 'running',
    cancel_requested: true,
    message: `Cancellation requested for job ${targetId}.`,
  };
}

const DEFAULT_CANCEL_WAIT_MS = process.platform === 'win32' ? 10000 : 2500;

export async function cancelBoardJob(
  workspaceInput,
  jobId,
  { waitMs = DEFAULT_CANCEL_WAIT_MS } = {}
) {
  const workspace = resolveBoardWorkspace(workspaceInput);
  const targetId = typeof jobId === 'string' ? jobId.trim() : '';
  if (!targetId) {
    return { ok: false, job_id: null, status: null, message: 'Job ID is required.' };
  }
  const found = findJobInFamily(workspace, targetId);
  const targetWorkspace = found?.entry?.workspace_root || workspace;
  let reqResult;
  try {
    reqResult = requestSafeJobCancellation(targetId, targetWorkspace);
  } catch (err) {
    return {
      ok: false,
      job_id: targetId,
      status: null,
      message: err?.message || 'Failed to request job cancellation.',
    };
  }
  if (!reqResult.ok) {
    return {
      ok: false,
      job_id: targetId,
      status: reqResult.status || null,
      message: reqResult.error || 'Unable to cancel job.',
    };
  }
  if (!reqResult.changed) {
    return {
      ok: true,
      job_id: targetId,
      status: reqResult.status,
      message: `Job ${targetId} is not running (status: ${reqResult.status}).`,
    };
  }
  terminateVerifiedWorker(reqResult.job);
  return awaitJobTermination(targetWorkspace, targetId, waitMs);
}
