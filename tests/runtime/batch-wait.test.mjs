import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  boundBatchRunningSummary,
  collectUniqueWaitIds,
  computeBatchExitCode,
} from '../../src/batch-wait.mjs';
import { COSPAN_BIN as BIN, FAKE_FILES } from '../helpers/paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX } = FAKE_FILES;

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-batch-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# batch wait repo\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function runCospan(args, { cwd, env = {} } = {}) {
  const cfgDir = `${cwd}-cospan-cfg`;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGY_BIN: FAKE_AGY,
      CODEX_BIN: FAKE_CODEX,
      COSPAN_HOME: cfgDir,
      COSPAN_CONFIG_DIR: cfgDir,
      ...env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sendJson(cwd, args, env = {}) {
  const res = runCospan(['send', '--json', ...args], { cwd, env });
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).job_id;
}

test('batch wait helpers: deduplication, severity precedence, and <= 8 KiB summary bound', () => {
  assert.deepEqual(collectUniqueWaitIds({ _: ['a', 'b', 'a', 'c', 'b'] }), ['a', 'b', 'c']);
  assert.deepEqual(collectUniqueWaitIds({ id: 'x', _: ['x', 'y'] }), ['x', 'y']);

  assert.equal(computeBatchExitCode(['done', 'done']), 0);
  assert.equal(computeBatchExitCode(['done', 'attention']), 5);
  assert.equal(computeBatchExitCode(['attention', 'canceled']), 4);
  assert.equal(computeBatchExitCode(['done', 'canceled']), 4);
  assert.equal(computeBatchExitCode(['canceled', 'error']), 3);
  assert.equal(computeBatchExitCode(['attention', 'crashed']), 3);

  const hugeJobs = Array.from({ length: 250 }, (_, i) => ({
    job_id: `agy-202611230000-${String(i).padStart(4, '0')}-extra-long-identifier`,
    target: 'agy',
    readonly: true,
    status: i % 2 === 0 ? 'running' : 'done',
    started_at: new Date().toISOString(),
    elapsed_seconds: 42,
    phase: 'responding',
  }));
  const bounded = boundBatchRunningSummary({
    status: 'running',
    observed_at: new Date().toISOString(),
    completed_ids: hugeJobs.filter((j) => j.status !== 'running').map((j) => j.job_id),
    pending_ids: hugeJobs.filter((j) => j.status === 'running').map((j) => j.job_id),
    jobs: hugeJobs,
    hint: 'Still waiting...',
  });
  assert.equal(bounded.status, 'running');
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded) + '\n', 'utf8') <= 8192);
});

