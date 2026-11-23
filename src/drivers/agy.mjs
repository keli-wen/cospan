import { createActivityTracker } from '../observation.mjs';
import {
  createAgyErrorCollector,
  formatAgyNativeResult,
  resolveAgyModel,
} from './agy-protocol.mjs';

export { createAgyErrorCollector, isAgyEffortFamily, resolveAgyModel } from './agy-protocol.mjs';

function parseAgyJsonStdout(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  for (const line of trimmed.split('\n').reverse()) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') return obj.result || obj;
    } catch {}
  }
  return null;
}

function mapStepState(rawState) {
  if (rawState === 'ACTIVE') return 'running';
  if (rawState === 'DONE') return 'done';
  return 'unknown';
}

function projectAgyToolStep(step, key, state, tracker) {
  const info = step.tool_info || {};
  const isError = Boolean(info.error || step.error || /ERROR|FAIL/.test(step.state || ''));
  const toolName = step.tool_name || info.name || 'unknown';
  const touched =
    /write_file|edit_file/i.test(toolName) && typeof info.parameters?.Path === 'string'
      ? [info.parameters.Path]
      : [];
  tracker.upsertActivity({
    key,
    stepIndex: step.step_index,
    tool: toolName,
    status: isError ? 'error' : state,
    input: info.parameters,
    output: info.error || step.error || info.output,
    touchedFiles: touched,
  });
}

function projectAgyStepUpdate(step, conversationId, tracker) {
  if (!step || !Number.isInteger(step.step_index)) {
    tracker.warn('Unrecognized step retained in raw output.');
    return;
  }
  const key = `${conversationId || 'conv'}:${step.step_index}`;
  const state = mapStepState(step.state);
  if (step.step_type === 'tool') {
    projectAgyToolStep(step, key, state, tracker);
  } else if (step.step_type === 'agent_response') {
    tracker.updateText({
      key,
      stepIndex: step.step_index,
      text: step.text_delta || '',
      delta: true,
      status: state,
    });
  }
}

export const agyDriver = {
  id: 'agy',
  displayName: 'Google Antigravity CLI',
  installHint:
    'AGY CLI was not found. Install it from https://antigravity.google/docs/cli/install and verify with `agy --version`.',

  humanResumeCommand(conversationId) {
    return conversationId ? `agy --conversation ${conversationId}` : null;
  },

  resolveConfig({ kind = 'send', model, effort, config } = {}) {
    return {
      model: resolveAgyModel({ kind, model, effort, config }),
      effort: effort || null,
    };
  },

  buildInvocation({
    kind = 'send',
    prompt,
    model,
    timeout,
    workspace,
    readonly = false,
    permissions = 'unrestricted',
    conversationId = null,
  }) {
    const format = kind === 'ask' ? 'json' : 'stream-json';
    const args = [
      '--model',
      model,
      '--output-format',
      format,
      '--print-timeout',
      timeout,
      '--add-dir',
      workspace,
    ];
    if (conversationId) args.push('--conversation', conversationId);
    if (kind === 'ask' || readonly) args.push('--mode', 'plan');
    args.push(permissions !== 'restricted' ? '--dangerously-skip-permissions' : '--sandbox');
    return { args, stdinText: prompt, cwd: workspace };
  },

  parseForegroundOutput({ stdout, stderr, exitCode }) {
    const collector = createAgyErrorCollector();
    collector.write(stderr || '');
    collector.end();
    const parsed = parseAgyJsonStdout(stdout);
    const native = formatAgyNativeResult(parsed, collector.snapshot(), exitCode);
    if (!parsed || typeof parsed !== 'object') {
      throw Object.assign(
        new Error(`agy ask did not return parseable JSON (exit ${exitCode}): ${stderr || stdout}`),
        {
          native,
        }
      );
    }
    if (parsed.status === 'ERROR' || parsed.error) {
      throw Object.assign(new Error(parsed.error || `agy returned status ${parsed.status}`), {
        native,
      });
    }
    return {
      response: typeof parsed.response === 'string' ? parsed.response : '',
      conversationId: parsed.conversation_id || null,
      usage: parsed.stats || parsed.usage || null,
      native,
    };
  },

  createStreamSession({ onConversation = () => {} } = {}) {
    const tracker = createActivityTracker();
    const errorCollector = createAgyErrorCollector();
    let conversationId = null;
    let resultPayload = null;

    return {
      warn: tracker.warn,
      snapshot: tracker.snapshot,
      writeStderr(chunk) {
        errorCollector.write(chunk);
      },
      acceptEvent(event) {
        tracker.touch();
        const body = event?.[event.event] || event;
        const cid = body?.conversation_id;
        if (typeof cid === 'string' && cid.length <= 256 && cid !== conversationId) {
          conversationId = cid;
          onConversation(cid);
        }
        if (event.event === 'init') return false;
        if (event.event === 'result' && event.result && typeof event.result === 'object') {
          resultPayload = event.result;
          return true;
        }
        if (event.event !== 'step_update') {
          tracker.warn('Unknown event retained in raw output.');
          return false;
        }
        projectAgyStepUpdate(event.step_update, conversationId, tracker);
        return false;
      },
      finalize(exitCode) {
        errorCollector.end();
        const native = formatAgyNativeResult(resultPayload, errorCollector.snapshot(), exitCode);
        if (resultPayload && (resultPayload.status === 'ERROR' || resultPayload.error)) {
          return {
            payload: null,
            streamFailure: resultPayload.error || `agy returned status ${resultPayload.status}`,
            native,
          };
        }
        const payload = resultPayload
          ? {
              response: typeof resultPayload.response === 'string' ? resultPayload.response : '',
              conversation_id: resultPayload.conversation_id || conversationId,
              usage: resultPayload.stats || resultPayload.usage || null,
            }
          : null;
        return { payload, streamFailure: null, native };
      },
    };
  },
};
