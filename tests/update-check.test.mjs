import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkForUpdate,
  compareSemver,
  consumeCachedUpdateNotice,
  detectStaleConfigOverrides,
  PACKAGE_VERSION,
  readUpdateCache,
} from '../src/update-check.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const COSPAN_BIN = path.join(ROOT_DIR, 'bin', 'cospan.mjs');
const MCP_SERVER = path.join(ROOT_DIR, 'src', 'mcp', 'cospan-mcp.mjs');
const FAKE_AGY = path.join(TEST_DIR, 'fakes', 'fake-agy.mjs');

function makeTempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-upd-'));
  const home = path.join(base, 'cospan-home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  return { base, home, repo };
}

function startJsonServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/package.json` });
    });
  });
}

test('all plugin manifests share the exact PACKAGE_VERSION', () => {
  const manifestPaths = [
    'package.json',
    '.antigravity-plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'dsh/package.json',
  ];
  for (const rel of manifestPaths) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8'));
    assert.equal(data.version, PACKAGE_VERSION, `${rel} version must match package.json`);
  }
});

test('compareSemver orders stable and pre-release versions accurately', () => {
  assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('0.1.0', '0.1.1'), -1);
  assert.equal(compareSemver('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(compareSemver('0.2.0-rc.1', '0.1.0'), 1);
});

test('checkForUpdate uses HTTP server, respects TTL cache, and handles opt-out', async () => {
  const { base, home } = makeTempEnv();
  let hits = 0;
  const { server, url } = await startJsonServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'cospan', version: '0.2.0' }));
  });
  const cachePath = path.join(home, 'update-check.json');
  try {
    const first = await checkForUpdate({ url, cachePath, ttlMs: 60_000 });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.latest_version, '0.2.0');
    assert.equal(first.update_available, true);
    assert.equal(hits, 1);

    const second = await checkForUpdate({ url, cachePath, ttlMs: 60_000 });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.update_available, true);
    assert.equal(hits, 1);

    const disabled = await checkForUpdate({ url, cachePath, config: { updateCheck: false } });
    assert.equal(disabled.skipped, true);
    assert.equal(disabled.reason, 'disabled');

    const notice1 = consumeCachedUpdateNotice({ cachePath, cooldownMs: 60_000 });
    assert.ok(notice1.includes(`update available: ${PACKAGE_VERSION} -> 0.2.0`));
    const notice2 = consumeCachedUpdateNotice({ cachePath, cooldownMs: 60_000 });
    assert.equal(notice2, null);
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function runCospanAsync(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COSPAN_BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('doctor, send, and MCP surface update notices and stale legacy config overrides', async () => {
  const { base, home, repo } = makeTempEnv();
  const { server, url } = await startJsonServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'cospan', version: '0.2.0' }));
  });

  try {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        mappings: { codex: { astra: 'gpt-6-astra', sol: 'gpt-6.1-sol' } },
      })
    );

    const stale = detectStaleConfigOverrides({
      'mappings.codex.astra': { value: 'gpt-6-astra', scope: 'global', source: 'x' },
    });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].builtin_value, 'gpt-6.2-astra');

    const env = {
      ...process.env,
      COSPAN_HOME: home,
      COSPAN_UPDATE_URL: url,
      AGY_BIN: FAKE_AGY,
    };

    const docRes = await runCospanAsync(['doctor', '--json'], { cwd: repo, env });
    assert.equal(docRes.status, 0, docRes.stderr);
    const docJson = JSON.parse(docRes.stdout);
    assert.equal(docJson.update.update_available, true);
    assert.equal(docJson.update.latest_version, '0.2.0');
    assert.equal(docJson.stale_overrides.length, 2);

    const cfgText = await runCospanAsync(['config'], { cwd: repo, env });
    assert.equal(cfgText.status, 0);
    assert.match(cfgText.stdout, /cospan config --init --global --force/);

    const send1 = await runCospanAsync(
      ['send', '--to', 'agy', '--readonly', '--prompt', 'hello', '--json'],
      { cwd: repo, env }
    );
    assert.equal(send1.status, 0, send1.stderr);
    const send1Id = JSON.parse(send1.stdout).job_id;
    assert.ok(send1Id);
    assert.ok(send1.stderr.includes(`[cospan] update available: ${PACKAGE_VERSION} -> 0.2.0`));

    const send2 = await runCospanAsync(
      ['send', '--to', 'agy', '--readonly', '--prompt', 'hello again', '--json'],
      { cwd: repo, env }
    );
    assert.equal(send2.status, 0, send2.stderr);
    const send2Id = JSON.parse(send2.stdout).job_id;
    assert.doesNotMatch(send2.stderr, /update available/);

    const cache = readUpdateCache(path.join(home, 'update-check.json'));
    fs.writeFileSync(
      path.join(home, 'update-check.json'),
      JSON.stringify({ ...cache, lastNotifiedAt: null, lastNotifiedVersion: null })
    );

    const mcp = spawn(process.execPath, [MCP_SERVER], { cwd: repo, env });
    const pending = new Map();
    let buf = '';
    mcp.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    let mcpJobId = null;
    try {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const call = await rpc('tools/call', {
        name: 'cospan_send',
        arguments: { cwd: repo, to: 'agy', readonly: true, prompt: 'MCP update smoke' },
      });
      assert.equal(call.result.isError, false);
      mcpJobId = JSON.parse(call.result.content[0].text).job_id;
      assert.ok(mcpJobId);
      assert.ok(
        (call.result.content[1]?.text || '').includes(
          `update available: ${PACKAGE_VERSION} -> 0.2.0`
        )
      );
    } finally {
      mcp.kill('SIGTERM');
    }

    for (const id of [send1Id, send2Id, mcpJobId].filter(Boolean)) {
      await runCospanAsync(['wait', id, '--timeout', '10s'], { cwd: repo, env });
    }

    const reset = await runCospanAsync(['config', '--init', '--global', '--force'], {
      cwd: repo,
      env,
    });
    assert.equal(reset.status, 0);
    const afterDoc = await runCospanAsync(['doctor', '--offline', '--json'], { cwd: repo, env });
    assert.equal(afterDoc.status, 0);
    assert.equal(JSON.parse(afterDoc.stdout).stale_overrides.length, 0);
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
