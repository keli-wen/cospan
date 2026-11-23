import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceTrajectoryDir } from './config.mjs';
import { sh } from './envelope.mjs';
import { registerRepoTrajectory, resolveFamilyTrajectories } from './repo-family.mjs';
import { readTextRetry, replaceFile, withStateLock } from './state-lock.mjs';
import { atomicJSON } from './stream-worker.mjs';
import { die, MAX_RETAINED_JOBS } from './cli-args.mjs';

const TERMINAL_STATUSES = new Set(['done', 'canceled', 'error', 'attention']);
const repoRootCache = new Map();

export function repoRoot(cwd = process.cwd()) {
  if (repoRootCache.has(cwd)) return repoRootCache.get(cwd);
  const r = sh('git', ['rev-parse', '--show-toplevel'], { cwd });
  const root = r.code === 0 && r.out ? path.normalize(r.out) : path.resolve(cwd);
  repoRootCache.set(cwd, root);
  return root;
}

/**
 * Out-of-workspace trajectory & state directory (`~/.cospan/trajectories/<slug>-<sha256_16>/`).
 * Keeps user repositories 100% clean while preserving state and raw delegation trajectories.
 */
export function workspaceStateDir(root = repoRoot()) {
  const dir = workspaceTrajectoryDir(root);
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  return dir;
}

function stateFilePath(root = repoRoot()) {
  return path.join(workspaceStateDir(root), 'state.json');
}

function lockDirPath(root = repoRoot()) {
  return path.join(workspaceStateDir(root), 'state.lock');
}

export function loadState(root = repoRoot()) {
  const file = stateFilePath(root);
  let raw;
  try {
    raw = readTextRetry(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { jobs: [], sessions: {} };
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid cospan state file: ${file}`);
  }
  return parsed;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function liveJobStatus(job) {
  if (TERMINAL_STATUSES.has(job.status)) return job.status;
  if (job.result_file) {
    try {
      const final = JSON.parse(readTextRetry(job.result_file + '.status.json'));
      if (TERMINAL_STATUSES.has(final.status)) return final.status;
    } catch {}
  }
  if (pidAlive(job.pid)) return 'running';
  return !job.spec_file && fs.existsSync(job.result_file) ? 'done' : 'crashed';
}

export function refreshJobs(state) {
  for (const job of state.jobs || []) job.status = liveJobStatus(job);
}

function unlinkJobArtifacts(old) {
  const artifacts = [
    old.spec_file,
    old.spec_file ? `${old.spec_file}.cancel` : null,
    old.events_file,
    old.progress_file,
    old.result_file,
    old.result_file ? `${old.result_file}.status.json` : null,
    old.log_file,
  ];
  for (const f of artifacts) {
    if (!f) continue;
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

function pruneOldJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length <= MAX_RETAINED_JOBS) return jobs || [];
  const evictable = [];
  for (let i = 0; i < jobs.length - MAX_RETAINED_JOBS; i++) {
    if (liveJobStatus(jobs[i]) !== 'running') evictable.push(jobs[i]);
  }
  const evictedIds = new Set(evictable.map((j) => j.id));
  for (const old of evictable) unlinkJobArtifacts(old);
  return jobs.filter((j) => !evictedIds.has(j.id));
}

export function updateState(mutator, root = repoRoot()) {
  const lock = lockDirPath(root);
  const file = stateFilePath(root);
  return withStateLock(lock, () => {
    const state = loadState(root);
    state.jobs ||= [];
    state.sessions ||= {};
    const result = mutator(state);
    state.jobs = pruneOldJobs(state.jobs);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    replaceFile(tmp, file);
    try {
      registerRepoTrajectory(root);
    } catch {}
    return result;
  });
}

export function makeJobId(target) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(2, 14);
  return `${target}-${stamp}-${randomUUID().slice(0, 6)}`;
}

function loadTrajectoryJobs(trajDir) {
  try {
    const parsed = JSON.parse(readTextRetry(path.join(trajDir, 'state.json')));
    return parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export function lookupJob(id, root = repoRoot()) {
  const localJobs = loadState(root).jobs || [];
  if (!id) {
    const latest = localJobs.at(-1) || null;
    return latest ? { job: latest, root } : null;
  }
  const localJob = localJobs.find((j) => j.id === id);
  if (localJob) return { job: localJob, root };
  for (const entry of resolveFamilyTrajectories(root)) {
    if (entry.is_primary) continue;
    const siblingJob = loadTrajectoryJobs(entry.trajectory_dir).find((j) => j.id === id);
    if (siblingJob) return { job: siblingJob, root: entry.workspace_root };
  }
  return null;
}

export function resolveJob(id, root = repoRoot()) {
  const found = lookupJob(id, root);
  if (!found) {
    die(
      id
        ? `no job "${id}" recorded in this repository`
        : 'no cospan jobs recorded in this repository'
    );
  }
  return found;
}

export function findJob(id, root = repoRoot()) {
  return resolveJob(id, root).job;
}

export function updateJob(jobId, fields, root) {
  return updateState((state) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) Object.assign(job, typeof fields === 'function' ? fields(job) : fields);
    return job;
  }, root);
}

export function finishJob(jobId, bodyOrBuilder, fieldsOrBuilder, root) {
  const current = findJob(jobId, root);
  const finishedAt = new Date().toISOString();
  const extra = typeof fieldsOrBuilder === 'function' ? fieldsOrBuilder(current) : fieldsOrBuilder;
  const preview = { ...current, ...extra, finished_at: finishedAt };
  const body = typeof bodyOrBuilder === 'function' ? bodyOrBuilder(preview) : bodyOrBuilder;

  atomicJSON(current.result_file + '.status.json', {
    status: preview.status,
    reason: preview.reason || null,
    finished_at: finishedAt,
    warnings: Boolean(preview.warnings),
    ...(preview.native ? { native: preview.native } : {}),
  });
  const tmpResult = `${current.result_file}.tmp-${process.pid}`;
  fs.writeFileSync(tmpResult, body);
  replaceFile(tmpResult, current.result_file);

  return updateJob(jobId, { ...extra, finished_at: finishedAt }, root);
}
