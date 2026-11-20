import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildChildEnv,
  FAKE_FILES,
  makeTempGitRepo,
  rmTree,
  ROOT_DIR,
  runCospan,
  spawnTracked,
  WIN_ONLY,
} from './windows-helpers.mjs';

test(
  'win32 CreateProcessW ceiling: agy handles 40 KiB prompt via --prompt-file without ENAMETOOLONG',
  WIN_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-win-40k-'));
    try {
      const repo = makeTempGitRepo(root);
      const home = path.join(root, 'cospan-home');
      fs.mkdirSync(home, { recursive: true });
      const bigPrompt = 'A'.repeat(40_000);
      const promptFile = path.join(root, 'prompt-40k.txt');
      fs.writeFileSync(promptFile, bigPrompt, 'utf8');

      const env = buildChildEnv({
        AGY_BIN: FAKE_FILES.agy,
        COSPAN_HOME: home,
        COSPAN_CONFIG_DIR: home,
        COSPAN_NO_UPDATE_CHECK: '1',
      });
      const sendRes = runCospan(
        ['send', '--to', 'agy', '--raw', '--prompt-file', promptFile, '--json'],
        { cwd: repo, env }
      );
      assert.equal(sendRes.code, 0, sendRes.stderr);
      const { job_id: jobId } = JSON.parse(sendRes.stdout);

      const waitRes = runCospan(['wait', jobId, '--timeout', '30s'], { cwd: repo, env });
      assert.equal(
        waitRes.code,
        0,
        `agy 40KiB job failed (code ${waitRes.code}):\n${waitRes.stdout}\n${waitRes.stderr}`
      );
      const marker = 'prompt_echo=';
      const idx = waitRes.stdout.indexOf(marker);
      assert.ok(idx >= 0, 'expected prompt_echo= in agy deliverable');
      const echoed = waitRes.stdout.slice(idx + marker.length).trimEnd();
      assert.equal(echoed.length, bigPrompt.length);
      assert.equal(echoed, bigPrompt);
    } finally {
      rmTree(root);
    }
  }
);

test(
  'win32 NTFS lock resilience: updateState fails instead of wiping state.json under exclusive lock',
  WIN_ONLY,
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-win-lock-'));
    t.after(() => rmTree(root));

    const repo = makeTempGitRepo(root);
    const home = path.join(root, 'cospan-home');
    fs.mkdirSync(home, { recursive: true });
    const jobStoreUrl = pathToFileURL(path.join(ROOT_DIR, 'src', 'job-store.mjs')).href;
    const childEnv = buildChildEnv({ COSPAN_HOME: home, COSPAN_CONFIG_DIR: home });

    const seedScript = [
      "import path from 'node:path';",
      `import { updateState, workspaceStateDir } from ${JSON.stringify(jobStoreUrl)};`,
      `const repo = ${JSON.stringify(repo)};`,
      'updateState((s) => {',
      "  s.jobs.push({ id: 'win-lock-initial-001', target: 'agy', status: 'done' });",
      '}, repo);',
      "process.stdout.write(path.join(workspaceStateDir(repo), 'state.json'));",
    ].join('\n');
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', seedScript], {
      cwd: repo,
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(seed.status, 0, seed.stderr);
    const stateFile = seed.stdout.trim();
    const initial = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(initial.jobs.length, 1);

    const updateScript = [
      `import { updateState } from ${JSON.stringify(jobStoreUrl)};`,
      "process.stdout.write('NODE_READY\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.once('data', () => {",
      '  let sawJobs = null;',
      '  try {',
      '    updateState((s) => {',
      '      sawJobs = s.jobs.length;',
      "      s.jobs.push({ id: 'win-lock-second-002', target: 'agy', status: 'done' });",
      `    }, ${JSON.stringify(repo)});`,
      "    process.stdout.write('RESULT:' + JSON.stringify({ threw: false, sawJobs }) + '\\n');",
      '  } catch (err) {',
      '    const out = { threw: true, code: err.code || null, sawJobs };',
      "    process.stdout.write('RESULT:' + JSON.stringify(out) + '\\n');",
      '  }',
      '  process.exit(0);',
      '});',
    ].join('\n');

    const updater = spawnTracked(process.execPath, ['--input-type=module', '-e', updateScript], {
      cwd: repo,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      try {
        updater.child.kill();
      } catch {}
    });
    await updater.waitForStdout('NODE_READY');

    const psCmd =
      "$fs = [System.IO.File]::Open($env:LOCK_TARGET, 'Open', 'ReadWrite', 'None'); " +
      "[Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); " +
      'Start-Sleep -Milliseconds 1200; $fs.Close()';
    const locker = spawnTracked(
      'powershell',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psCmd],
      {
        env: buildChildEnv({ LOCK_TARGET: stateFile }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    t.after(() => {
      try {
        locker.child.kill();
      } catch {}
    });
    await locker.waitForStdout('LOCKED');

    updater.child.stdin.end('GO\n');
    const [updateRes, lockRes] = await Promise.all([updater.exited, locker.exited]);
    assert.equal(lockRes.code, 0, lockRes.stderr);
    assert.equal(updateRes.code, 0, updateRes.stderr);

    const resultLine = updateRes.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT:'));
    assert.ok(resultLine, `expected RESULT line, got: ${updateRes.stdout}`);
    const result = JSON.parse(resultLine.slice('RESULT:'.length));
    assert.equal(result.threw, true, 'updateState must fail rather than succeed with wiped state');
    assert.equal(result.sawJobs, null, 'mutator must not run on empty state when loadState fails');

    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(after.jobs.length, 1, 'state.json must retain original job record after unlock');
    assert.equal(after.jobs[0].id, 'win-lock-initial-001');
  }
);

test('CRLF resilience: buildDshClientBundle strips globalThis footer on CRLF input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-win-crlf-'));
  try {
    const uiDir = path.join(root, 'src', 'ui');
    const dshDir = path.join(root, 'dsh');
    fs.mkdirSync(uiDir, { recursive: true });
    fs.mkdirSync(dshDir, { recursive: true });

    const toCrlf = (text) => text.replace(/\r?\n/g, '\r\n');
    fs.copyFileSync(
      path.join(ROOT_DIR, 'src', 'ui', 'sync-dsh-client.mjs'),
      path.join(uiDir, 'sync-dsh-client.mjs')
    );
    fs.writeFileSync(
      path.join(uiDir, 'cospan-board.css'),
      toCrlf(fs.readFileSync(path.join(ROOT_DIR, 'src', 'ui', 'cospan-board.css'), 'utf8'))
    );
    fs.writeFileSync(
      path.join(uiDir, 'cospan-board.js'),
      toCrlf(fs.readFileSync(path.join(ROOT_DIR, 'src', 'ui', 'cospan-board.js'), 'utf8'))
    );
    fs.writeFileSync(
      path.join(dshDir, 'client-bridge.js'),
      toCrlf(fs.readFileSync(path.join(ROOT_DIR, 'dsh', 'client-bridge.js'), 'utf8'))
    );

    const mod = await import(pathToFileURL(path.join(uiDir, 'sync-dsh-client.mjs')).href);
    const bundle = mod.buildDshClientBundle();
    assert.doesNotMatch(
      bundle,
      /if \(typeof globalThis !== 'undefined'\)/,
      'buildDshClientBundle must strip the globalThis footer even for CRLF cospan-board.js'
    );
    assert.doesNotMatch(bundle, /globalThis\.CospanBoard\s*=/);
  } finally {
    rmTree(root);
  }
});
