import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { COSPAN_BIN, FAKE_FILES, MCP_SERVER, ROOT_DIR } from './paths.mjs';

export { COSPAN_BIN, FAKE_FILES, MCP_SERVER, ROOT_DIR };
export const TARGET_BIN_ENV_VARS = ['AGY_BIN', 'CODEX_BIN', 'CLAUDE_BIN', 'DSH_BIN'];
export const WIN_ONLY = { skip: process.platform !== 'win32', timeout: 60000 };

export function rmTree(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export function buildChildEnv(overrides = {}, unsetKeys = []) {
  const drop = new Set([...Object.keys(overrides), ...unsetKeys].map((k) => k.toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !drop.has(k.toUpperCase())) env[k] = v;
  }
  return { ...env, ...overrides };
}

export function makeTempGitRepo(parentDir) {
  const repo = path.join(parentDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo, windowsHide: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# temp repo\n');
  spawnSync('git', ['add', 'README.md'], { cwd: repo, windowsHide: true });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, windowsHide: true });
  return repo;
}

export function writeNpmCmdShim(binDir, name, scriptRelWinPath) {
  const shimPath = path.join(binDir, `${name}.cmd`);
  const content = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      `"%_prog%"  "%dp0%\\${scriptRelWinPath}" %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(shimPath, content, 'utf8');
  return shimPath;
}

export function createCmdShimFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = makeTempGitRepo(root);
  const home = path.join(root, 'cospan-home');
  const binDir = path.join(root, 'bin');
  const scriptsDir = path.join(binDir, 'scripts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  const shims = {};
  for (const [id, fakePath] of Object.entries(FAKE_FILES)) {
    const destScript = path.join(scriptsDir, `fake-${id}.mjs`);
    if (id === 'codex') {
      const wrapper = [
        'const argv = process.argv.slice(2);',
        "if (argv[0] === '--enable' && argv[1] === 'plugins' && argv[2] === 'plugin') {",
        "  process.stdout.write(`plugin-ok: ${argv.join(' ')}\\n`);",
        '  process.exit(0);',
        '}',
        `await import(${JSON.stringify(pathToFileURL(fakePath).href)});`,
        '',
      ].join('\n');
      fs.writeFileSync(destScript, wrapper, 'utf8');
    } else {
      fs.copyFileSync(fakePath, destScript);
    }
    shims[id] = writeNpmCmdShim(binDir, id, `scripts\\fake-${id}.mjs`);
  }

  const nodeDir = path.dirname(process.execPath);
  const env = buildChildEnv(
    {
      COSPAN_HOME: home,
      COSPAN_CONFIG_DIR: home,
      COSPAN_NO_UPDATE_CHECK: '1',
      USERPROFILE: home,
      PATH: [binDir, nodeDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    },
    TARGET_BIN_ENV_VARS
  );
  return { root, repo, home, binDir, shims, env };
}

export function runCospan(args, { cwd, env, input } = {}) {
  const r = spawnSync(process.execPath, [COSPAN_BIN, ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

export function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  let stdout = '';
  let stderr = '';
  const waiters = [];
  const flushWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (!stdout.includes(waiters[i].marker)) continue;
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve();
    }
  };
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    flushWaiters();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  const waitForStdout = (marker, timeoutMs = 15000) => {
    if (stdout.includes(marker)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for "${marker}": out=${stdout} err=${stderr}`));
      }, timeoutMs);
      waiters.push({ marker, resolve, timer });
    });
  };
  return { child, exited, waitForStdout };
}
