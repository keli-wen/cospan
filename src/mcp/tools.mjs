import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TARGET_ENUM = ['agy', 'codex', 'claude', 'dsh', 'grok'];
const EFFORT_ENUM = ['low', 'medium', 'high', 'xhigh', 'max'];
const CWD_PROP = {
  type: 'string',
  description: 'Absolute path to the workspace/repository directory.',
};
const MODEL_PARAM_DESC =
  'Optional model shortcut (pass verbatim, e.g. sol/terra/astra/luna, ' +
  'flash/neon/carbon/argon/hydrogen/opus/sonnet, haiku/fable, pro/v4.1-flash/v4-pro, ' +
  'build/fast), explicit full model ID, or <provider>/<model>. Omit when unspecified to use ' +
  'cospan effective defaults; never guess version numbers or append effort suffixes.';
const EFFORT_PARAM_DESC =
  'Optional reasoning effort override. Pass separately instead of appending ' +
  'effort suffixes (such as -medium) to model.';

export const TOOLS = [
  {
    name: 'cospan_send',
    description:
      'Launch an asynchronous background delegation job to an external headless harness ' +
      '(`agy`, `codex`, `claude`, `dsh`, or `grok`). Returns immediately with `job_id`; ' +
      'call `cospan_wait` next to collect its output.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        to: { type: 'string', enum: TARGET_ENUM, description: 'Target harness ID.' },
        prompt: { type: 'string', description: 'Task instructions to send to the target harness.' },
        readonly: {
          type: 'boolean',
          description:
            'Set true for read-only inspection/review/research; ' +
            'false (default) allows workspace edits.',
        },
        restricted: {
          type: 'boolean',
          description:
            'Set true to opt into OS sandboxing; ' +
            'false/omitted uses cospan config default ("unrestricted").',
        },
        raw: {
          type: 'boolean',
          description: 'Set true to skip the cospan protocol envelope and send raw prompt text.',
        },
        model: { type: 'string', description: MODEL_PARAM_DESC },
        effort: {
          type: 'string',
          enum: EFFORT_ENUM,
          description: EFFORT_PARAM_DESC,
        },
        timeout: { type: 'string', description: 'Optional worker hard limit (e.g. "60m", "30m").' },
      },
      required: ['cwd', 'to', 'prompt'],
    },
  },
  {
    name: 'cospan_wait',
    description:
      'Block quietly until one (`id`) or multiple (`ids`, pure WaitAll / allSettled barrier) ' +
      'detached `cospan` jobs finish (or `timeout` elapses), then return terminal status and ' +
      'deliverable outputs. Exit code 2 (`status: "running"`) means still running—call ' +
      '`cospan_wait` again.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: {
          type: 'string',
          description: 'Single job ID returned by `cospan_send` or `cospan_continue`.',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Batch WaitAll: list of job IDs to wait for together (allSettled barrier) when ' +
            'the next step needs all parallel outputs before proceeding.',
        },
        timeout: {
          type: 'string',
          description: 'How long this wait call may block before returning status (default "20m").',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'cospan_observe',
    description:
      'Return an immediate bounded (<= 8 KiB) JSON progress snapshot of a job ' +
      'without consuming or printing the full result body.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: { type: 'string', description: 'Job ID to observe.' },
      },
      required: ['cwd', 'id'],
    },
  },
  {
    name: 'cospan_continue',
    description:
      'Continue a previous job in its native target conversation/thread (`--conversation` in ' +
      'agy, `exec resume` in codex, `--resume` in claude/grok, `--session-id` in dsh). Pass ' +
      'either `id` or `last: true`. Returns a new linked `job_id`; collect it with `cospan_wait`.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: { type: 'string', description: 'Previous job ID whose session should be resumed.' },
        last: {
          type: 'boolean',
          description:
            'If true, resume the latest finished job in `cwd` (optionally filtered by `to`).',
        },
        to: {
          type: 'string',
          enum: TARGET_ENUM,
          description: 'Optional target filter when `last: true`.',
        },
        prompt: { type: 'string', description: 'Delta follow-up prompt for the resumed session.' },
        restricted: {
          type: 'boolean',
          description: 'Optional override to opt into OS sandboxing on the continued turn.',
        },
        model: { type: 'string', description: MODEL_PARAM_DESC },
        effort: { type: 'string', enum: EFFORT_ENUM, description: EFFORT_PARAM_DESC },
        timeout: { type: 'string', description: 'Optional worker hard limit (e.g. "60m").' },
      },
      required: ['cwd', 'prompt'],
    },
  },
  {
    name: 'cospan_result',
    description: 'Read the stored deliverable output of a completed `cospan` job.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: { type: 'string', description: 'Completed job ID.' },
      },
      required: ['cwd', 'id'],
    },
  },
  {
    name: 'cospan_cancel',
    description: 'Safely cancel a running `cospan` job and its descendant process group.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: { type: 'string', description: 'Running job ID to cancel.' },
      },
      required: ['cwd', 'id'],
    },
  },
  {
    name: 'cospan_status',
    description: 'List recorded `cospan` jobs in the repository or inspect one job record.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        id: { type: 'string', description: 'Optional job ID.' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'cospan_ask',
    description:
      'Run a fast, synchronous, read-only foreground Q&A check against ' +
      '`agy`, `codex`, `claude`, `dsh`, or `grok`.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        to: { type: 'string', enum: TARGET_ENUM, description: 'Target harness ID.' },
        prompt: { type: 'string', description: 'Short question to ask.' },
        restricted: {
          type: 'boolean',
          description: 'Optional override to opt into OS sandboxing.',
        },
        model: { type: 'string', description: MODEL_PARAM_DESC },
        effort: { type: 'string', enum: EFFORT_ENUM, description: EFFORT_PARAM_DESC },
        timeout: { type: 'string', description: 'Optional timeout (default "2m").' },
      },
      required: ['cwd', 'to', 'prompt'],
    },
  },
];