test('batch WaitAll orders slow+fast outputs, deduplicates IDs, fails fast on unknown', () => {
  const repo = makeTempGitRepo();
  try {
    const slowId = sendJson(repo, ['--to', 'codex', '--readonly', '--prompt', 'BATCH_SLOW_FIRST'], {
      FAKE_CODEX_DELAY_MS: '450',
    });
    const fastId = sendJson(repo, ['--to', 'agy', '--readonly', '--prompt', 'BATCH_FAST_SECOND']);

    // Unknown ID fails fast with exit 1 before waiting
    const missing = runCospan(['wait', slowId, 'nonexistent-job-id', '--timeout', '5s'], {
      cwd: repo,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no job "nonexistent-job-id"/);

    // Caller order [slowId, fastId, slowId] is preserved & deduplicated, separated by \n---\n\n
    const waitRes = runCospan(['wait', slowId, fastId, slowId, '--timeout', '15s'], { cwd: repo });
    assert.equal(waitRes.code, 0, waitRes.stderr);
    const sections = waitRes.stdout.split('\n---\n\n');
    assert.equal(sections.length, 2, `expected 2 deliverables, got:\n${waitRes.stdout}`);
    assert.match(sections[0], new RegExp(`# Job ${slowId}`));
    assert.match(sections[0], /BATCH_SLOW_FIRST/);
    assert.match(sections[1], new RegExp(`# Job ${fastId}`));
    assert.match(sections[1], /BATCH_FAST_SECOND/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('batch WaitAll uses allSettled (early failure never cancels slow sibling, exit 3)', () => {
  const repo = makeTempGitRepo();
  try {
    const failFastId = sendJson(repo, ['--to', 'agy', '--readonly', '--prompt', 'EARLY_FAIL_JOB'], {
      FAKE_AGY_FAIL: '1',
    });
    const slowOkId = sendJson(
      repo,
      ['--to', 'codex', '--readonly', '--prompt', 'SLOW_SURVIVOR_JOB'],
      { FAKE_CODEX_DELAY_MS: '500' }
    );

    const waitRes = runCospan(['wait', failFastId, slowOkId, '--timeout', '15s'], { cwd: repo });
    assert.equal(waitRes.code, 3, waitRes.stdout);
    const sections = waitRes.stdout.split('\n---\n\n');
    assert.equal(sections.length, 2);
    assert.match(sections[0], new RegExp(`# Job ${failFastId}.*status=error`));
    assert.match(sections[1], new RegExp(`# Job ${slowOkId}.*status=done`));
    assert.match(sections[1], /SLOW_SURVIVOR_JOB/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('batch WaitAll partial timeout returns bounded <= 8 KiB JSON (exit 2) without bodies', () => {
  const repo = makeTempGitRepo();
  let hangId = null;
  try {
    const fastId = sendJson(repo, [
      '--to',
      'agy',
      '--readonly',
      '--prompt',
      'COMPLETED_SECRET_MARKER_BODY',
    ]);
    assert.equal(runCospan(['wait', fastId, '--timeout', '10s'], { cwd: repo }).code, 0);

    hangId = sendJson(repo, ['--to', 'codex', '--readonly', '--prompt', 'LONG_PENDING_JOB'], {
      FAKE_CODEX_HANG: '1',
    });

    const partial = runCospan(['wait', fastId, hangId, '--timeout', '150ms'], { cwd: repo });
    assert.equal(partial.code, 2, partial.stderr);
    assert.ok(Buffer.byteLength(partial.stdout, 'utf8') <= 8192);
    assert.ok(!partial.stdout.includes('COMPLETED_SECRET_MARKER_BODY'));

    const summary = JSON.parse(partial.stdout);
    assert.equal(summary.status, 'running');
    assert.deepEqual(summary.completed_ids, [fastId]);
    assert.deepEqual(summary.pending_ids, [hangId]);
    assert.equal(summary.jobs.find((j) => j.job_id === fastId).status, 'done');
    assert.equal(summary.jobs.find((j) => j.job_id === hangId).status, 'running');

    // Cancel hanging job -> subsequent batch wait settles with canceled precedence (exit 4)
    assert.equal(runCospan(['cancel', hangId], { cwd: repo }).code, 0);
    const settled = runCospan(['wait', fastId, hangId, '--timeout', '5s'], { cwd: repo });
    assert.equal(settled.code, 4, settled.stdout);
    assert.match(settled.stdout, /COMPLETED_SECRET_MARKER_BODY/);
    assert.match(settled.stdout, new RegExp(`# Job ${hangId}.*status=canceled`));
  } finally {
    if (hangId) runCospan(['cancel', hangId], { cwd: repo });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('batch WaitAll resolves mixed main + sibling worktree job IDs together', () => {
  const repo = makeTempGitRepo();
  const wtDir = `${repo}-wt`;
  try {
    const wtAdd = spawnSync('git', ['worktree', 'add', '-q', '-b', 'wt-batch', wtDir], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(wtAdd.status, 0, wtAdd.stderr);
    const sharedHome = `${repo}-cospan-cfg`;
    const env = { COSPAN_HOME: sharedHome, COSPAN_CONFIG_DIR: sharedHome };
    const mainId = sendJson(repo, ['--to', 'agy', '--readonly', '--prompt', 'MAIN_BATCH_WT'], env);
    const wtId = sendJson(wtDir, ['--to', 'codex', '--readonly', '--prompt', 'SIBLING_BATCH_WT'], {
      ...env,
      FAKE_CODEX_DELAY_MS: '250',
    });

    const res = runCospan(['wait', mainId, wtId, '--timeout', '15s'], { cwd: repo, env });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /MAIN_BATCH_WT/);
    assert.match(res.stdout, /SIBLING_BATCH_WT/);
  } finally {
    fs.rmSync(wtDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});
