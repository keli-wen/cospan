import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { repoRoot } from '../../src/job-store.mjs';
import {
  bornAfterParent,
  parseBorn,
  parseWindowsProcessTable,
  processIdentity,
  processTable,
  signalGroup,
  stopExecution,
  tree,
  windowsProcessTable,
} from '../../src/process-tree.mjs';
import { SRC_DIR } from '../helpers/paths.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function listMjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

async function waitForIdentity(pid, maxTries = 30) {
  for (let i = 0; i < maxTries; i++) {
    const id = processIdentity(pid);
    if (id) return id;
    await pause(100);
  }
  return null;
}

async function waitForRootAndChild(rootPid, maxTries = 30) {
  let rootIdentity = null;
  let child = null;
  for (let i = 0; i < maxTries && !(rootIdentity && child); i++) {
    const rows = processTable();
    rootIdentity ||= rows?.find((row) => row.pid === rootPid) || null;
    child = rows?.find((row) => row.parent === rootPid) || null;
    if (!(rootIdentity && child)) await pause(100);
  }
  return { rootIdentity, child };
}

test('every spawn and spawnSync call in src/**/*.mjs passes windowsHide: true', () => {
  const files = listMjsFiles(SRC_DIR);
  assert.ok(files.length > 0, 'src directory should contain .mjs files');
  let checkedCalls = 0;

  for (const file of files) {
    const rel = path.relative(SRC_DIR, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:import\b|\/\/|\*)/.test(line)) continue;
      if (!/\b(spawnSync|spawn)\s*\(/.test(line)) continue;
      checkedCalls += 1;
      const block = lines.slice(i, Math.min(lines.length, i + 15)).join('\n');
      assert.match(
        block,
        /windowsHide:\s*true/,
        `Expected windowsHide: true for spawn call in src/${rel}:${i + 1}:\n${block}`
      );
    }
  }
  assert.ok(checkedCalls >= 10, `expected at least 10 spawn calls in src/, found ${checkedCalls}`);
});

