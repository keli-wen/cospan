import { StringDecoder } from 'node:string_decoder';
import { excerpt } from '../observation.mjs';
import { BUILTIN_CONFIG, loadEffectiveConfig } from '../targets.mjs';

const EFFORT_FAMILIES = new Set([
  'gemini-4-neon',
  'gemini-4-hydrogen',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
]);

const XHIGH_EFFORT_FAMILIES = new Set(['gemini-4-neon', 'gemini-4-hydrogen']);
const VERSIONED_EFFORT_FAMILY_RE = /^gemini-\d|^claude-(?:opus|sonnet|haiku)-/i;
const VERSIONED_GEMINI_FAMILY_RE = /^gemini-\d/i;
const EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh)$/i;
const SUPPORTED_FAMILY_EFFORTS = ['low', 'medium', 'high'];
const MAX_ERROR_LINE = 64 * 1024;
const MAX_ERRORS = 3;
const FINISHED_REASONS = new Set(['print_timeout', 'interrupted', 'error']);

export function isAgyEffortFamily(name) {
  if (typeof name !== 'string' || !name) return false;
  return EFFORT_FAMILIES.has(name.toLowerCase()) || VERSIONED_EFFORT_FAMILY_RE.test(name);
}

function allowsAgyXhigh(family) {
  const lower = family.toLowerCase();
  if (XHIGH_EFFORT_FAMILIES.has(lower)) return true;
  if (EFFORT_FAMILIES.has(lower)) return false;
  return VERSIONED_GEMINI_FAMILY_RE.test(family);
}

function normalizeEffortForFamily(effort, fallback = 'low', { allowXhigh = false } = {}) {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (SUPPORTED_FAMILY_EFFORTS.includes(e)) return e;
  if (allowXhigh) {
    if (e === 'xhigh') return 'xhigh';
    if (e === 'max') {
      process.stderr.write(
        'cospan: agy model family uses low|medium|high|xhigh suffixes; ' +
          `mapping --effort ${e} -> xhigh\n`
      );
      return 'xhigh';
    }
    throw new Error(`invalid --effort "${effort}" for agy (expected low|medium|high|xhigh)`);
  }
  if (e === 'xhigh' || e === 'max') {
    process.stderr.write(
      `cospan: agy model family uses low|medium|high suffixes; mapping --effort ${e} -> high\n`
    );
    return 'high';
  }
  throw new Error(`invalid --effort "${effort}" for agy (expected low|medium|high)`);
}

function formatFamilyWithEffort(family, effort, fallback) {
  const normalized = normalizeEffortForFamily(effort, fallback, {
    allowXhigh: allowsAgyXhigh(family),
  });
  return `${family}-${normalized}`;
}

function pickDefaultAgyBase(defaults, kind) {
  if (kind === 'ask') return defaults.askModel || defaults.model || 'gemini-3.8-flash-medium';
  return defaults.model || defaults.sendModel || 'gemini-3.8-flash-medium';
}

function resolveAgyFamilyAndEffort(mapped, effort, defaults) {
  const fallbackEffort = defaults.effort || 'medium';
  const suffixMatch = EFFORT_SUFFIX_RE.exec(mapped);
  if (suffixMatch) {
    const baseFamily = suffixMatch[1];
    if (!effort || !isAgyEffortFamily(baseFamily)) return mapped;
    return formatFamilyWithEffort(baseFamily, effort, suffixMatch[2].toLowerCase());
  }
  if (isAgyEffortFamily(mapped)) {
    return formatFamilyWithEffort(mapped, effort, fallbackEffort);
  }
  return mapped;
}

export function resolveAgyModel({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.agy, ...(effective?.defaults?.agy || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.agy, ...(effective?.mappings?.agy || {}) };

  const rawModel = model || pickDefaultAgyBase(defaults, kind);
  const mapped = Object.hasOwn(mappings, rawModel) ? mappings[rawModel] : rawModel;
  return resolveAgyFamilyAndEffort(mapped, effort, defaults);
}

function sanitizeAgyErrorRecord(value, warn) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warn('Malformed AGY_ERROR record; see original stderr.');
    return null;
  }
  const err = {};
  for (const field of ['status', 'code_kind', 'error_id']) {
    if (typeof value[field] === 'string' && value[field]) {
      const bounded = excerpt(value[field], 256);
      err[field] = bounded.text;
      if (bounded.truncated) warn('AGY_ERROR fields truncated; see original stderr.');
    }
  }
  if (Number.isSafeInteger(value.error_code)) err.error_code = value.error_code;
  if (typeof value.retryable === 'boolean') err.retryable = value.retryable;
  return Object.keys(err).length ? err : null;
}

export function createAgyErrorCollector() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  const errors = [];
  const warnings = [];
  const warn = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  const parseLine = (text) => {
    const match = /^\s*AGY_ERROR:\s*(.*)$/.exec(text.trimEnd());
    if (!match) return;
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      warn('Malformed AGY_ERROR record; see original stderr.');
      return;
    }
    const err = sanitizeAgyErrorRecord(parsed, warn);
    if (!err) return;
    errors.push(err);
    if (errors.length > MAX_ERRORS) {
      errors.shift();
      warn('Older AGY_ERROR records omitted; see original stderr.');
    }
  };
  const consume = (text) => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!dropping) {
        if (Buffer.byteLength(pending) + Buffer.byteLength(part) > MAX_ERROR_LINE) {
          pending = '';
          dropping = true;
        } else {
          pending += part;
        }
      }
      if (part.endsWith('\n')) {
        if (!dropping) parseLine(pending);
        pending = '';
        dropping = false;
      }
    }
  };
  return {
    write(chunk) {
      consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    end() {
      consume(decoder.end());
      if (!dropping && pending) parseLine(pending);
      pending = '';
    },
    snapshot() {
      return {
        ...(errors.length ? { errors: structuredClone(errors) } : {}),
        ...(warnings.length ? { warnings: [...warnings] } : {}),
      };
    },
  };
}

export function formatAgyNativeResult(payload, diagnostic = {}, exitCode = null) {
  const out = { target: 'agy', ...diagnostic, exit_code: exitCode };
  const warnings = [...(diagnostic.warnings || [])];
  if (typeof payload?.status === 'string') out.status = excerpt(payload.status, 128).text;
  const finReason = payload?.finished_reason;
  if (typeof finReason === 'string' && finReason) {
    out.finished_reason = excerpt(finReason, 256).text;
    if (!FINISHED_REASONS.has(finReason))
      warnings.push('Unknown finished_reason; see original result.');
  }
  if (warnings.length) out.warnings = warnings;
  return out;
}
