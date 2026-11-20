import fs from 'node:fs';
import { processIdentity } from '../process-tree.mjs';
import { DEFAULT_WAIT_TIMEOUT, die, durationToMs, JOB_EXIT_CODES } from '../cli-args.mjs';
import { renderJobResponse } from '../job-diagnostics.mjs';
import {
  findJob,
  liveJobStatus,
  loadState,
  pidAlive,
  refreshJobs,
  repoRoot,
  updateState,
} from '../job-store.mjs';

export async function cmdWait(opts) {
  const id = opts._[0] || opts.id || null;
  const timeout = opts.timeout || DEFAULT_WAIT_TIMEOUT;
  const budget = durationToMs(timeout);
  if (!Number.isFinite(budget) || budget < 0)
    die(`invalid --timeout "${timeout}" (examples: 100s, 20m)`);

  const root = repoRoot();
  const findTarget = () => {
    const jobs = loadState(root).jobs || [];
    return id ? jobs.find((j) => j.id === id) || null : jobs.at(-1) || null;
  };
  let job = findTarget();
  if (!job)
    die(id ? `no job "${id}" in this repository` : 'no cospan jobs recorded in this repository');

  const pollMs = 200;
  const start = Date.now();
  let status = liveJobStatus(job);
  while (status === 'running' && Date.now() - start < budget) {
    await new Promise((r) => setTimeout(r, Math.min(pollMs, budget - (Date.now() - start))));
    job = findTarget();
    if (!job) die('job record disappeared from state.json');
    status = liveJobStatus(job);
  }
  return renderJobResponse(job);
}

export function cmdObserve(opts) {
  const id = opts._[0] || opts.id || null;
  const job = findJob(id);
  renderJobResponse(job, { observeOnly: true });
}

export function cmdResult(opts) {
  const root = repoRoot();
  const state = loadState(root);
  refreshJobs(state);
  const jobs = state.jobs || [];
  const id = opts._[0] || opts.id || null;
  const job = id
    ? jobs.find((j) => j.id === id)
    : [...jobs].reverse().find((j) => j.status !== 'running');
  if (!job)
    die(id ? `no job "${id}" in this repository` : 'no finished cospan jobs in this repository');
  if (job.status === 'running') {
    die(
      `job ${job.id} is still running — collect with \`cospan wait ${job.id}\` ` +
        `or peek with \`cospan observe ${job.id}\``
    );
  }
  if (!fs.existsSync(job.result_file)) {
    die(`job ${job.id} (${job.status}) has no stored result. Log: ${job.log_file}`);
  }
  renderJobResponse(job);
  process.exitCode = job.status === 'attention' ? 5 : 0;
}

export function cmdStatus(opts) {
  const root = repoRoot();
  const state = loadState(root);
  refreshJobs(state);
  const jobs = state.jobs || [];
  const id = opts._[0] || opts.id || null;

  if (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) die(`no job "${id}" in this repository`);
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    process.exitCode = JOB_EXIT_CODES[job.status] ?? 1;
    return;
  }

  if (!jobs.length) {
    process.stdout.write('No cospan jobs recorded in this repository.\n');
    return;
  }
  process.stdout.write('id | target | access | status | started | finished\n');
  for (const j of jobs.slice(-20)) {
    const access = j.readonly ? 'readonly' : 'writable';
    const finished = j.finished_at || '-';
    process.stdout.write(
      `${j.id} | ${j.target} | ${access} | ${j.status} | ${j.started_at} | ${finished}\n`
    );
  }
}

function checkMatchingWorkerIdentity(targetJob, preChecked) {
  const identity = targetJob.worker_identity;
  if (!identity) return { ok: true };
  const current = preChecked && preChecked.pid === targetJob.pid ? preChecked.identity : null;
  if (identity.pid !== targetJob.pid || (current && identity.born !== current.born)) {
    return {
      ok: false,
      error: 'worker identity no longer matches this job; refusing to signal a reused PID',
    };
  }
  return { ok: true };
}

export function requestSafeJobCancellation(
  id,
  root,
  { getProcessIdentity = processIdentity } = {}
) {
  const preJob = (loadState(root).jobs || []).find((j) => j.id === id) || null;
  const preChecked =
    preJob?.worker_identity && liveJobStatus(preJob) === 'running'
      ? { pid: preJob.pid, identity: getProcessIdentity(preJob.pid) }
      : null;
  return updateState((state) => {
    const targetJob = state.jobs?.find((j) => j.id === id);
    if (!targetJob) {
      return {
        ok: false,
        notFound: true,
        status: null,
        error: `no job "${id}" in this repository`,
      };
    }
    const status = liveJobStatus(targetJob);
    if (status !== 'running') {
      return { ok: true, changed: false, job: targetJob, status };
    }
    if (!targetJob.spec_file) {
      return { ok: false, status, error: 'job has no spec_file cancellation channel' };
    }
    const idCheck = checkMatchingWorkerIdentity(targetJob, preChecked);
    if (!idCheck.ok) {
      return { ok: false, status, error: idCheck.error };
    }
    targetJob.cancel_requested_at ||= new Date().toISOString();
    fs.writeFileSync(targetJob.spec_file + '.cancel', targetJob.cancel_requested_at);
    return { ok: true, changed: true, job: targetJob, status };
  }, root);
}

export function terminateVerifiedWorker(job) {
  // Worker registers SIGTERM handlers right before publishing worker_started_at;
  // gating on it avoids killing a booting worker before it can write a canceled report.
  if (!job.worker_started_at) return;
  if (!job.worker_identity || process.platform === 'win32') return;
  const current = processIdentity(job.pid);
  if (
    current &&
    current.pid === job.worker_identity.pid &&
    current.born === job.worker_identity.born
  ) {
    try {
      process.kill(current.pid, 'SIGTERM');
    } catch {}
  }
}

export async function cmdCancel(opts) {
  const id = opts._[0] || opts.id;
  if (!id) die('`cancel` requires a job id (see `cospan status`)');
  const root = repoRoot();
  const res = requestSafeJobCancellation(id, root);
  if (!res.ok) die(res.error);

  if (!res.changed) {
    process.stdout.write(`Job ${id} is not running (status: ${res.status}).\n`);
    return;
  }

  terminateVerifiedWorker(res.job);

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const current = findJob(id, root);
    const status = liveJobStatus(current);
    if (status === 'canceled' && !pidAlive(current.pid)) {
      process.stdout.write(`Canceled job ${id} (pid ${res.job.pid}).\n`);
      return;
    }
    if (status !== 'running' && status !== 'canceled') {
      die(
        `Cancellation requested, but job transitioned to ${status}; ` +
          `inspect \`cospan observe ${id}\`.`
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  die(
    'Cancellation requested, but worker has not published a terminal report yet; ' +
      `inspect \`cospan observe ${id}\`.`
  );
}