test('repoRoot() memoizes and normalizes paths without re-spawning git rev-parse', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-memo-root-'));
  const sub1 = path.join(repo, 'nested', 'dir1');
  const sub2 = path.join(repo, 'nested', 'dir2');
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    assert.equal(init.status, 0, init.stderr?.toString());
    fs.mkdirSync(sub1, { recursive: true });
    fs.mkdirSync(sub2, { recursive: true });

    const first = repoRoot(sub1);
    assert.equal(first, path.normalize(first), 'repoRoot should return a normalized path');
    assert.equal(fs.realpathSync.native(first), fs.realpathSync.native(repo));
    assert.notEqual(first, path.resolve(sub1));

    // Disable .git so any uncached git rev-parse falls back to path.resolve(dir).
    fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-disabled'));

    const cached = repoRoot(sub1);
    assert.equal(cached, first, 'repeated repoRoot(sub1) must return memoized result');

    const uncached = repoRoot(sub2);
    assert.equal(
      uncached,
      path.resolve(sub2),
      'uncached subdir must observe disabled .git, proving sub1 hit the memo cache'
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('parseWindowsProcessTable: parses PowerShell ISO-8601, locale, and wmic outputs', () => {
  const isoSample = `
ProcessId ParentProcessId CreationDate
--------- --------------- ------------
        0               0
        4               0 2026-09-13T11:00:00.0000000+00:00
     3616            2468 2026-09-13T11:33:32.5460000+00:00
`;
  assert.deepEqual(parseWindowsProcessTable(isoSample), [
    { pid: 0, parent: 0, group: 0, born: 'unknown' },
    { pid: 4, parent: 0, group: 4, born: '2026-09-13T11:00:00.0000000+00:00' },
    { pid: 3616, parent: 2468, group: 3616, born: '2026-09-13T11:33:32.5460000+00:00' },
  ]);

  const localeSample = `
ProcessId ParentProcessId CreationDate
--------- --------------- ------------
        4               0 9/12/2026 1:00:00 PM
     1234               4 9/12/2026 1:05:00 PM
`;
  assert.deepEqual(parseWindowsProcessTable(localeSample), [
    { pid: 4, parent: 0, group: 4, born: '9/12/2026 1:00:00 PM' },
    { pid: 1234, parent: 4, group: 1234, born: '9/12/2026 1:05:00 PM' },
  ]);

  const wmicSample = `
CreationDate               ParentProcessId  ProcessId
20260912130500.000000+000  4                1234
20260912130501.000000+000  1234             5678
`;
  assert.deepEqual(parseWindowsProcessTable(wmicSample), [
    { pid: 1234, parent: 4, group: 1234, born: '20260912130500.000000+000' },
    { pid: 5678, parent: 1234, group: 5678, born: '20260912130501.000000+000' },
  ]);

  assert.deepEqual(parseWindowsProcessTable(''), []);
  assert.deepEqual(parseWindowsProcessTable(null), []);
  assert.deepEqual(parseWindowsProcessTable('random header\nno numbers here'), []);
});

test('windowsProcessTable: requests 100ns ISO-8601 via PowerShell and falls back to wmic', () => {
  const calls = [];
  const fakeRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'powershell') {
      return { status: 1, error: new Error('command not found'), stdout: '' };
    }
    if (cmd === 'wmic') {
      return {
        status: 0,
        stdout:
          'CreationDate               ParentProcessId  ProcessId\n' +
          '20260912130500.000000+000  4                1234\n',
      };
    }
    return { status: 1, stdout: '' };
  };

  const rows = windowsProcessTable(fakeRunner);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cmd, 'powershell');
  assert.ok(calls[0].args.includes('-NoLogo'));
  assert.match(calls[0].args.at(-1), /Get-CimInstance Win32_Process/);
  assert.match(calls[0].args.at(-1), /CreationDate\.ToString\('o'\)/);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[1].cmd, 'wmic');
  assert.equal(calls[1].opts.windowsHide, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 1234);

  const failingRunner = () => ({ status: 1, stdout: '', error: new Error('failed') });
  assert.equal(windowsProcessTable(failingRunner), null);
});

test('signalGroup: win32 calls taskkill /PID /F (no /T) + fallback; POSIX signals -pid', () => {
  const calls = [];
  signalGroup(
    4321,
    'SIGTERM',
    (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    },
    'win32'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '4321', '/F']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.stdio, 'ignore');

  const origKill = process.kill;
  let fallbackPid = null;
  process.kill = (pid) => {
    fallbackPid = pid;
  };
  try {
    signalGroup(4321, 'SIGTERM', () => ({ status: 1 }), 'win32');
    assert.equal(fallbackPid, 4321);
  } finally {
    process.kill = origKill;
  }

  let posixTarget = null;
  let posixSignal = null;
  process.kill = (pid, sig) => {
    posixTarget = pid;
    posixSignal = sig;
  };
  try {
    signalGroup(4321, 'SIGTERM', spawnSync, 'darwin');
    assert.equal(posixTarget, -4321);
    assert.equal(posixSignal, 'SIGTERM');
  } finally {
    process.kill = origKill;
  }
});

