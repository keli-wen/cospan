#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server for `cospan`.
 *
 * Supports both MCP standard newline-delimited JSON-RPC 2.0 and LSP-style
 * `Content-Length` framed JSON-RPC 2.0 automatically.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callTool, TOOLS } from './tools.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveCospanBin() {
  if (process.env.COSPAN_BIN) return process.env.COSPAN_BIN;
  try {
    const runtimeJson = JSON.parse(
      fs.readFileSync(path.join(SELF_DIR, 'cospan-runtime.json'), 'utf8')
    );
    if (runtimeJson?.cospanBin && fs.existsSync(runtimeJson.cospanBin))
      return runtimeJson.cospanBin;
  } catch {}
  return path.resolve(SELF_DIR, '..', '..', 'bin', 'cospan.mjs');
}

function resolvePackageVersion() {
  try {
    const pkgPath = path.resolve(SELF_DIR, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch {}
  return '0.1.1';
}

const COSPAN_BIN = resolveCospanBin();
const COSPAN_VERSION = resolvePackageVersion();

let framingMode = 'jsonl';
let clientCallerHost = null;

function triggerUpdateCheckOnce() {
  const disabled = ['1', 'true'].includes(
    String(process.env.COSPAN_NO_UPDATE_CHECK || '').toLowerCase()
  );
  if (disabled) return;
  if (!process.env.COSPAN_UPDATE_URL && (process.env.NODE_TEST_CONTEXT || process.env.CI)) return;
  try {
    const child = spawn(process.execPath, [COSPAN_BIN, '_update_check'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function sendMessage(msg) {
  const payload = JSON.stringify(msg);
  if (framingMode === 'content-length') {
    const byteLen = Buffer.byteLength(payload, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

const RPC_METHODS = {
  initialize(params) {
    const clientName = params?.clientInfo?.name;
    if (typeof clientName === 'string' && clientName.trim()) {
      clientCallerHost = clientName.trim();
    }
    triggerUpdateCheckOnce();
    const negotiated = params?.protocolVersion === '2025-03-26' ? '2025-03-26' : '2024-11-05';
    return {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'cospan', version: COSPAN_VERSION },
      instructions:
        'Use cospan_send + cospan_wait (always passing your workspace `cwd`) to delegate tasks ' +
        'to external headless harnesses (`agy`, `codex`, `claude`, `dsh`) and collect results ' +
        'cleanly without polling.',
    };
  },
  ping() {
    return {};
  },
  'tools/list'() {
    return { tools: TOOLS };
  },
  'tools/call'(params) {
    const env =
      !process.env.COSPAN_CALLER_HOST && clientCallerHost
        ? { COSPAN_CALLER_HOST: clientCallerHost }
        : null;
    return callTool(COSPAN_BIN, params?.name, params?.arguments || {}, { env });
  },
};

async function handleRpc(request) {
  if (!request || typeof request !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return;

  const { id, method, params } = request;
  const handler = Object.prototype.hasOwnProperty.call(RPC_METHODS, method)
    ? RPC_METHODS[method]
    : null;
  if (!handler) {
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
    return;
  }

  try {
    const result = await handler(params);
    sendMessage({ jsonrpc: '2.0', id, result });
  } catch (error) {
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code: error.code || -32603, message: error.message || 'Internal error' },
    });
  }
}

let buffer = Buffer.alloc(0);

function consumeContentLengthFrame() {
  framingMode = 'content-length';
  const sepIdx = buffer.indexOf('\r\n\r\n');
  if (sepIdx === -1) return false;
  const headerStr = buffer.subarray(0, sepIdx).toString('utf8');
  const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
  if (!match) {
    buffer = buffer.subarray(sepIdx + 4);
    return true;
  }
  const len = Number(match[1]);
  const bodyStart = sepIdx + 4;
  if (buffer.length < bodyStart + len) return false;
  const bodyStr = buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
  buffer = buffer.subarray(bodyStart + len);
  try {
    void handleRpc(JSON.parse(bodyStr));
  } catch {}
  return true;
}

function consumeJsonlFrame() {
  const nlIdx = buffer.indexOf(0x0a);
  if (nlIdx === -1) return false;
  const line = buffer.subarray(0, nlIdx).toString('utf8').trim();
  buffer = buffer.subarray(nlIdx + 1);
  if (line) {
    try {
      void handleRpc(JSON.parse(line));
    } catch {}
  }
  return true;
}

function drainBuffer() {
  while (buffer.length > 0) {
    const headerCheck = buffer.subarray(0, Math.min(buffer.length, 64)).toString('utf8');
    const progressed = /^Content-Length:/i.test(headerCheck)
      ? consumeContentLengthFrame()
      : consumeJsonlFrame();
    if (!progressed) return;
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drainBuffer();
});
