import { createActivityTracker, excerpt } from '../observation.mjs';
import {
  buildGrokPermissionFlags,
  extractGrokErrorMessage,
  extractGrokLocationFiles,
  extractGrokTerminalError,
  extractGrokTouchedFiles,
  formatGrokNative,
  hasExplicitGrokError,
  isGrokSuccessStopReason,
  parseGrokJsonStdout,
  resolveGrokModelAndEffort,
  resolveGrokToolId,
  resolveGrokUpdateStatus,
} from './grok-protocol.mjs';

export { normalizeGrokEffort, resolveGrokModelAndEffort } from './grok-protocol.mjs';

function projectGrokToolCall(event, ctx) {
  const id = resolveGrokToolId(event, `grok_tool_${++ctx.toolSeq}`);
  const name = event.toolName || event.name || event.tool || event.title || 'tool';
  const input = event.rawInput ?? event.input ?? event.arguments ?? event.args;
  const touchedFiles = [
    ...new Set([
      ...extractGrokTouchedFiles(name, input, event.kind),
      ...extractGrokLocationFiles(name, event, event.kind),
    ]),
  ];
  ctx.toolNames.set(id, name);
  if (event.kind) ctx.toolKinds.set(id, event.kind);
  ctx.tracker.upsertActivity({
    key: id,
    tool: name,
    status: 'running',
    input,
    touchedFiles,
  });
}

function projectGrokToolUpdate(event, ctx) {
  const id = resolveGrokToolId(event, 'tool_result');
  const name =
    event.toolName || event.name || event.tool || event.title || ctx.toolNames.get(id) || 'tool';
  const kind = event.kind || ctx.toolKinds.get(id);
  const touchedFiles = extractGrokLocationFiles(name, event, kind);
  ctx.tracker.upsertActivity({
    key: id,
    tool: name,
    status: resolveGrokUpdateStatus(event),
    output: event.rawOutput ?? event.error ?? event.output ?? event.content,
    ...(touchedFiles.length ? { touchedFiles } : {}),
  });
}

function projectGrokToolResult(event, ctx) {
  const id = resolveGrokToolId(event, 'tool_result');
  const name = event.toolName || event.name || event.tool || ctx.toolNames.get(id) || 'tool';
  const isErr = Boolean(event.isError || event.is_error || hasExplicitGrokError(event));
  ctx.tracker.upsertActivity({
    key: id,
    tool: name,
    status: isErr ? 'error' : 'done',
    output: event.error ?? event.output ?? event.result ?? event.content,
  });
}

function applyGrokTextEvent(event, state) {
  const chunk =
    typeof event.data === 'string'
      ? event.data
      : typeof event.text === 'string'
        ? event.text
        : null;
  if (chunk === null) return;
  state.accumulatedText += chunk;
  state.tracker.updateText({
    key: `${state.sessionId || 'grok'}:text`,
    text: chunk,
    delta: true,
  });
}

function applyGrokEndEvent(event, state) {
  state.endEvent = event;
  state.usage = event.usage || state.usage;
  const terminalError = extractGrokTerminalError(event, {
    requireStopReason: event.type === 'end',
  });
  state.streamError ||= terminalError;
  if (state.streamError) return;
  state.turnCompleted = true;
  if (typeof event.text === 'string') state.finalResponse = event.text;
  else if (typeof event.result === 'string') state.finalResponse = event.result;
  state.tracker.updateText({
    key: `${state.sessionId || 'grok'}:final`,
    text: state.finalResponse ?? state.accumulatedText,
    status: 'done',
  });
}

function dispatchGrokStreamEvent(event, state) {
  const type = event?.type;
  if (type === 'text') applyGrokTextEvent(event, state);
  else if (type === 'usage') state.usage = event.usage || state.usage;
  else if (type === 'tool_call' || type === 'tool_use') projectGrokToolCall(event, state);
  else if (type === 'tool_call_update') projectGrokToolUpdate(event, state);
  else if (type === 'tool_result') projectGrokToolResult(event, state);
  else if (type === 'end' || type === 'result') {
    applyGrokEndEvent(event, state);
    return true;
  } else if (type === 'error') {
    state.streamError = extractGrokErrorMessage(event, 'Grok stream error.');
    return true;
  }
  return false;
}

function finalizeGrokStream(state, exitCode) {
  const native = formatGrokNative(state.endEvent, exitCode, state.streamError);
  if (state.streamError) return { payload: null, streamFailure: state.streamError, native };
  const nonZero = exitCode !== null && exitCode !== undefined && exitCode !== 0;
  if (!state.turnCompleted) {
    if (!nonZero) return { payload: null, streamFailure: null, native };
    const detail = state.stderr.trim();
    const msg = detail
      ? `Grok Build exited with code ${exitCode}: ${excerpt(detail, 512).text}`
      : `Grok Build exited with code ${exitCode} before completing the turn.`;
    return {
      payload: null,
      streamFailure: msg,
      native: formatGrokNative(state.endEvent, exitCode, detail || `exit ${exitCode}`),
    };
  }
  if (nonZero) {
    const msg = `Grok Build exited with code ${exitCode} after end event.`;
    return {
      payload: null,
      streamFailure: msg,
      native: formatGrokNative(state.endEvent, exitCode, msg),
    };
  }
  return {
    payload: {
      response: state.finalResponse ?? state.accumulatedText,
      conversation_id: state.endEvent?.sessionId || state.endEvent?.session_id || state.sessionId,
      usage: state.usage,
    },
    streamFailure: null,
    native,
  };
}

