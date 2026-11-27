import { excerpt } from '../observation.mjs';
import { BUILTIN_CONFIG, loadEffectiveConfig } from '../targets.mjs';

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const FILE_MUTATION_TOOL_RE =
  /^(?:write|search_replace|hashline_edit|strreplace|editnotebook|edit|multiedit|delete)$/i;
const READONLY_DISALLOWED_TOOLS = 'search_replace,task';
const READONLY_BASH_DENY_FLAGS = ['--deny', 'Bash(mkdir*)', '--deny', 'Bash(touch*)'];

export function normalizeGrokEffort(effort) {
  if (effort == null || effort === '') return null;
  const e = String(effort).trim().toLowerCase();
  if (!e || e === 'inherit') return null;
  if (VALID_EFFORTS.has(e)) return e;
  throw new Error(
    `invalid --effort "${effort}" for grok (expected none|minimal|low|medium|high|xhigh|max)`
  );
}

function pickGrokBaseDefaults(defaults, kind) {
  const sendModel = defaults.model || defaults.sendModel || 'inherit';
  if (kind === 'ask') {
    return {
      defaultModel: defaults.askModel || sendModel,
      defaultEffort: defaults.askEffort || 'low',
    };
  }
  return {
    defaultModel: sendModel,
    defaultEffort: defaults.effort || defaults.sendEffort || 'high',
  };
}

export function resolveGrokModelAndEffort({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.grok, ...(effective?.defaults?.grok || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.grok, ...(effective?.mappings?.grok || {}) };

  const { defaultModel, defaultEffort } = pickGrokBaseDefaults(defaults, kind);
  const rawModel = model || defaultModel;
  const resolvedModel =
    rawModel === 'inherit'
      ? null
      : Object.hasOwn(mappings, rawModel)
        ? mappings[rawModel]
        : rawModel;
  const rawEffort = effort ?? defaultEffort;
  return { model: resolvedModel, effort: normalizeGrokEffort(rawEffort) };
}

export function buildGrokPermissionFlags({ readonly, permissions }) {
  const restricted = permissions === 'restricted';
  if (readonly) {
    return [
      '--permission-mode',
      'dontAsk',
      ...(restricted ? ['--sandbox', 'read-only'] : []),
      '--disallowed-tools',
      READONLY_DISALLOWED_TOOLS,
      ...READONLY_BASH_DENY_FLAGS,
    ];
  }
  return restricted
    ? ['--permission-mode', 'acceptEdits', '--sandbox', 'workspace']
    : ['--always-approve'];
}

export function isGrokSuccessStopReason(stopReason) {
  return stopReason === 'end_turn';
}

export function hasExplicitGrokError(obj) {
  if (typeof obj?.error === 'string') return obj.error.trim().length > 0;
  return typeof obj?.error?.message === 'string' && obj.error.message.trim().length > 0;
}

export function extractGrokErrorMessage(obj, fallback = 'Grok Build execution failed.') {
  if (!obj || typeof obj !== 'object') return fallback;
  const rawCandidates = [obj.error, obj.error?.message, obj.message, obj.data];
  for (const raw of rawCandidates) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return text;
  }
  return fallback;
}

function isGrokErrorFlag(obj) {
  return (
    obj.type === 'error' ||
    obj.is_error === true ||
    obj.isError === true ||
    hasExplicitGrokError(obj)
  );
}

export function extractGrokTerminalError(obj, { requireStopReason = false } = {}) {
  if (!obj || typeof obj !== 'object') return null;
  if (isGrokErrorFlag(obj)) return extractGrokErrorMessage(obj);
  if (typeof obj.stopReason === 'string' && !isGrokSuccessStopReason(obj.stopReason)) {
    return extractGrokErrorMessage(
      obj,
      `Grok Build turn did not complete normally (stopReason=${obj.stopReason}).`
    );
  }
  if (requireStopReason && !isGrokSuccessStopReason(obj.stopReason)) {
    const reason = obj.stopReason ?? 'missing';
    return extractGrokErrorMessage(
      obj,
      `Grok Build turn ended without end_turn stopReason (${reason}).`
    );
  }
  return null;
}

export function parseGrokJsonStdout(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') return obj;
    } catch {}
  }
  return null;
}

export function formatGrokNative(endEvent, exitCode, streamError) {
  return {
    target: 'grok',
    exit_code: exitCode,
    ...(typeof endEvent?.stopReason === 'string'
      ? { stop_reason: excerpt(endEvent.stopReason, 128).text }
      : {}),
    ...(streamError ? { stream_error: excerpt(streamError, 512).text } : {}),
  };
}

export function resolveGrokToolId(event, fallback) {
  return event?.toolCallId || event?.id || event?.callId || fallback;
}

export function isGrokFileMutation(toolName, kind) {
  return String(kind || '').toLowerCase() === 'edit' || FILE_MUTATION_TOOL_RE.test(toolName || '');
}

export function extractGrokTouchedFiles(toolName, input, kind) {
  if (!isGrokFileMutation(toolName, kind) || !input || typeof input !== 'object') return [];
  const candidate = input.file_path || input.path || input.filePath || input.target_file;
  return typeof candidate === 'string' && candidate ? [candidate] : [];
}

export function extractGrokLocationFiles(toolName, event, kind) {
  if (!isGrokFileMutation(toolName, kind) || !Array.isArray(event?.locations)) return [];
  return event.locations.map((loc) => loc?.path).filter((p) => typeof p === 'string' && p);
}

export function resolveGrokUpdateStatus(event) {
  const raw = String(event?.status || '').toLowerCase();
  if (raw === 'completed' || raw === 'done') return 'done';
  if (
    raw === 'failed' ||
    raw === 'error' ||
    raw === 'cancelled' ||
    raw === 'canceled' ||
    hasExplicitGrokError(event)
  ) {
    return 'error';
  }
  return 'running';
}
