import fs from 'node:fs';
import { PACKAGE_VERSION } from './update-check.mjs';

export const MAX_INLINE_BYTES = 512 * 1024;
export const MAX_BACKGROUND_MS = 120 * 60 * 1000; // 120m ceiling
export const MAX_RETAINED_JOBS = 50;
export const DEFAULT_SEND_TIMEOUT = '60m';
export const DEFAULT_ASK_TIMEOUT = '2m';
export const DEFAULT_WAIT_TIMEOUT = '100s';

export const JOB_EXIT_CODES = {
  done: 0,
  running: 2,
  error: 3,
  crashed: 3,
  canceled: 4,
  attention: 5,
};

let inWorker = false;

export function setWorkerMode(active) {
  inWorker = Boolean(active);
}

export function die(msg, code = 1) {
  if (inWorker) throw new Error(msg);
  process.stderr.write(`cospan error: ${msg}\n`);
  throw Object.assign(new Error(msg), { exitCode: code, alreadyPrinted: true });
}

const DURATION_UNITS_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 3600 * 1000,
};

export function durationToMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return NaN;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) return NaN;
  const unit = (m[2] || 's').toLowerCase();
  return Math.round(Number(m[1]) * DURATION_UNITS_MS[unit]);
}

const VALUE_FLAGS = new Set([
  '--to',
  '--id',
  '--job',
  '--model',
  '--effort',
  '--timeout',
  '--prompt',
  '--prompt-file',
  '--host',
  '--config',
]);

const BOOL_FLAGS = new Set([
  '--readonly',
  '--restricted',
  '--unrestricted',
  '--full-access',
  '--raw',
  '--last',
  '--stdin',
  '--json',
  '--force',
  '--init',
  '--global',
  '--workspace',
  '--trajectory',
  '--no-codex-cli',
  '--check',
  '--ping',
  '--offline',
  '--help',
  '-h',
  '--version',
  '-v',
]);

const BOOL_FLAG_ALIASES = {
  '-h': 'help',
  '--help': 'help',
  '-v': 'version',
  '--version': 'version',
  '--no-codex-cli': 'noCodexCli',
  '--full-access': 'unrestricted',
  '--unrestricted': 'unrestricted',
};

const VALUE_FLAG_ALIASES = {
  '--prompt-file': 'promptFile',
  '--job': 'id',
};

function assignBoolFlag(opts, token) {
  const key = BOOL_FLAG_ALIASES[token] || token.slice(2);
  opts[key] = true;
}

function assignValueFlag(opts, flag, val) {
  const key = VALUE_FLAG_ALIASES[flag] || flag.slice(2);
  opts[key] = val;
}

function tryConsumeInlineValueFlag(opts, token) {
  if (!token.startsWith('--') || !token.includes('=')) return false;
  const eq = token.indexOf('=');
  const flag = token.slice(0, eq);
  if (!VALUE_FLAGS.has(flag)) return false;
  assignValueFlag(opts, flag, token.slice(eq + 1));
  return true;
}

export function parseCliArgs(argv) {
  const opts = { _: [] };
  const hasSubcmd = argv.length > 0 && !argv[0].startsWith('-');
  const subcmd = hasSubcmd ? argv[0] : null;
  let i = hasSubcmd ? 1 : 0;

  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (BOOL_FLAGS.has(token)) {
      assignBoolFlag(opts, token);
      i += 1;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      if (i + 1 >= argv.length) die(`${token} requires a value`);
      assignValueFlag(opts, token, argv[i + 1]);
      i += 2;
      continue;
    }
    if (tryConsumeInlineValueFlag(opts, token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      die(`unknown flag "${token}" (pass task text via --prompt, --prompt-file, or --stdin)`);
    }
    opts._.push(token);
    i += 1;
  }
  return { subcmd, opts };
}

export function validatePermissionsFlags(opts) {
  if (opts.restricted && opts.unrestricted) {
    die('cannot combine `--restricted` and `--unrestricted`');
  }
}

function loadRawPromptText(opts) {
  if (opts.prompt !== undefined) return String(opts.prompt);
  if (opts.promptFile !== undefined) {
    try {
      return fs.readFileSync(opts.promptFile, 'utf8');
    } catch (err) {
      die(`cannot read --prompt-file "${opts.promptFile}": ${err.message}`);
    }
  }
  return fs.readFileSync(0, 'utf8');
}

export function readTaskPrompt(opts) {
  const sources = [
    opts.prompt !== undefined,
    opts.promptFile !== undefined,
    Boolean(opts.stdin),
  ].filter(Boolean).length;
  if (sources === 0) {
    die(
      'task prompt required: pass exactly one of ' +
        '`--prompt <text>`, `--prompt-file <path>`, or `--stdin`'
    );
  }
  if (sources > 1) {
    die('ambiguous prompt source: pass only ONE of `--prompt`, `--prompt-file`, or `--stdin`');
  }
  const text = loadRawPromptText(opts);
  if (!text.trim()) die('task prompt cannot be empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_INLINE_BYTES) {
    die(
      `task prompt exceeds ${MAX_INLINE_BYTES} bytes ceiling; ` +
        'reference files in the workspace instead of inlining them.'
    );
  }
  return text;
}

export function validateSendTimeout(rawTimeout) {
  const timeout = rawTimeout || DEFAULT_SEND_TIMEOUT;
  const ms = durationToMs(timeout);
  if (!Number.isFinite(ms) || ms <= 0)
    die(`invalid --timeout "${timeout}" (examples: 10m, 60m, 300s)`);
  if (ms > MAX_BACKGROUND_MS) die(`--timeout "${timeout}" exceeds maximum 120m ceiling`);
  return timeout;
}

export function pickExplicitPermission(opts, fallback = null) {
  if (opts.restricted) return 'restricted';
  if (opts.unrestricted) return 'unrestricted';
  return fallback;
}

export function printHelp() {
  const lines = [
    `cospan v${PACKAGE_VERSION} — Persona-free point-to-point cross-harness ` +
      'headless session primitive',
    '',
    'Usage:',
    '  cospan send --to <agy|codex|claude|dsh|grok> [--readonly] [--restricted|--unrestricted]',
    '    [--raw] [--model <id>] [--effort <low|medium|high|xhigh|max>] [--timeout <dur>]',
    '    [--config <path>] (--prompt <t> | --prompt-file <p> | --stdin)',
    '  cospan ask  --to <agy|codex|claude|dsh|grok> [--restricted|--unrestricted]',
    '    [--model <id>] [--effort <lvl>] [--timeout <dur>] [--config <path>]',
    '    (--prompt <t> | --prompt-file <p> | --stdin)',
    '  cospan continue (--id <job-id> | --last [--to <target>])',
    '    [--restricted|--unrestricted] [--timeout <dur>] [--model <id>] [--effort <lvl>]',
    '    (--prompt <t> | --prompt-file <p> | --stdin)',
    '  cospan wait [<job-id>...] [--timeout <dur>]',
    '  cospan observe [<job-id>]',
    '  cospan result [<job-id>]',
    '  cospan cancel <job-id>',
    '  cospan restart <job-id> [--timeout <dur>]',
    '  cospan status [<job-id>]',
    '  cospan config [--init [--global | --workspace | --trajectory] [--force]]',
    '    [--config <path>] [--json]',
    '  cospan doctor [--check] [--ping] [--offline] [--json]',
    '  cospan install [--host all|agy|codex] [--force] [--no-codex-cli] [--json]',
    '',
    'Exit codes for `wait` / `status <id>`:',
    '  0 = done | 2 = running | 3 = error/crashed | 4 = canceled | 5 = attention (resumable)',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}
