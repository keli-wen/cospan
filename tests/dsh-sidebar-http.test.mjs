import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyDshPlugin } from '../dsh/index.mjs';
import { cancelBoardJob, listWorkspaceBoard } from '../src/sidebar-state.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BIN = path.join(ROOT_DIR, 'bin', 'cospan.mjs');
const FAKE_CODEX = path.join(TEST_DIR, 'fakes', 'fake-codex.mjs');

async function withTwoWorkspaces(fn) {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-ctl-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-ctl-b-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-ctl-home-'));
  spawnSync('git', ['init', '-q', '-c', 'core.fsmonitor=false'], { cwd: repoA });
  spawnSync('git', ['init', '-q', '-c', 'core.fsmonitor=false'], { cwd: repoB });
  const prevHome = process.env.COSPAN_HOME;
  process.env.COSPAN_HOME = home;
  try {
    await fn({ repoA, repoB, home });
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    for (const dir of [repoA, repoB, home]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  }
}

function mountConnectionFetch(services = {}) {
  let registered = null;
  let disposed = false;
  let effectDispose = null;
  applyDshPlugin({
    inject(deps, fn) {
      if (deps[0] !== 'connection') return;
      fn({
        get: (name) => services[name],
        connection: {
          fetch: {
            register(route) {
              registered = route;
              return () => {
                disposed = true;
              };
            },
          },
        },
        effect(factory) {
          effectDispose = factory();
        },
      });
    },
  });
  return {
    route: registered,
    dispose: () => effectDispose?.(),
    isDisposed: () => disposed,
  };
}

function postJson(route, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return route.fetch(
    new Request('http://127.0.0.1/api/cospan/ctl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
  );
}

function launchHangingJob(cwd, home, sessionId) {
  const res = spawnSync(
    process.execPath,
    [BIN, 'send', '--to', 'codex', '--json', '--prompt', `Job for ${sessionId}`],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        COSPAN_HOME: home,
        COSPAN_CONFIG_DIR: home,
        CODEX_BIN: FAKE_CODEX,
        FAKE_CODEX_HANG: '1',
        COSPAN_CALLER_HOST: 'dsh',
        COSPAN_CALLER_SESSION_ID: sessionId,
      },
    }
  );
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).job_id;
}

test('DSH /api/cospan/ctl registers via connection.fetch and isolates sessions', async () => {
  await withTwoWorkspaces(async ({ repoA, repoB, home }) => {
    const jobA = launchHangingJob(repoA, home, 'sess-a');
    const jobB = launchHangingJob(repoB, home, 'sess-b');
    const sessions = new Map([
      ['sess-a', { id: 'sess-a', header: { cwd: repoA } }],
      ['sess-dirless', { id: 'sess-dirless', header: {} }],
    ]);
    const mounted = mountConnectionFetch({
      sessions,
      // Even if workingDirectory.get falls back to repoB, dirless sessions must NOT read repoB
      workingDirectory: { defaultDirectory: repoB, get: (s) => s.header?.cwd || repoB },
      sandboxPolicy: { workspaceRoot: repoB },
      sessionPersistence: {
        stat: async (id) => (id === 'sess-b' ? { header: { cwd: repoB } } : undefined),
      },
    });

    try {
      assert.equal(mounted.route.path, '/api/cospan/ctl');
      assert.deepEqual(mounted.route.methods, ['POST']);
      assert.equal(mounted.route.requestBody, 'buffered');

      const listRes = await postJson(mounted.route, { sessionId: 'sess-a', action: 'list' });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.headers.get('cache-control'), 'no-store');
      const listJson = await listRes.json();
      assert.equal(listJson.jobs[0].id, jobA);
      assert.equal(listJson.jobs[0].caller_match, true);

      const persistedRes = await postJson(mounted.route, { sessionId: 'sess-b', action: 'list' });
      assert.equal(persistedRes.status, 200);
      assert.equal((await persistedRes.json()).jobs[0].id, jobB);

      const detailRes = await postJson(mounted.route, {
        sessionId: 'sess-a',
        action: 'detail',
        id: jobA,
      });
      assert.equal(detailRes.status, 200);
      assert.equal((await detailRes.json()).job_id, jobA);

      // Directory-less live session and unknown session must return 404 (never fall back to repoB)
      const dirlessRes = await postJson(mounted.route, {
        sessionId: 'sess-dirless',
        action: 'list',
      });
      assert.equal(dirlessRes.status, 404);
      const unknownRes = await postJson(mounted.route, {
        sessionId: 'unknown-session',
        action: 'cancel',
        id: jobB,
      });
      assert.equal(unknownRes.status, 404);

      // Cross-workspace cancel must fail and leave jobB running
      const crossRes = await postJson(mounted.route, {
        sessionId: 'sess-a',
        action: 'cancel',
        id: jobB,
      });
      assert.equal(crossRes.status, 404);
      assert.equal(listWorkspaceBoard(repoB).jobs[0].status, 'running');

      // Malformed bodies return 400
      assert.equal((await postJson(mounted.route, 'not-json')).status, 400);
      assert.equal((await postJson(mounted.route, [])).status, 400);
      assert.equal((await postJson(mounted.route, { action: 'list' })).status, 400);

      // Same-workspace cancel succeeds
      const okCancel = await postJson(mounted.route, {
        sessionId: 'sess-a',
        action: 'cancel',
        id: jobA,
      });
      assert.equal(okCancel.status, 200);
      assert.equal((await okCancel.json()).status, 'canceled');

      assert.equal(mounted.isDisposed(), false);
      mounted.dispose();
      assert.equal(mounted.isDisposed(), true);
    } finally {
      await cancelBoardJob(repoA, jobA);
      await cancelBoardJob(repoB, jobB);
    }
  });
});

