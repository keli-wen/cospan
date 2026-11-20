import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requestSafeJobCancellation } from '../src/commands/lifecycle.mjs';
import { cliCommandPrefix } from '../src/installer-templates.mjs';
import { loadState, updateState, workspaceStateDir } from '../src/job-store.mjs';
import { readTextRetry, replaceFile, withStateLock } from '../src/state-lock.mjs';
import { buildSpawnCommand } from '../src/targets.mjs';
import { rmTree, writeNpmCmdShim } from './windows-helpers.mjs';

test('buildSpawnCommand unwraps npm .cmd shims on all platforms and quotes native .cmd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-shim-unit-'));
  try {
    const scriptsDir = path.join(root, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const targetScript = path.join(scriptsDir, 'echo-argv.mjs');
    fs.writeFileSync(
      targetScript,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      'utf8'
    );
    const npmShim = writeNpmCmdShim(root, 'tool', 'scripts\\echo-argv.mjs');

    const unwrapped = buildSpawnCommand(npmShim, ['--flag', 'hello & %OS%\nline2']);
    assert.equal(unwrapped.cmd, process.execPath);
    assert.equal(unwrapped.args[0], targetScript);
    assert.deepEqual(unwrapped.args.slice(1), ['--flag', 'hello & %OS%\nline2']);
    assert.equal(unwrapped.windowsVerbatimArguments, false);

    // Executing unwrapped command works cross-platform without cmd.exe.
    const execRes = spawnSync(unwrapped.cmd, unwrapped.args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(execRes.status, 0, execRes.stderr);
    assert.deepEqual(JSON.parse(execRes.stdout), ['--flag', 'hello & %OS%\nline2']);

    // Non-Node batch wrapper falls back to cmd.exe with verbatim arguments on win32.
    const nativeBat = path.join(root, 'native tool.cmd');
    fs.writeFileSync(nativeBat, '@echo off\r\necho native %*\r\n', 'utf8');
    const wrapped = buildSpawnCommand(nativeBat, ['--check', 'a & %OS% "q"'], 'win32');
    assert.match(wrapped.cmd, /cmd(?:\.exe)?$/i);
    assert.equal(wrapped.windowsVerbatimArguments, true);
    assert.deepEqual(wrapped.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(wrapped.args[3].includes('--check'));
    assert.ok(wrapped.args[3].includes('"^%"OS"^%"'));

    // Skill CLI path interpolation normalizes Windows backslashes to forward slashes.
    assert.equal(
      cliCommandPrefix('C:\\Users\\dev\\cospan\\bin\\cospan.mjs'),
      'node "C:/Users/dev/cospan/bin/cospan.mjs"'
    );
  } finally {
    rmTree(root);
  }
});

test('replaceFile, readTextRetry, and withStateLock recover from transient EBUSY/EPERM', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-retry-unit-'));
  const origRename = fs.renameSync;
  const origRead = fs.readFileSync;
  try {
    const targetFile = path.join(root, 'data.json');
    const tmpFile = path.join(root, 'data.json.tmp');
    fs.writeFileSync(tmpFile, '{"ok":true}\n', 'utf8');

    let renameFails = 2;
    fs.renameSync = (...args) => {
      if (renameFails-- > 0) {
        throw Object.assign(new Error('simulated transient EBUSY'), { code: 'EBUSY' });
      }
      return origRename(...args);
    };
    replaceFile(tmpFile, targetFile);
    assert.equal(renameFails, -1);

    let readFails = 2;
    fs.readFileSync = (...args) => {
      if (readFails-- > 0) {
        throw Object.assign(new Error('simulated transient EPERM'), { code: 'EPERM' });
      }
      return origRead(...args);
    };
    assert.equal(readTextRetry(targetFile), '{"ok":true}\n');
    assert.equal(readFails, -1);

    let lockFails = 2;
    fs.renameSync = (...args) => {
      if (lockFails-- > 0) {
        throw Object.assign(new Error('simulated lock EPERM'), { code: 'EPERM' });
      }
      return origRename(...args);
    };
    const lockDir = path.join(root, 'state.lock');
    const result = withStateLock(lockDir, () => 'acquired');
    assert.equal(result, 'acquired');
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.renameSync = origRename;
    fs.readFileSync = origRead;
    rmTree(root);
  }
});

test('loadState/updateState fails on persistent EBUSY instead of wiping state.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-state-ebusy-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const prevHome = process.env.COSPAN_HOME;
  const origRead = fs.readFileSync;
  process.env.COSPAN_HOME = home;

  try {
    updateState((s) => {
      s.jobs.push({ id: 'keep-job-001', target: 'agy', status: 'done' });
    }, workspace);
    const stateFile = path.join(workspaceStateDir(workspace), 'state.json');

    fs.readFileSync = (file, ...rest) => {
      if (file === stateFile) {
        throw Object.assign(new Error('simulated persistent EBUSY'), { code: 'EBUSY' });
      }
      return origRead(file, ...rest);
    };

    let mutatorRan = false;
    assert.throws(
      () =>
        updateState((s) => {
          mutatorRan = true;
          s.jobs.push({ id: 'should-not-run', target: 'agy', status: 'done' });
        }, workspace),
      (err) => err?.code === 'EBUSY'
    );
    assert.equal(mutatorRan, false);

    fs.readFileSync = origRead;
    const preserved = loadState(workspace);
    assert.deepEqual(
      preserved.jobs.map((j) => j.id),
      ['keep-job-001']
    );
  } finally {
    fs.readFileSync = origRead;
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    rmTree(root);
  }
});

test('requestSafeJobCancellation checks processIdentity outside state.lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-cancel-lock-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const prevHome = process.env.COSPAN_HOME;
  process.env.COSPAN_HOME = home;

  try {
    const stateDir = workspaceStateDir(workspace);
    const lockDir = path.join(stateDir, 'state.lock');
    const specFile = path.join(stateDir, 'jobs', 'job-lock-1.spec.json');
    fs.writeFileSync(specFile, '{}\n', 'utf8');

    updateState((s) => {
      s.jobs.push({
        id: 'job-lock-1',
        target: 'agy',
        status: 'running',
        pid: process.pid,
        worker_identity: { pid: process.pid, born: 'born-original' },
        spec_file: specFile,
      });
    }, workspace);

    let sawLockOnMismatch = null;
    const mismatch = requestSafeJobCancellation('job-lock-1', workspace, {
      getProcessIdentity: (pid) => {
        sawLockOnMismatch = fs.existsSync(lockDir);
        return { pid, born: 'born-reused' };
      },
    });
    assert.equal(sawLockOnMismatch, false, 'state.lock must NOT be held during processIdentity');
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /reused PID/i);
    assert.equal(fs.existsSync(`${specFile}.cancel`), false);

    let sawLockOnMatch = null;
    const matched = requestSafeJobCancellation('job-lock-1', workspace, {
      getProcessIdentity: (pid) => {
        sawLockOnMatch = fs.existsSync(lockDir);
        return { pid, born: 'born-original' };
      },
    });
    assert.equal(sawLockOnMatch, false, 'state.lock must NOT be held during processIdentity');
    assert.equal(matched.ok, true);
    assert.equal(matched.changed, true);
    assert.equal(fs.existsSync(`${specFile}.cancel`), true);
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    rmTree(root);
  }
});