function validateGrokForegroundParsed(parsed, { stderr, exitCode }) {
  const terminalError = extractGrokTerminalError(parsed);
  if (terminalError) {
    throw Object.assign(new Error(terminalError), {
      native: formatGrokNative(parsed, exitCode, terminalError),
    });
  }
  if (exitCode !== 0) {
    const msg = extractGrokErrorMessage(
      parsed,
      (stderr || '').trim() || `grok ask exited with code ${exitCode}`
    );
    throw Object.assign(new Error(msg), { native: formatGrokNative(parsed, exitCode, msg) });
  }
  if (
    typeof parsed.text !== 'string' &&
    typeof parsed.result !== 'string' &&
    !isGrokSuccessStopReason(parsed.stopReason)
  ) {
    throw Object.assign(new Error('grok ask returned unexpected JSON payload without text.'), {
      native: formatGrokNative(parsed, exitCode, 'unexpected payload'),
    });
  }
}

export const grokDriver = {
  id: 'grok',
  displayName: 'xAI Grok Build CLI',
  installHint:
    'Grok Build CLI (`grok`) was not found. Install from https://x.ai/cli and verify with ' +
    '`grok --version`.',

  humanResumeCommand(conversationId) {
    return conversationId ? `grok --resume ${conversationId}` : null;
  },

  resolveConfig({ kind = 'send', model, effort, config } = {}) {
    return resolveGrokModelAndEffort({ kind, model, effort, config });
  },

  buildInvocation({
    kind = 'send',
    prompt,
    model = null,
    effort = null,
    workspace,
    readonly = false,
    permissions = 'unrestricted',
    conversationId = null,
  }) {
    const effectiveReadonly = kind === 'ask' || Boolean(readonly);
    const format = kind === 'ask' ? 'json' : 'streaming-json';
    const resumeFlags = kind !== 'ask' && conversationId ? ['--resume', conversationId] : [];
    const permFlags = buildGrokPermissionFlags({ readonly: effectiveReadonly, permissions });
    const modelFlags = [
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--reasoning-effort', effort] : []),
    ];

    // `--add-dir` is intentionally omitted (Grok daemon sessions reject additionalDirectories).
    // `-p [<PROMPT>]` must appear last so clap does not swallow subsequent flags as prompt text.
    const args = [
      '--output-format',
      format,
      '--cwd',
      workspace,
      ...resumeFlags,
      ...permFlags,
      ...modelFlags,
      '-p',
    ];
    return { args, stdinText: prompt, cwd: workspace };
  },

  parseForegroundOutput({ stdout, stderr, exitCode }) {
    const parsed = parseGrokJsonStdout(stdout);
    if (!parsed || typeof parsed !== 'object') {
      const detail = (stderr || stdout || '').trim();
      throw Object.assign(
        new Error(`grok ask did not return parseable JSON (exit ${exitCode}): ${detail}`),
        { native: formatGrokNative(null, exitCode, null) }
      );
    }
    validateGrokForegroundParsed(parsed, { stderr, exitCode });
    const text =
      typeof parsed.text === 'string'
        ? parsed.text
        : typeof parsed.result === 'string'
          ? parsed.result
          : '';
    return {
      response: text,
      conversationId: parsed.sessionId || parsed.session_id || null,
      usage: parsed.usage || null,
      native: formatGrokNative(parsed, exitCode, null),
    };
  },

  createStreamSession({ onConversation = () => {} } = {}) {
    const tracker = createActivityTracker();
    const state = {
      tracker,
      toolNames: new Map(),
      toolKinds: new Map(),
      toolSeq: 0,
      sessionId: null,
      accumulatedText: '',
      finalResponse: null,
      endEvent: null,
      turnCompleted: false,
      usage: null,
      streamError: null,
      stderr: '',
    };

    const captureSession = (ev) => {
      const candidate = ev?.sessionId || ev?.session_id || ev?.session?.id;
      if (
        typeof candidate === 'string' &&
        candidate &&
        candidate.length <= 256 &&
        candidate !== state.sessionId
      ) {
        state.sessionId = candidate;
        onConversation(candidate);
      }
    };

    return {
      warn: tracker.warn,
      snapshot: tracker.snapshot,
      writeStderr(chunk) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        state.stderr = excerpt(state.stderr + text, 4096, true).text;
      },
      acceptEvent(event) {
        tracker.touch();
        captureSession(event);
        return dispatchGrokStreamEvent(event, state);
      },
      finalize(exitCode) {
        return finalizeGrokStream(state, exitCode);
      },
    };
  },
};
