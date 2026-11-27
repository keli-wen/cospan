import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COSPAN_BIN, FAKE_FILES } from './paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX } = FAKE_FILES;

export async function withTempWorkspaces(count, fn) {
  const repos = [];
  for (let i = 0; i < count; i += 1) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `cospan-sidebar-${i}-`));
    const init = spawnSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(init.status, 0, init.stderr || 'git init failed');
    repos.push(repo);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-sidebar-home-'));
  const prevHome = process.env.COSPAN_HOME;
  process.env.COSPAN_HOME = home;
  let cleanupErr = null;
  try {
    await fn({ repos, home });
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    for (const dir of [...repos, home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        if (!cleanupErr) cleanupErr = err;
      }
    }
  }
  if (cleanupErr) throw cleanupErr;
}

export async function withTempWorkspace(fn) {
  return withTempWorkspaces(1, ({ repos, home }) => fn({ repo: repos[0], home }));
}

export function runCospanInHome(args, { cwd, home, env = {} }) {
  const r = spawnSync(process.execPath, [COSPAN_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
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

export function loadDshClientModule(clientCode, { runEffects = false, firstRefCurrent } = {}) {
  let loadedModule = null;
  let firstRef = true;
  const prevWin = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        assert.equal(def.id, 'cospan-dsh');
        loadedModule = def.factory((modName) => {
          assert.equal(modName, 'react');
          return {
            Fragment: 'Fragment',
            Component: class {},
            createElement: (type, props, ...children) => ({ type, props, children }),
            useCallback: (fn) => fn,
            useRef: (v) => {
              if (firstRef && firstRefCurrent !== undefined) {
                firstRef = false;
                return { current: firstRefCurrent };
              }
              return { current: v };
            },
            useEffect: runEffects ? (fn) => fn() : () => {},
          };
        });
      },
    },
  };
  try {
    new Function(clientCode)();
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
  return loadedModule;
}
