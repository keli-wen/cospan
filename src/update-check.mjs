import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILTIN_CONFIG, cospanHomeDir } from './config.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SELF_DIR, '..');
const DEFAULT_COSPAN_BIN = path.join(REPO_ROOT, 'bin', 'cospan.mjs');
export const DEFAULT_UPDATE_URL =
  'https://raw.githubusercontent.com/keli-wen/cospan/master/package.json';
export const DEFAULT_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 1500;

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.1.3';
  } catch {
    return '0.1.3';
  }
}

export const PACKAGE_VERSION = readPackageVersion();

const KNOWN_LEGACY_DEFAULTS = {
  'mappings.codex.astra': ['gpt-6-astra', 'gpt-6.1-astra'],
  'mappings.codex.sol': ['gpt-6.1-sol'],
  'defaults.codex.model': ['gpt-6.1-sol'],
  'defaults.codex.askModel': ['gpt-6.1-sol'],
};

function parseSemver(raw) {
  const clean = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(clean);
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] || '',
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i] ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

export function updateCheckCachePath() {
  return path.join(cospanHomeDir(), 'update-check.json');
}

export function isUpdateCheckDisabled(config = null) {
  const envVal = String(process.env.COSPAN_NO_UPDATE_CHECK || '').toLowerCase();
  if (envVal === '1' || envVal === 'true') return true;
  return config?.updateCheck === false;
}

function shouldSkipNetworkForEnv(url) {
  if (process.env.COSPAN_UPDATE_URL || (url && url !== DEFAULT_UPDATE_URL)) return false;
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.CI);
}

function resolveTtlMs(explicitTtlMs) {
  if (Number.isFinite(explicitTtlMs) && explicitTtlMs >= 0) return explicitTtlMs;
  const fromEnv = Number(process.env.COSPAN_UPDATE_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_UPDATE_TTL_MS;
}

export function readUpdateCache(cachePath = updateCheckCachePath()) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeUpdateCache(payload, cachePath = updateCheckCachePath()) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2) + '\n');
  } catch {}
}

function isCacheFresh(cache, ttlMs) {
  if (!cache?.checkedAt) return false;
  const ts = Date.parse(cache.checkedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < ttlMs;
}

function buildUpdateResult({
  ok,
  latestVersion = null,
  cached = false,
  skipped = false,
  reason = null,
  error = null,
  checkedAt = null,
}) {
  const updateAvailable = Boolean(
    latestVersion && compareSemver(latestVersion, PACKAGE_VERSION) > 0
  );
  return {
    ok,
    current_version: PACKAGE_VERSION,
    latest_version: latestVersion,
    update_available: updateAvailable,
    cached,
    skipped,
    ...(reason ? { reason } : {}),
    ...(error ? { error } : {}),
    ...(checkedAt ? { checked_at: checkedAt } : {}),
  };
}

async function fetchRemoteVersion(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': `cospan/${PACKAGE_VERSION}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const version = typeof data?.version === 'string' ? data.version.trim() : '';
    if (!parseSemver(version)) throw new Error('missing valid version in remote package.json');
    return version;
  } finally {
    clearTimeout(timer);
  }
}

function cachedCheckResult(cache) {
  return buildUpdateResult({
    ok: !cache.error,
    latestVersion: cache.latestVersion || null,
    cached: true,
    error: cache.error || null,
    checkedAt: cache.checkedAt,
  });
}

function skippedCheckResult(cache, reason) {
  return buildUpdateResult({
    ok: false,
    latestVersion: cache?.latestVersion || null,
    cached: Boolean(cache?.latestVersion),
    skipped: true,
    reason,
    checkedAt: cache?.checkedAt || null,
  });
}

function resolveNetworkSkipReason(offline, fetchImpl, url) {
  if (offline) return 'offline';
  if (shouldSkipNetworkForEnv(url)) return 'test-env';
  if (typeof fetchImpl !== 'function') return 'no-fetch';
  return null;
}

async function performNetworkCheck({ cache, cachePath, url, timeoutMs, fetchImpl }) {
  const now = new Date().toISOString();
  try {
    const latestVersion = await fetchRemoteVersion(url, timeoutMs, fetchImpl);
    writeUpdateCache({ ...(cache || {}), checkedAt: now, latestVersion, error: null }, cachePath);
    return buildUpdateResult({ ok: true, latestVersion, checkedAt: now });
  } catch (err) {
    const message = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    const prevLatest = cache?.latestVersion || null;
    writeUpdateCache(
      { ...(cache || {}), checkedAt: now, latestVersion: prevLatest, error: message },
      cachePath
    );
    return buildUpdateResult({
      ok: false,
      latestVersion: prevLatest,
      error: message,
      checkedAt: now,
    });
  }
}