test('DSH client bundle posts to api/cospan/ctl and rejects HTML 200 fallbacks', async () => {
  const clientCode = fs.readFileSync(path.join(ROOT_DIR, 'dsh', 'client.js'), 'utf8');
  assert.doesNotMatch(clientCode, /remote\.commands\.execute/);
  assert.doesNotMatch(clientCode, /\/cospan-ctl/);
  assert.match(clientCode, /['"]api\/cospan\/ctl['"]/);

  let capturedAdapter = null;
  let capturedReq = null;
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  let loaded = null;
  let firstRef = true;
  globalThis.document = undefined;
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        loaded = def.factory(() => ({
          Fragment: 'Fragment',
          Component: class {},
          createElement: (type, props, ...children) => ({ type, props, children }),
          useCallback: (fn) => fn,
          useRef: (v) => {
            if (firstRef) {
              firstRef = false;
              return { current: { textContent: '' } };
            }
            return { current: v };
          },
          useEffect: (fn) => fn(),
        }));
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    capturedReq = { url, init };
    return new Response('<html>fallback</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  globalThis.__cospanCap = (adapter) => {
    capturedAdapter = adapter;
  };
  try {
    const stubMount = '(globalThis.__cospanCap(adapter), { destroy() {} })';
    new Function(clientCode.replace('CospanBoard.mount(node, adapter)', stubMount))();
    let SidebarBody = null;
    loaded.apply({
      effect: (fn) => fn(),
      sidebarRightTabs: { register: () => {} },
      sidebarRight: {},
      slots: {
        inject: (_s, cb) => cb(),
        register: (meta, comp) => {
          if (meta.name === 'sidebar.right.pane.tab') SidebarBody = comp;
        },
      },
    });
    SidebarBody({ sessionId: 'sess-1' }).children[0].type({ sessionId: 'sess-1' });
    assert.ok(capturedAdapter);
    await assert.rejects(() => capturedAdapter.fetchBoard({ scope: 'workspace' }), /non-JSON/i);
    assert.equal(capturedReq.url, 'api/cospan/ctl');
    assert.equal(capturedReq.init.method, 'POST');
    assert.deepEqual(JSON.parse(capturedReq.init.body), {
      sessionId: 'sess-1',
      action: 'list',
      scope: 'workspace',
    });
  } finally {
    delete globalThis.__cospanCap;
    Object.assign(globalThis, saved);
  }
});
