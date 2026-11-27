#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const HELP_TEXT = [
  '--single --output-format --cwd --add-dir --resume --model',
  '--reasoning-effort --permission-mode --always-approve --disallowed-tools',
  '--deny --sandbox',
].join(' ');

function parseFakeGrokArgs(argv) {
  const st = {
    isSingle: false,
    format: 'plain',
    cwd: process.cwd(),
    addDirs: [],
    resumeId: null,
    model: 'inherit',
    effort: 'inherit',
    permMode: 'default',
    alwaysApprove: false,
    disallowedTools: '',
    denies: [],
    sandbox: 'off',
    promptArg: null,
  };
  const valueFlags = {
    '--output-format': (v) => (st.format = v),
    '--cwd': (v) => (st.cwd = v),
    '--add-dir': (v) => st.addDirs.push(v),
    '--resume': (v) => (st.resumeId = v),
    '-r': (v) => (st.resumeId = v),
    '--model': (v) => (st.model = v),
    '-m': (v) => (st.model = v),
    '--reasoning-effort': (v) => (st.effort = v),
    '--effort': (v) => (st.effort = v),
    '--permission-mode': (v) => (st.permMode = v),
    '--disallowed-tools': (v) => (st.disallowedTools = v),
    '--deny': (v) => st.denies.push(v),
    '--sandbox': (v) => (st.sandbox = v),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--single') {
      st.isSingle = true;
      // Mirror real clap `[<PROMPT>]` behavior: swallows the next arg if `-p` is not last.
      if (i + 1 < argv.length) st.promptArg = argv[++i];
    } else if (a === '--always-approve') {
      st.alwaysApprove = true;
    } else if (valueFlags[a]) {
      valueFlags[a](argv[++i] || '');
    } else if (!a.startsWith('-')) {
      st.promptArg = a;
    }
  }
  return st;
}

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('1.0.93-fake (grok)\n');
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}

const st = parseFakeGrokArgs(argv);
if (!st.isSingle) {
  process.stderr.write('fake-grok: interactive TUI not supported; pass -p/--single\n');
  process.exit(2);
}
if (st.addDirs.length > 0) {
  process.stdout.write(
    JSON.stringify({
      type: 'error',
      message:
        "Couldn't create session: Invalid params: " +
        '"additionalDirectories is not supported: a session works only in its cwd"',
    }) + '\n'
  );
  process.exit(1);
}
if (process.env.FAKE_GROK_UNAUTH === '1') {
  process.stderr.write('Not logged in. Please run `grok login`.\n');
  process.exit(1);
}

const prompt = st.promptArg !== null ? st.promptArg : fs.readFileSync(0, 'utf8');
const sessionId = st.resumeId || 'grok-sess-999';

if (process.env.FAKE_GROK_TOUCH_FILE) {
  fs.writeFileSync(path.join(st.cwd, process.env.FAKE_GROK_TOUCH_FILE), 'touched by fake-grok\n');
}

const summary =
  `Status: DONE\ngrok_model=${st.model} effort=${st.effort} perm_mode=${st.permMode} ` +
  `always_approve=${st.alwaysApprove} disallowed=${st.disallowedTools || 'none'} ` +
  `sandbox=${st.sandbox} denies=${st.denies.join(';') || 'none'} ` +
  `resumed=${Boolean(st.resumeId)} session=${sessionId}\nprompt_echo=${prompt}`;

if (st.format === 'json') {
  if (process.env.FAKE_GROK_FAIL === '1') {
    process.stdout.write(
      JSON.stringify({
        type: 'error',
        message: 'Simulated grok ask failure',
        cwd: st.cwd,
      }) + '\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      text: summary,
      stopReason: 'end_turn',
      sessionId,
      requestId: 'req-fake-ask',
    }) + '\n'
  );
  process.exit(0);
}

if (st.format === 'streaming-json') {
  process.stdout.write(JSON.stringify({ type: 'available_commands', tools: ['read_file'] }) + '\n');
  if (process.env.FAKE_GROK_FAIL === '1') {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'Simulated grok error' }) + '\n');
    process.exit(1);
  }
  if (process.env.FAKE_GROK_HOOK_STOP === '1') {
    process.stdout.write(
      JSON.stringify({
        type: 'end',
        stopReason: 'hook_stopped',
        error: 'Agent stopped by guard hook',
        sessionId,
      }) + '\n'
    );
    process.exit(1);
  }
  if (process.env.FAKE_GROK_MAX_TOKENS === '1') {
    process.stdout.write(JSON.stringify({ type: 'text', data: 'partial reply' }) + '\n');
    process.stdout.write(
      JSON.stringify({ type: 'end', stopReason: 'max_tokens', sessionId }) + '\n'
    );
    process.exit(0);
  }
  if (process.env.FAKE_GROK_PARTIAL_CRASH === '1') {
    process.stdout.write(JSON.stringify({ type: 'text', data: 'partial before crash' }) + '\n');
    process.exit(1);
  }
  if (process.env.FAKE_GROK_TOUCH_FILE) {
    process.stdout.write(
      JSON.stringify({
        type: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Edit',
        kind: 'edit',
        status: 'in_progress',
        toolName: 'search_replace',
        rawInput: { path: process.env.FAKE_GROK_TOUCH_FILE },
        content: [],
        locations: [],
      }) + '\n'
    );
    process.stdout.write(
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [],
        rawOutput: 'ok',
        locations: [{ path: process.env.FAKE_GROK_TOUCH_FILE }],
      }) + '\n'
    );
  }
  process.stdout.write(JSON.stringify({ type: 'thought', data: 'Checking workspace...' }) + '\n');
  const mid = Math.floor(summary.length / 2);
  process.stdout.write(JSON.stringify({ type: 'text', data: summary.slice(0, mid) }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'text', data: summary.slice(mid) }) + '\n');
  process.stdout.write(
    JSON.stringify({
      type: 'end',
      stopReason: 'end_turn',
      sessionId,
      requestId: 'req-fake-send',
    }) + '\n'
  );
  process.exit(0);
}

process.stdout.write(`${summary}\n`);