export async function checkForUpdate(opts = {}) {
  const { force = false, offline = false, config = null, fetchImpl = globalThis.fetch } = opts;
  if (isUpdateCheckDisabled(config)) {
    return buildUpdateResult({ ok: false, skipped: true, reason: 'disabled' });
  }
  const cachePath = opts.cachePath || updateCheckCachePath();
  const cache = readUpdateCache(cachePath);
  if (!force && isCacheFresh(cache, resolveTtlMs(opts.ttlMs))) {
    return cachedCheckResult(cache);
  }
  const url = opts.url || process.env.COSPAN_UPDATE_URL || DEFAULT_UPDATE_URL;
  const skipReason = resolveNetworkSkipReason(offline, fetchImpl, url);
  if (skipReason) return skippedCheckResult(cache, skipReason);

  const timeoutMs =
    opts.timeoutMs || Number(process.env.COSPAN_UPDATE_TIMEOUT_MS) || DEFAULT_FETCH_TIMEOUT_MS;
  return performNetworkCheck({ cache, cachePath, url, timeoutMs, fetchImpl });
}

export function triggerBackgroundUpdateCheck({
  config = null,
  ttlMs,
  binPath = DEFAULT_COSPAN_BIN,
  cachePath = updateCheckCachePath(),
} = {}) {
  if (isUpdateCheckDisabled(config) || shouldSkipNetworkForEnv()) return false;
  const cache = readUpdateCache(cachePath);
  if (isCacheFresh(cache, resolveTtlMs(ttlMs))) return false;
  try {
    const child = spawn(process.execPath, [binPath, '_update_check'], {
      cwd: os.tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function consumeCachedUpdateNotice({
  config = null,
  cooldownMs = DEFAULT_NOTIFY_COOLDOWN_MS,
  cachePath = updateCheckCachePath(),
} = {}) {
  if (isUpdateCheckDisabled(config)) return null;
  const cache = readUpdateCache(cachePath);
  if (!cache?.latestVersion) return null;
  if (compareSemver(cache.latestVersion, PACKAGE_VERSION) <= 0) return null;

  const sameVersion = cache.lastNotifiedVersion === cache.latestVersion;
  const notifiedTs = Date.parse(cache.lastNotifiedAt || '');
  if (sameVersion && Number.isFinite(notifiedTs) && Date.now() - notifiedTs < cooldownMs) {
    return null;
  }

  writeUpdateCache(
    {
      ...cache,
      lastNotifiedVersion: cache.latestVersion,
      lastNotifiedAt: new Date().toISOString(),
    },
    cachePath
  );
  return (
    `[cospan] update available: ${PACKAGE_VERSION} -> ${cache.latestVersion}. ` +
    `Run \`cospan doctor\` for upgrade steps.`
  );
}

function readBuiltinByDottedKey(dotted) {
  let cur = BUILTIN_CONFIG;
  for (const part of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function detectStaleConfigOverrides(overrides = {}) {
  const findings = [];
  for (const [key, legacyValues] of Object.entries(KNOWN_LEGACY_DEFAULTS)) {
    const info = overrides[key];
    if (!info) continue;
    const builtinValue = readBuiltinByDottedKey(key);
    if (builtinValue === undefined || info.value === builtinValue) continue;
    if (!legacyValues.includes(info.value)) continue;
    findings.push({
      key,
      current_value: info.value,
      builtin_value: builtinValue,
      scope: info.scope,
      source: info.source,
    });
  }
  return findings;
}

export function formatUpdateStatusLine(info) {
  if (!info) return 'skipped';
  if (info.skipped) {
    return info.latest_version && info.update_available
      ? `AVAILABLE ${info.current_version} -> ${info.latest_version} (cached)`
      : `skipped (${info.reason || 'disabled'})`;
  }
  if (!info.ok) {
    return info.update_available
      ? `AVAILABLE ${info.current_version} -> ${info.latest_version} ` +
          `(cached; error: ${info.error})`
      : `check failed (${info.error || 'offline'})`;
  }
  if (info.update_available) {
    return `AVAILABLE ${info.current_version} -> ${info.latest_version}`;
  }
  return `UP TO DATE (${info.current_version})`;
}
