import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyDshPlugin } from '../dsh/index.mjs';
import { COSPAN_HTTP_PREFIX, COSPAN_REQUEST_HEADER } from '../dsh/http-api.mjs';
import { updateState } from '../src/job-store.mjs';
import { cancelBoardJob, listWorkspaceBoard } from '../src/sidebar-state.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BIN = path.join(ROOT_DIR, 'bin', 'cospan.mjs');
const FAKE_CODEX = path.join(TEST_DIR, 'fakes', 'fake-codex.mjs');

async function withTwoWorkspaces(fn) {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-http-a-'));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-http-b-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-http-home-'));
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

function createMockRequest({
  method = 'GET',
  url = '/cospan/board',
  headers = {},
  body = null,
  remoteAddress = '127.0.0.1',
} = {}) {
  const payload =
    body === null || body === undefined
      ? []
      : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req.socket = { remoteAddress };
  return req;
}

function createMockResponse() {
  const headers = new Map();
  let body = '';
  return {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(chunk = '') {
      if (chunk) body += String(chunk);
    },
    json() {
      return body ? JSON.parse(body) : null;
    },
  };
}

function mountDshWebServer(services = {}) {
  let registeredRoute = null;
  let routeDisposed = false;
  let effectDispose = null;
  applyDshPlugin({
    inject(deps, fn) {
      if (deps[0] !== 'webServer') return;
      fn({
        get: (name) => services[name],
        webServer: {
          register(route) {
            registeredRoute = route;
            return () => {
              routeDisposed = true;
            };
          },
        },
        effect(factory) {
          effectDispose = factory();
        },
      });
    },
  });
  return {
    route: registeredRoute,
    dispose: () => effectDispose?.(),
    isDisposed: () => routeDisposed,
  };
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

test('DSH webServer API serves board/detail/cancel with strict isolation', async () => {
  await withTwoWorkspaces(async ({ repoA, repoB, home }) => {
    const jobA = launchHangingJob(repoA, home, 'sess-a');
    const jobB = launchHangingJob(repoB, home, 'sess-b');
    const sessions = new Map([['sess-a', { id: 'sess-a', header: { cwd: repoA } }]]);
    const mounted = mountDshWebServer({
      sessions,
      workingDirectory: { defaultDirectory: repoB, get: (s) => s.header.cwd },
      sandboxPolicy: { workspaceRoot: repoB },
      sessionPersistence: {
        stat: async (id) => (id === 'sess-b' ? { header: { cwd: repoB } } : undefined),
      },
      connection: { requestRejection: () => undefined },
    });

    try {
      assert.equal(mounted.route.kind, 'prefix');
      assert.equal(mounted.route.path, COSPAN_HTTP_PREFIX);
      const authHeaders = { [COSPAN_REQUEST_HEADER]: '1', host: '127.0.0.1:4096' };

      const boardRes = createMockResponse();
      await mounted.route.handler(
        createMockRequest({ url: '/cospan/board?sessionId=sess-a', headers: authHeaders }),
        boardRes
      );
      assert.equal(boardRes.statusCode, 200);
      assert.equal(boardRes.getHeader('cache-control'), 'no-store');
      assert.equal(boardRes.json().jobs[0].id, jobA);
      assert.equal(boardRes.json().jobs[0].caller_match, true);

      const persistedRes = createMockResponse();
      await mounted.route.handler(
        createMockRequest({ url: '/cospan/board?sessionId=sess-b', headers: authHeaders }),
        persistedRes
      );
      assert.equal(persistedRes.statusCode, 200);
      assert.equal(persistedRes.json().jobs[0].id, jobB);

      const detailRes = createMockResponse();
      await mounted.route.handler(
        createMockRequest({
          url: `/cospan/detail?sessionId=sess-a&id=${encodeURIComponent(jobA)}`,
          headers: authHeaders,
        }),
        detailRes
      );
      assert.equal(detailRes.statusCode, 200);
      assert.equal(detailRes.json().job_id, jobA);

      // Invalid session must NOT fall back to repoB
      const invalidCancel = createMockResponse();
      await mounted.route.handler(
        createMockRequest({
          method: 'POST',
          url: '/cospan/cancel',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'unknown-session', id: jobB }),
        }),
        invalidCancel
      );
      assert.equal(invalidCancel.statusCode, 404);

      // Cross-workspace cancel must fail and leave jobB running
      const crossCancel = createMockResponse();
      await mounted.route.handler(
        createMockRequest({
          method: 'POST',
          url: '/cospan/cancel',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-a', id: jobB }),
        }),
        crossCancel
      );
      assert.equal(crossCancel.statusCode, 404);
      assert.equal(listWorkspaceBoard(repoB).jobs[0].status, 'running');

      // Valid same-workspace cancel succeeds
      const okCancel = createMockResponse();
      await mounted.route.handler(
        createMockRequest({
          method: 'POST',
          url: '/cospan/cancel',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'sess-a', id: jobA }),
        }),
        okCancel
      );
      assert.equal(okCancel.statusCode, 200);
      assert.equal(okCancel.json().status, 'canceled');

      // Route disposal unregisters handler cleanly
      assert.equal(mounted.isDisposed(), false);
      mounted.dispose();
      assert.equal(mounted.isDisposed(), true);
    } finally {
      await cancelBoardJob(repoA, jobA);
      await cancelBoardJob(repoB, jobB);
    }
  });
});