const EXIT_STATUS_LABELS = {
  0: 'done',
  2: 'running',
  3: 'error',
  4: 'canceled',
  5: 'attention',
};

function runCliAsync(cospanBin, cliArgs, { cwd, stdinText = null, env = null }) {
  return new Promise((resolve) => {
    const workdir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
    const child = spawn(process.execPath, [cospanBin, ...cliArgs], {
      cwd: workdir,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      stdio: [stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (stdinText !== null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText, 'utf8');
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.once('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function appendCommonExecFlags(cliArgs, args) {
  if (args.restricted === true) cliArgs.push('--restricted');
  else if (args.restricted === false) cliArgs.push('--unrestricted');
  if (args.model) cliArgs.push('--model', String(args.model));
  if (args.effort) cliArgs.push('--effort', String(args.effort));
  if (args.timeout) cliArgs.push('--timeout', String(args.timeout));
}

function formatTextOutcome(res, isError) {
  const content = [{ type: 'text', text: (res.stdout || res.stderr).trim() }];
  if (res.stdout && res.stderr) {
    const notice = res.stderr
      .split('\n')
      .find((line) => line.startsWith('[cospan] update available:'));
    if (notice) content.push({ type: 'text', text: notice.trim() });
  }
  return { isError, content };
}

function parseWaitIds(args) {
  const ids = [];
  const push = (v) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s) ids.push(s);
  };
  push(args.id);
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids)) {
      return { error: 'cospan_wait: `ids` must be an array of job IDs' };
    }
    for (const item of args.ids) push(item);
    if (!ids.length) return { error: 'cospan_wait: `ids` must contain at least one job ID' };
  }
  return { ids };
}

const TOOL_HANDLERS = {
  async cospan_send(cospanBin, args, cwd, env) {
    const cliArgs = ['send', '--to', String(args.to || ''), '--stdin', '--json'];
    if (args.readonly) cliArgs.push('--readonly');
    if (args.raw) cliArgs.push('--raw');
    appendCommonExecFlags(cliArgs, args);
    const res = await runCliAsync(cospanBin, cliArgs, {
      cwd,
      stdinText: String(args.prompt ?? ''),
      env,
    });
    return formatTextOutcome(res, res.exitCode !== 0);
  },

  async cospan_wait(cospanBin, args, cwd, env) {
    const parsed = parseWaitIds(args);
    if (parsed.error) return { isError: true, content: [{ type: 'text', text: parsed.error }] };
    const cliArgs = ['wait', ...parsed.ids, '--timeout', String(args.timeout || '20m')];
    const res = await runCliAsync(cospanBin, cliArgs, { cwd, env });
    const status = EXIT_STATUS_LABELS[res.exitCode] || 'error';
    const header = `[cospan_wait exit_code=${res.exitCode} status=${status}]`;
    const body = (res.stdout || res.stderr).trim();
    // Exit code 2 ("still running") and 5 ("attention") are structured lifecycle outcomes,
    // not transport crashes.
    return {
      isError: res.exitCode === 1 || res.exitCode === 3,
      content: [{ type: 'text', text: `${header}\n${body}`.trim() }],
    };
  },

  async cospan_observe(cospanBin, args, cwd, env) {
    const cliArgs = args.id ? ['observe', String(args.id)] : ['observe'];
    const res = await runCliAsync(cospanBin, cliArgs, { cwd, env });
    return formatTextOutcome(res, res.exitCode === 1);
  },

  async cospan_continue(cospanBin, args, cwd, env) {
    const cliArgs = ['continue'];
    if (args.last) {
      cliArgs.push('--last');
      if (args.to) cliArgs.push('--to', String(args.to));
    } else {
      cliArgs.push('--id', String(args.id || ''));
    }
    cliArgs.push('--stdin', '--json');
    appendCommonExecFlags(cliArgs, args);
    const res = await runCliAsync(cospanBin, cliArgs, {
      cwd,
      stdinText: String(args.prompt ?? ''),
      env,
    });
    return formatTextOutcome(res, res.exitCode !== 0);
  },

  async cospan_result(cospanBin, args, cwd, env) {
    const cliArgs = args.id ? ['result', String(args.id)] : ['result'];
    const res = await runCliAsync(cospanBin, cliArgs, { cwd, env });
    return formatTextOutcome(res, res.exitCode !== 0 && res.exitCode !== 5);
  },

  async cospan_cancel(cospanBin, args, cwd, env) {
    const res = await runCliAsync(cospanBin, ['cancel', String(args.id || '')], { cwd, env });
    return formatTextOutcome(res, res.exitCode !== 0);
  },

  async cospan_status(cospanBin, args, cwd, env) {
    const cliArgs = args.id ? ['status', String(args.id)] : ['status'];
    const res = await runCliAsync(cospanBin, cliArgs, { cwd, env });
    return formatTextOutcome(res, res.exitCode === 1);
  },

  async cospan_ask(cospanBin, args, cwd, env) {
    const cliArgs = ['ask', '--to', String(args.to || ''), '--stdin'];
    appendCommonExecFlags(cliArgs, args);
    const res = await runCliAsync(cospanBin, cliArgs, {
      cwd,
      stdinText: String(args.prompt ?? ''),
      env,
    });
    return formatTextOutcome(res, res.exitCode !== 0);
  },
};

export async function callTool(cospanBin, name, args = {}, options = {}) {
  const handler = Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name)
    ? TOOL_HANDLERS[name]
    : null;
  if (!handler) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
  return handler(cospanBin, args, args.cwd || process.cwd(), options.env || null);
}
