import path from 'node:path';
import { cancelBoardJob, listWorkspaceBoard, readBoardJobDetail } from '../src/sidebar-state.mjs';

export const COSPAN_HTTP_PREFIX = '/cospan';
export const COSPAN_REQUEST_HEADER = 'x-cospan-request';

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

function firstHeader(req, name) {
  const raw = req?.headers?.[name];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return typeof raw === 'string' ? raw.trim() : '';
}

function isLoopbackAddress(address) {
  const addr = String(address || '').trim();
  return (
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
  );
}

function isOriginMatchingHost(origin, host) {
  if (!origin) return true;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function checkRequestAdmission(ctx, req) {
  const connection = ctx?.get?.('connection');
  if (connection && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      const status = typeof rejection === 'number' ? rejection : 403;
      return { status, error: status === 401 ? 'Unauthorized.' : 'Forbidden.' };
    }
  } else {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      return { status: 403, error: 'Loopback requests only.' };
    }
    const origin = firstHeader(req, 'origin');
    const host = firstHeader(req, 'host');
    if (!isOriginMatchingHost(origin, host)) {
      return { status: 403, error: 'Cross-origin request rejected.' };
    }
  }

  const fetchSite = firstHeader(req, 'sec-fetch-site').toLowerCase();
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return { status: 403, error: 'Cross-site request rejected.' };
  }
  if (firstHeader(req, COSPAN_REQUEST_HEADER) !== '1') {
    return { status: 403, error: 'Missing required same-origin request header.' };
  }
  return null;
}

function normalizeAbsoluteCwd(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return trimmed;
}

function getService(ctx, serviceName) {
  return ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
}

function resolveLiveSessionCwd(ctx, id) {
  const sessions = getService(ctx, 'sessions');
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined;
  if (!session) return null;
  const wd = getService(ctx, 'workingDirectory');
  const fromWd = wd && typeof wd.get === 'function' ? wd.get(session) : undefined;
  const fromHeader = session.header ? session.header.cwd : undefined;
  return normalizeAbsoluteCwd(fromWd || fromHeader);
}

async function resolvePersistedSessionCwd(ctx, id) {
  const persistence = getService(ctx, 'sessionPersistence');
  if (!persistence || typeof persistence.stat !== 'function') return null;
  try {
    const stored = await persistence.stat(id);
    return normalizeAbsoluteCwd(stored && stored.header ? stored.header.cwd : undefined);
  } catch {
    return null;
  }
}

export async function resolveStrictSessionCwd(ctx, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  return resolveLiveSessionCwd(ctx, id) || resolvePersistedSessionCwd(ctx, id);
}

function isJsonContentType(req) {
  const mediaType = firstHeader(req, 'content-type').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

async function readBoundedJsonBody(req) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.resume?.();
        return { ok: false, status: 413, error: 'Request body too large.' };
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, error: 'Failed to read request body.' };
  }
  const text = Buffer.concat(chunks, total).toString('utf8').trim();
  if (!text) return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'Request body must be a JSON object.' };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON request body.' };
  }
}

async function resolveVerifiedSession(ctx, rawSessionId, res) {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: 'Missing sessionId.' });
    return null;
  }
  const cwd = await resolveStrictSessionCwd(ctx, sessionId);
  if (!cwd) {
    sendJson(res, 404, { ok: false, error: 'Unknown or unresolvable DSH session.' });
    return null;
  }
  return { sessionId, cwd };
}

async function handleBoardGet(ctx, url, res) {
  const verified = await resolveVerifiedSession(ctx, url.searchParams.get('sessionId'), res);
  if (!verified) return;
  const board = listWorkspaceBoard(verified.cwd, { callerSessionId: verified.sessionId });
  sendJson(res, 200, { ok: true, ...board });
}

async function handleDetailGet(ctx, url, res) {
  const verified = await resolveVerifiedSession(ctx, url.searchParams.get('sessionId'), res);
  if (!verified) return;
  const jobId = String(url.searchParams.get('id') || '').trim();
  if (!jobId) {
    sendJson(res, 400, { ok: false, error: 'Detail requires a job id.' });
    return;
  }
  const detail = readBoardJobDetail(verified.cwd, jobId);
  sendJson(res, detail.ok ? 200 : 404, detail);
}

async function handleCancelPost(ctx, req, res) {
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    return;
  }
  const bodyRes = await readBoundedJsonBody(req);
  if (!bodyRes.ok) {
    sendJson(res, bodyRes.status, { ok: false, error: bodyRes.error });
    return;
  }
  const verified = await resolveVerifiedSession(ctx, bodyRes.body.sessionId, res);
  if (!verified) return;
  const jobId = String(bodyRes.body.id || bodyRes.body.jobId || '').trim();
  if (!jobId) {
    sendJson(res, 400, { ok: false, error: 'Cancel requires a job id.' });
    return;
  }
  const owned = readBoardJobDetail(verified.cwd, jobId);
  if (!owned.ok) {
    sendJson(res, 404, { ok: false, job_id: jobId, error: owned.error });
    return;
  }
  const result = await cancelBoardJob(verified.cwd, jobId);
  sendJson(res, result.ok ? 200 : 400, result);
}

export function createCospanHttpHandler(ctx) {
  return async function handleCospanHttpRequest(req, res) {
    const denied = checkRequestAdmission(ctx, req);
    if (denied) {
      sendJson(res, denied.status, { ok: false, error: denied.error });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.startsWith(COSPAN_HTTP_PREFIX)
      ? url.pathname.slice(COSPAN_HTTP_PREFIX.length)
      : url.pathname;

    if (route === '/board') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      return handleBoardGet(ctx, url, res);
    }
    if (route === '/detail') {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
      return handleDetailGet(ctx, url, res);
    }
    if (route === '/cancel') {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
      return handleCancelPost(ctx, req, res);
    }
    sendJson(res, 404, { ok: false, error: `Unknown cospan route "${route}"` });
  };
}

export function registerCospanHttpApi(webCtx) {
  const handler = createCospanHttpHandler(webCtx);
  webCtx.effect(
    () =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: COSPAN_HTTP_PREFIX,
        handler,
      }),
    'cospan: sidebar HTTP API'
  );
}