test('DSH webServer API enforces auth, CSRF headers, content-type, and bounds', async () => {
  await withTwoWorkspaces(async ({ repoA }) => {
    updateState((s) => {
      s.jobs.push({ id: 'job-1', target: 'codex', status: 'done' });
    }, repoA);
    const sessions = new Map([['sess-a', { id: 'sess-a', header: { cwd: repoA } }]]);
    const validHeaders = { [COSPAN_REQUEST_HEADER]: '1', host: '127.0.0.1:4096' };

    let rejectionCode = 401;
    const authMounted = mountDshWebServer({
      sessions,
      connection: { requestRejection: () => rejectionCode },
    });
    const r401 = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({ url: '/cospan/board?sessionId=sess-a', headers: validHeaders }),
      r401
    );
    assert.equal(r401.statusCode, 401);
    rejectionCode = undefined;

    const noHeader = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({ url: '/cospan/board?sessionId=sess-a', headers: { host: '127.0.0.1' } }),
      noHeader
    );
    assert.equal(noHeader.statusCode, 403);

    const crossSite = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({
        url: '/cospan/board?sessionId=sess-a',
        headers: { ...validHeaders, 'sec-fetch-site': 'cross-site' },
      }),
      crossSite
    );
    assert.equal(crossSite.statusCode, 403);

    const fallbackMounted = mountDshWebServer({ sessions });
    const remoteRes = createMockResponse();
    await fallbackMounted.route.handler(
      createMockRequest({
        url: '/cospan/board?sessionId=sess-a',
        headers: validHeaders,
        remoteAddress: '10.0.0.5',
      }),
      remoteRes
    );
    assert.equal(remoteRes.statusCode, 403);

    const badOrigin = createMockResponse();
    await fallbackMounted.route.handler(
      createMockRequest({
        url: '/cospan/board?sessionId=sess-a',
        headers: { ...validHeaders, origin: 'https://evil.example' },
      }),
      badOrigin
    );
    assert.equal(badOrigin.statusCode, 403);

    const wrongMethod = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({ method: 'POST', url: '/cospan/board', headers: validHeaders }),
      wrongMethod
    );
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.getHeader('allow'), 'GET');

    const badMedia = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({
        method: 'POST',
        url: '/cospan/cancel',
        headers: { ...validHeaders, 'content-type': 'text/plain' },
        body: '{}',
      }),
      badMedia
    );
    assert.equal(badMedia.statusCode, 415);

    const tooLarge = createMockResponse();
    await authMounted.route.handler(
      createMockRequest({
        method: 'POST',
        url: '/cospan/cancel',
        headers: { ...validHeaders, 'content-type': 'application/json' },
        body: 'x'.repeat(70 * 1024),
      }),
      tooLarge
    );
    assert.equal(tooLarge.statusCode, 413);
  });
});

test('DSH client bundle never calls /cospan-ctl or remote.commands.execute', () => {
  const clientCode = fs.readFileSync(path.join(ROOT_DIR, 'dsh', 'client.js'), 'utf8');
  assert.doesNotMatch(clientCode, /remote\.commands\.execute/);
  assert.doesNotMatch(clientCode, /\/cospan-ctl/);
  assert.match(clientCode, /X-Cospan-Request/);
  assert.match(clientCode, /DSH_IDLE_POLL_MS\s*=\s*30000/);
});
