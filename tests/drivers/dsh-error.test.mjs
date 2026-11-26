import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dshDriver } from '../../src/drivers/dsh.mjs';
import { COSPAN_BIN as BIN, FAKE_FILES } from '../helpers/paths.mjs';

const FAKE_DSH = FAKE_FILES.dsh;

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-err-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function runCospanDsh(args, { cwd, env = {} }) {
  const cfgDir = `${cwd}-cospan-cfg`;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_BIN: FAKE_DSH,
      COSPAN_HOME: cfgDir,
      COSPAN_CONFIG_DIR: cfgDir,
      ...env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('dsh terminal final errors surface reason instead of empty done', () => {
  const s1 = dshDriver.createStreamSession();
  s1.acceptEvent({
    type: 'final',
    sessionId: 'dsh-e1',
    reason: { kind: 'error', error: { message: 'no API key' } },
  });
  const fin1 = s1.finalize(0);
  assert.equal(fin1.payload, null);
  assert.equal(fin1.streamFailure, 'no API key');
  assert.equal(fin1.native.stream_error, 'no API key');

  const s2 = dshDriver.createStreamSession();
  s2.acceptEvent({ type: 'final', reason: { kind: 'error', message: 'provider timeout' } });
  const fin2 = s2.finalize(0);
  assert.equal(fin2.payload, null);
  assert.equal(fin2.streamFailure, 'provider timeout');

  const s3 = dshDriver.createStreamSession();
  s3.acceptEvent({ type: 'text', delta: 'partial ' });
  s3.acceptEvent({ type: 'final', reason: { kind: 'error', error: 'quota exceeded' } });
  const fin3 = s3.finalize(0);
  assert.equal(fin3.payload, null);
  assert.equal(fin3.streamFailure, 'quota exceeded');

  const s4 = dshDriver.createStreamSession();
  s4.acceptEvent({ type: 'final', reason: { kind: 'error' }, text: 'fallback text error' });
  const fin4 = s4.finalize(0);
  assert.equal(fin4.payload, null);
  assert.equal(fin4.streamFailure, 'fallback text error');

  // Empty error object or null on an otherwise successful final must not falsely fail
  for (const okErr of [{}, null]) {
    const okSess = dshDriver.createStreamSession();
    okSess.acceptEvent({ type: 'final', text: 'all good', error: okErr });
    const okFin = okSess.finalize(0);
    assert.equal(okFin.streamFailure, null);
    assert.equal(okFin.payload.response, 'all good');
  }

  assert.throws(
    () =>
      dshDriver.parseForegroundOutput({
        stdout:
          JSON.stringify({
            type: 'final',
            reason: { kind: 'error', error: { message: 'ask final error' } },
          }) + '\n',
        stderr: '',
        exitCode: 0,
      }),
    /ask final error/
  );
});

test('dsh explicit error flags and prior stream error preservation', () => {
  const cases = [
    [{ type: 'final', isError: true, message: 'flag camelCase error' }, 'flag camelCase error'],
    [{ type: 'final', is_error: true, text: 'flag snake_case error' }, 'flag snake_case error'],
    [{ type: 'final', error: 'top-level string error' }, 'top-level string error'],
    [{ type: 'final', error: { message: 'top-level object error' } }, 'top-level object error'],
  ];
  for (const [ev, expected] of cases) {
    const sess = dshDriver.createStreamSession();
    sess.acceptEvent(ev);
    const fin = sess.finalize(0);
    assert.equal(fin.payload, null);
    assert.equal(fin.streamFailure, expected);
  }

  const prior = dshDriver.createStreamSession();
  prior.acceptEvent({ type: 'error', message: '401 Unauthorized' });
  prior.acceptEvent({ type: 'final', reason: { kind: 'error' } });
  const priorFin = prior.finalize(0);
  assert.equal(priorFin.payload, null);
  assert.equal(priorFin.streamFailure, '401 Unauthorized');
});

test('dsh runtime ask and send->wait fail when CLI exits 0 with final error', () => {
  const repo = makeTempGitRepo();
  const env = { FAKE_DSH_FINAL_ERROR: '1' };
  try {
    const askRes = runCospanDsh(['ask', '--to', 'dsh', '--prompt', 'ping'], { cwd: repo, env });
    assert.equal(askRes.code, 1, askRes.stderr);
    assert.match(askRes.stderr, /Simulated dsh final error/);

    const sendRes = runCospanDsh(['send', '--to', 'dsh', '--json', '--prompt', 'check'], {
      cwd: repo,
      env,
    });
    assert.equal(sendRes.code, 0, sendRes.stderr);
    const { job_id: jobId } = JSON.parse(sendRes.stdout);

    const waitRes = runCospanDsh(['wait', jobId, '--timeout', '10s'], { cwd: repo, env });
    assert.equal(waitRes.code, 3, waitRes.stdout);
    assert.match(waitRes.stdout, /Simulated dsh final error/);
    assert.doesNotMatch(waitRes.stdout, /status=done/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(`${repo}-cospan-cfg`, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});
