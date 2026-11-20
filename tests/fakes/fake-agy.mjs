#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('agy version 1.5.5-fake\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  process.stdout.write(
    '--print --model --output-format --print-timeout --add-dir ' +
      '--conversation --mode --dangerously-skip-permissions --sandbox\n'
  );
  process.exit(0);
}

let prompt = null;
let model = '';
let format = 'text';
let conversation = null;
let mode = 'auto';
let skipPerms = false;
let sandbox = false;
let workspace = process.cwd();

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--print' || a === '--prompt') prompt = argv[++i] || '';
  else if (a === '--model') model = argv[++i] || '';
  else if (a === '--output-format') format = argv[++i] || 'text';
  else if (a === '--conversation') conversation = argv[++i] || null;
  else if (a === '--mode') mode = argv[++i] || 'auto';
  else if (a === '--add-dir') workspace = argv[++i] || workspace;
  else if (a === '--dangerously-skip-permissions') skipPerms = true;
  else if (a === '--sandbox') sandbox = true;
}

if (prompt === null) prompt = fs.readFileSync(0, 'utf8');

const convId = conversation || 'agy-conv-12345';
const delayMs = Number(process.env.FAKE_AGY_DELAY_MS || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_AGY_TOUCH_FILE) {
  fs.writeFileSync(path.join(workspace, process.env.FAKE_AGY_TOUCH_FILE), 'touched by fake-agy\n');
}

if (format === 'json') {
  if (delayMs > 0) await sleep(delayMs);
  if (process.env.FAKE_AGY_FAIL === '1') {
    process.stderr.write('AGY_ERROR: {"status":"INTERNAL","error_code":500,"retryable":false}\n');
    process.stdout.write(
      JSON.stringify({ status: 'ERROR', error: 'Simulated agy failure' }) + '\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      status: 'OK',
      conversation_id: convId,
      response:
        `AGY_ASK_OK model=${model} mode=${mode} skip_perms=${skipPerms} ` +
        `sandbox=${sandbox} prompt_len=${prompt.length}`,
      stats: { input_tokens: 12, output_tokens: 8 },
    }) + '\n'
  );
  process.exit(0);
}

// stream-json
process.stdout.write(
  JSON.stringify({ event: 'init', init: { conversation_id: convId, model } }) + '\n'
);

if (process.env.FAKE_AGY_HANG === '1') {
  await sleep(60000);
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1,
      step_type: 'tool',
      state: 'DONE',
      tool_name: 'read_file',
      tool_info: { parameters: { Path: 'README.md' }, output: 'ok' },
    },
  }) + '\n'
);

if (delayMs > 0) await sleep(delayMs);

if (process.env.FAKE_AGY_FAIL === '1') {
  process.stderr.write(
    'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true}\n'
  );
  process.stdout.write(
    JSON.stringify({
      event: 'result',
      result: { status: 'ERROR', error: 'Quota exhausted in fake-agy', conversation_id: convId },
    }) + '\n'
  );
  process.exit(1);
}

const summary =
  `Status: DONE\nagy_model=${model} mode=${mode} skip_perms=${skipPerms} ` +
  `sandbox=${sandbox} resumed=${!!conversation} conv=${convId}\nprompt_echo=${prompt}`;

process.stdout.write(
  JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 2,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: summary,
    },
  }) + '\n'
);

process.stdout.write(
  JSON.stringify({
    event: 'result',
    result: {
      status: 'OK',
      conversation_id: convId,
      response: summary,
      stats: { input_tokens: 50, output_tokens: 25 },
    },
  }) + '\n'
);