test('parseBorn & bornAfterParent: orders ISO-8601, WMIC, and legacy stamps on 100ns scale', () => {
  const utc = parseBorn('2026-09-13T11:33:32.5460000+00:00');
  assert.equal(utc, 17892992125460000n);
  assert.equal(parseBorn('2026-09-13T19:33:32.5460000+08:00'), utc);
  assert.equal(parseBorn('2026-09-13T11:33:32.5460000Z'), utc);
  assert.equal(parseBorn('2026-09-13T11:33:32.5460001+00:00'), utc + 1n);
  assert.equal(parseBorn('20260913113332.546000+000'), utc);
  assert.equal(parseBorn('20260913193332.546000+480'), utc);
  assert.equal(
    parseBorn('9/13/2026 11:33:32 AM'),
    BigInt(Date.parse('9/13/2026 11:33:32 AM')) * 10_000n
  );
  assert.equal(parseBorn('unknown'), null);
  assert.equal(parseBorn(''), null);
  assert.equal(parseBorn(undefined), null);

  assert.equal(
    bornAfterParent({ born: 'unknown' }, { born: '2026-09-13T11:33:32.5460000+00:00' }),
    true
  );
  assert.equal(
    bornAfterParent({ born: '2026-09-13T11:33:32.5460000+00:00' }, { born: 'unknown' }),
    true
  );
  assert.equal(
    bornAfterParent(
      { born: '2026-09-13T11:33:33.9999999+00:00' },
      { born: '2026-09-13T11:33:34.0000000+00:00' }
    ),
    false
  );
});

test('tree: prunes an orphan born before its reused parent PID while keeping real children', () => {
  const root = { pid: 100, parent: 1, group: 100, born: '2026-09-13T11:33:34.0000000+00:00' };
  const orphan = { pid: 200, parent: 100, group: 200, born: '2026-09-13T11:33:33.9999999+00:00' };
  const orphanChild = {
    pid: 500,
    parent: 200,
    group: 500,
    born: '2026-09-13T11:33:36.0000000+00:00',
  };
  const child = { pid: 300, parent: 100, group: 300, born: '2026-09-13T11:33:34.0000000+00:00' };
  const grandChild = {
    pid: 400,
    parent: 300,
    group: 400,
    born: '2026-09-13T11:33:35.0000000+00:00',
  };
  const rows = [root, orphan, orphanChild, child, grandChild];

  assert.deepEqual(
    tree(100, rows).map((r) => r.pid),
    [300, 400]
  );
  assert.deepEqual(
    tree(
      100,
      rows.map((r) => ({ ...r, born: 'unknown' }))
    ).map((r) => r.pid),
    [200, 500, 300, 400]
  );
  assert.deepEqual(tree(999, [root, child]), []);
});

test(
  'stopExecution: real orphan behind a reused ParentProcessId survives root cleanup',
  { timeout: 60000 },
  async (t) => {
    const killSafe = (pid) => {
      if (!pid) return;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    };

    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    orphan.unref();
    t.after(() => killSafe(orphan.pid));

    const orphanIdentity = await waitForIdentity(orphan.pid);
    assert.ok(orphanIdentity, 'orphan must be visible in the process table');

    // POSIX ps reports birth at second granularity; make the root strictly younger.
    await pause(1100);
    const rootScript =
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], " +
      "{ stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000);";
    const root = spawn(process.execPath, ['-e', rootScript], {
      stdio: 'ignore',
      windowsHide: true,
    });
    t.after(() => killSafe(root.pid));

    const { rootIdentity, child } = await waitForRootAndChild(root.pid);
    t.after(() => killSafe(child?.pid));
    assert.ok(rootIdentity && child, 'root and its real child must be visible in process table');
    assert.ok(bornAfterParent(child, rootIdentity), 'real child must be born after its parent');

    const staleLink = (rows) =>
      rows?.map((row) => (row.pid === orphan.pid ? { ...row, parent: root.pid } : row)) ?? null;
    const members = tree(root.pid, staleLink(processTable())).map((row) => row.pid);
    assert.ok(members.includes(child.pid), `real child ${child.pid} must be a descendant`);
    assert.ok(!members.includes(orphan.pid), `orphan ${orphan.pid} must not be a descendant`);

    await stopExecution(rootIdentity, [], () => staleLink(processTable()));
    for (let i = 0; i < 50 && (alive(root.pid) || alive(child.pid)); i++) await pause(100);
    assert.equal(alive(root.pid), false, 'root must be stopped');
    assert.equal(alive(child.pid), false, 'real child must be stopped');
    assert.equal(alive(orphan.pid), true, 'unrelated orphan must survive');
  }
);
