import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyDshPlugin } from '../dsh/index.mjs';
import { terminateVerifiedWorker } from '../src/commands/lifecycle.mjs';
import { pidAlive } from '../src/job-store.mjs';
import { processIdentity } from '../src/process-tree.mjs';
import {
  clearRepoFamilyCaches,
  gitCommonDir,
  registerRepoTrajectory,
  repoIndexFilePath,
} from '../src/repo-family.mjs';
import { cancelBoardJob, listWorkspaceBoard, readBoardJobDetail } from '../src/sidebar-state.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(TEST_DIR, '..', 'bin', 'cospan.mjs');
const FAKE_AGY = path.join(TEST_DIR, 'fakes', 'fake-agy.mjs');
const FAKE_CODEX = path.join(TEST_DIR, 'fakes', 'fake-codex.mjs');

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

function runCospanInHome(args, { cwd, home, env = {} }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      COSPAN_HOME: home,
      COSPAN_CONFIG_DIR: home,
      AGY_BIN: FAKE_AGY,
      CODEX_BIN: FAKE_CODEX,
      COSPAN_CALLER_HOST: '',
      COSPAN_CALLER_SESSION_ID: '',
      ANTIGRAVITY_CONVERSATION_ID: '',
      ...env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function withWorktreeFixture(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-wt-'));
  const home = path.join(tmp, 'home');
  const mainRepo = path.join(tmp, 'main-repo');
  const wtDir = path.join(tmp, 'wt-feat');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(mainRepo, { recursive: true });

  const prevHome = process.env.COSPAN_HOME;
  process.env.COSPAN_HOME = home;
  clearRepoFamilyCaches();

  try {
    runGit(['init', '-q'], mainRepo);
    runGit(['config', 'user.email', 'test@example.com'], mainRepo);
    runGit(['config', 'user.name', 'Test'], mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), 'init\n');
    runGit(['add', 'README.md'], mainRepo);
    runGit(['commit', '-q', '-m', 'init'], mainRepo);
    runGit(['worktree', 'add', '-q', '-b', 'feat-wt', wtDir], mainRepo);
    await fn({ tmp, home, mainRepo, wtDir });
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    clearRepoFamilyCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sendAndWaitAgy(cwd, home, prompt, sessionId = 'sess-shared') {
  const sendRes = runCospanInHome(
    ['send', '--to', 'agy', '--readonly', '--json', '--prompt', prompt],
    {
      cwd,
      home,
      env: { COSPAN_CALLER_HOST: 'dsh', COSPAN_CALLER_SESSION_ID: sessionId },
    }
  );
  assert.equal(sendRes.code, 0, sendRes.stderr);
  const jobId = JSON.parse(sendRes.stdout).job_id;
  assert.equal(runCospanInHome(['wait', jobId, '--timeout', '10s'], { cwd, home }).code, 0);
  return jobId;
}

test('repo-family aggregates main + linked worktrees (even after worktree removal)', async () => {
  await withWorktreeFixture(async ({ home, mainRepo, wtDir }) => {
    const mainJobId = sendAndWaitAgy(mainRepo, home, 'Main task');
    const wtDoneId = sendAndWaitAgy(wtDir, home, 'Worktree task');

    const sendWtHang = runCospanInHome(
      ['send', '--to', 'codex', '--json', '--prompt', 'Worktree hang'],
      { cwd: wtDir, home, env: { FAKE_CODEX_HANG: '1' } }
    );
    assert.equal(sendWtHang.code, 0, sendWtHang.stderr);
    const wtHangId = JSON.parse(sendWtHang.stdout).job_id;

    // Query from mainRepo sees main + worktree jobs with caller_match & worktree_name
    const boardFromMain = listWorkspaceBoard(mainRepo, { callerSessionId: 'sess-shared' });
    assert.equal(boardFromMain.jobs.length, 3);
    const mainItem = boardFromMain.jobs.find((j) => j.id === mainJobId);
    const wtDoneItem = boardFromMain.jobs.find((j) => j.id === wtDoneId);
    assert.equal(mainItem.worktree_name, null);
    assert.equal(mainItem.caller_match, true);
    assert.equal(wtDoneItem.worktree_name, 'wt-feat');
    assert.equal(wtDoneItem.caller_match, true);

    // Query from wtDir sees mainRepo job too
    const boardFromWt = listWorkspaceBoard(wtDir, { callerSessionId: 'sess-shared' });
    assert.equal(boardFromWt.jobs.length, 3);
    assert.equal(boardFromWt.jobs.find((j) => j.id === mainJobId).worktree_name, 'main-repo');
    assert.equal(boardFromWt.jobs.find((j) => j.id === wtDoneId).worktree_name, null);

    // Detail & cancel work across worktrees from mainRepo
    const detail = readBoardJobDetail(mainRepo, wtDoneId);
    assert.equal(detail.ok, true);
    assert.match(detail.result_text, /Worktree task/);
    const cancelRes = await cancelBoardJob(mainRepo, wtHangId);
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.status, 'canceled');

    // Remove worktree on disk -> repo-index preserves wtDoneId & wtHangId in mainRepo board
    runGit(['worktree', 'remove', '--force', wtDir], mainRepo);
    clearRepoFamilyCaches();
    const afterRemove = listWorkspaceBoard(mainRepo, { callerSessionId: 'sess-shared' });
    assert.equal(afterRemove.jobs.length, 3);
    assert.ok(afterRemove.jobs.some((j) => j.id === wtDoneId));
  });
});

test('repo-family keeps CLI isolated, handles subdirs, and falls back cleanly', async () => {
  await withWorktreeFixture(async ({ tmp, home, mainRepo, wtDir }) => {
    const mainJobId = sendAndWaitAgy(mainRepo, home, 'Main CLI job', 'sess-a');
    const wtJobId = sendAndWaitAgy(wtDir, home, 'Worktree CLI job', 'sess-a');

    // CLI `status` remains strictly isolated per worktree so `--last` never crosses branches
    const mainStatus = runCospanInHome(['status'], { cwd: mainRepo, home });
    assert.equal(mainStatus.code, 0, mainStatus.stderr);
    assert.ok(mainStatus.stdout.includes(mainJobId));
    assert.ok(!mainStatus.stdout.includes(wtJobId));

    // Deleting repo-index still discovers active linked worktrees via `git worktree list`
    fs.rmSync(path.join(home, 'repo-index'), { recursive: true, force: true });
    clearRepoFamilyCaches();
    const nestedWtSubdir = path.join(wtDir, 'packages', 'sub');
    fs.mkdirSync(nestedWtSubdir, { recursive: true });
    const boardFromSubdir = listWorkspaceBoard(nestedWtSubdir, { callerSessionId: 'sess-a' });
    assert.equal(boardFromSubdir.jobs.length, 2);
    assert.equal(boardFromSubdir.jobs.find((j) => j.id === wtJobId).worktree_name, null);
    assert.equal(boardFromSubdir.jobs.find((j) => j.id === mainJobId).worktree_name, 'main-repo');

    // Non-git directory stays completely isolated with gitCommonDir === null
    const plainDir = path.join(tmp, 'plain-dir');
    fs.mkdirSync(plainDir, { recursive: true });
    assert.equal(gitCommonDir(plainDir), null);
    const plainJobId = sendAndWaitAgy(plainDir, home, 'Plain dir job', 'sess-a');
    const plainBoard = listWorkspaceBoard(plainDir, { callerSessionId: 'sess-a' });
    assert.deepEqual(
      plainBoard.jobs.map((j) => j.id),
      [plainJobId]
    );
  });
});

test('repo-index registration is idempotent and /cospan-ctl surfaces worktree jobs', async () => {
  await withWorktreeFixture(async ({ home, mainRepo, wtDir }) => {
    const wtJobId = sendAndWaitAgy(wtDir, home, 'DSH worktree task', 'dsh-wt-sess');

    // Repeated registration never duplicates trajectory entries
    registerRepoTrajectory(wtDir);
    clearRepoFamilyCaches();
    registerRepoTrajectory(wtDir);
    const commonDir = gitCommonDir(mainRepo);
    const indexPayload = JSON.parse(fs.readFileSync(repoIndexFilePath(commonDir), 'utf8'));
    assert.equal(indexPayload.trajectories.length, 1);

    // DSH /cospan-ctl called from mainRepo returns the worktree job and its detail
    const cmds = [];
    applyDshPlugin({
      inject(deps, fn) {
        if (deps[0] === 'commands') {
          fn({ get: () => null, commands: { register: (c) => cmds.push(c) } });
        }
      },
    });
    const ctl = cmds.find((c) => c.name === 'cospan-ctl');
    const fakeMainAgent = { session: { id: 'dsh-wt-sess', header: { cwd: mainRepo } } };

    const listRes = await ctl.handler({ agent: fakeMainAgent, rawInput: '{"action":"list"}' });
    assert.equal(listRes.kind, 'success');
    const listBody = JSON.parse(listRes.text);
    assert.equal(listBody.jobs.length, 1);
    assert.equal(listBody.jobs[0].id, wtJobId);
    assert.equal(listBody.jobs[0].worktree_name, 'wt-feat');
    assert.equal(listBody.jobs[0].caller_match, true);

    const detailRes = await ctl.handler({
      agent: fakeMainAgent,
      rawInput: JSON.stringify({ action: 'detail', id: wtJobId }),
    });
    assert.equal(detailRes.kind, 'success');
    assert.match(JSON.parse(detailRes.text).result_text, /DSH worktree task/);
  });
});

test('explicit <job-id> CLI commands resolve sibling worktrees; no-ID stays isolated', async () => {
  await withWorktreeFixture(async ({ home, mainRepo, wtDir }) => {
    const wtDoneId = sendAndWaitAgy(wtDir, home, 'Sibling done task', 'sess-cli');
    const canonicalWt = fs.realpathSync.native(wtDir);

    // No-ID commands from mainRepo (0 jobs) stay strictly isolated and never cross branches
    assert.match(runCospanInHome(['status'], { cwd: mainRepo, home }).stdout, /No cospan jobs/);
    assert.equal(runCospanInHome(['wait', '--timeout', '1s'], { cwd: mainRepo, home }).code, 1);
    assert.equal(runCospanInHome(['result'], { cwd: mainRepo, home }).code, 1);
    assert.equal(runCospanInHome(['observe'], { cwd: mainRepo, home }).code, 1);
    assert.equal(
      runCospanInHome(['continue', '--last', '--prompt', 'should fail'], { cwd: mainRepo, home })
        .code,
      1
    );

    // Explicit <wt-job-id> succeeds from mainRepo for observe, status, result
    const obs = runCospanInHome(['observe', wtDoneId], { cwd: mainRepo, home });
    assert.equal(obs.code, 0, obs.stderr);
    assert.equal(JSON.parse(obs.stdout).job_id, wtDoneId);

    const st = runCospanInHome(['status', wtDoneId], { cwd: mainRepo, home });
    assert.equal(st.code, 0, st.stderr);
    assert.equal(JSON.parse(st.stdout).id, wtDoneId);

    const res = runCospanInHome(['result', wtDoneId], { cwd: mainRepo, home });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Sibling done task/);

    // Explicit wait & cancel work from mainRepo on running sibling worktree jobs
    const sendDelay = runCospanInHome(
      ['send', '--to', 'agy', '--readonly', '--json', '--prompt', 'Sibling delayed task'],
      { cwd: wtDir, home, env: { FAKE_AGY_DELAY_MS: '250' } }
    );
    const wtDelayedId = JSON.parse(sendDelay.stdout).job_id;
    const waitRes = runCospanInHome(['wait', wtDelayedId, '--timeout', '10s'], {
      cwd: mainRepo,
      home,
    });
    assert.equal(waitRes.code, 0, waitRes.stderr);
    assert.match(waitRes.stdout, /Sibling delayed task/);

    const sendHang = runCospanInHome(['send', '--to', 'codex', '--json', '--prompt', 'Hang wt'], {
      cwd: wtDir,
      home,
      env: { FAKE_CODEX_HANG: '1' },
    });
    const wtHangId = JSON.parse(sendHang.stdout).job_id;
    const cancelRes = runCospanInHome(['cancel', wtHangId], { cwd: mainRepo, home });
    assert.equal(cancelRes.code, 0, cancelRes.stderr);
    assert.equal(
      JSON.parse(runCospanInHome(['status', wtHangId], { cwd: mainRepo, home }).stdout).status,
      'canceled'
    );

    // Explicit continue --id and restart preserve sibling worktree cwd and trajectory
    const contRes = runCospanInHome(
      ['continue', '--id', wtDoneId, '--json', '--prompt', 'Sibling follow-up'],
      { cwd: mainRepo, home }
    );
    assert.equal(contRes.code, 0, contRes.stderr);
    const contId = JSON.parse(contRes.stdout).job_id;
    const contWait = runCospanInHome(['wait', contId, '--timeout', '10s'], { cwd: mainRepo, home });
    assert.equal(contWait.code, 0, contWait.stderr);
    assert.match(contWait.stdout, /Sibling follow-up/);
    const contStatus = JSON.parse(
      runCospanInHome(['status', contId], { cwd: mainRepo, home }).stdout
    );
    assert.equal(fs.realpathSync.native(contStatus.cwd), canonicalWt);

    const restartRes = runCospanInHome(['restart', wtDoneId], { cwd: mainRepo, home });
    assert.equal(restartRes.code, 0, restartRes.stderr);
    const restartedId = /new job (agy-[^\s]+)/.exec(restartRes.stdout)?.[1];
    assert.ok(restartedId);
    assert.equal(
      runCospanInHome(['wait', restartedId, '--timeout', '10s'], { cwd: mainRepo, home }).code,
      0
    );
    assert.equal(
      fs.realpathSync.native(
        JSON.parse(runCospanInHome(['status', restartedId], { cwd: mainRepo, home }).stdout).cwd
      ),
      canonicalWt
    );

    // Main worktree still has 0 local jobs; adding a main job keeps --last pinned to mainRepo
    assert.match(runCospanInHome(['status'], { cwd: mainRepo, home }).stdout, /No cospan jobs/);
    const mainJobId = sendAndWaitAgy(mainRepo, home, 'Main only task', 'sess-cli');
    const lastCont = runCospanInHome(
      ['continue', '--last', '--json', '--prompt', 'Main follow-up'],
      { cwd: mainRepo, home }
    );
    assert.equal(lastCont.code, 0, lastCont.stderr);
    const lastParsed = JSON.parse(lastCont.stdout);
    assert.equal(lastParsed.continued_from, mainJobId);
    assert.equal(
      runCospanInHome(['wait', lastParsed.job_id, '--timeout', '10s'], { cwd: mainRepo, home })
        .code,
      0
    );

    // Removed worktree jobs remain readable via explicit ID, while continue fails cleanly
    runGit(['worktree', 'remove', '--force', wtDir], mainRepo);
    assert.equal(runCospanInHome(['result', wtDoneId], { cwd: mainRepo, home }).code, 0);
    assert.equal(runCospanInHome(['observe', wtDoneId], { cwd: mainRepo, home }).code, 0);
    const deadCont = runCospanInHome(
      ['continue', '--id', wtDoneId, '--prompt', 'After wt removal'],
      { cwd: mainRepo, home }
    );
    assert.equal(deadCont.code, 1);
    assert.match(deadCont.stderr, /no longer exists/);
  });
});

test('terminateVerifiedWorker skips SIGTERM until worker_started_at is published', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    const identity = processIdentity(child.pid);
    assert.ok(identity, 'expected live child processIdentity');

    terminateVerifiedWorker({ pid: child.pid, worker_identity: identity });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(child.exitCode, null);
    assert.equal(pidAlive(child.pid), true);

    if (process.platform !== 'win32') {
      const exited = new Promise((resolve) => {
        child.once('exit', (code, sig) => resolve({ code, sig }));
      });
      terminateVerifiedWorker({
        pid: child.pid,
        worker_identity: identity,
        worker_started_at: new Date().toISOString(),
      });
      const res = await exited;
      assert.equal(res.sig, 'SIGTERM');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
