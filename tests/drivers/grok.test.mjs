import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkTargetCliContract } from '../../src/contract-check.mjs';
import { grokDriver, resolveGrokModelAndEffort } from '../../src/drivers/grok.mjs';
import { BUILTIN_CONFIG, resolveTargetBinary } from '../../src/targets.mjs';
import { COSPAN_BIN as BIN, FAKE_FILES } from '../helpers/paths.mjs';

const { grok: FAKE_GROK } = FAKE_FILES;
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-grok-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function runCospan(args, { cwd, env = {}, input } = {}) {
  const cfgDir = `${cwd}-cospan-cfg`;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GROK_BIN: FAKE_GROK,
      COSPAN_HOME: cfgDir,
      COSPAN_CONFIG_DIR: cfgDir,
      ...env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('grok model/effort resolution handles inherit, shortcuts, max, and config validation', () => {
  const cfgAskMax = { defaults: { grok: { askEffort: ' MAX ' } }, mappings: {} };
  const cfgBad = { defaults: { grok: { effort: 'invalid-cfg' } }, mappings: {} };
  assert.deepEqual(resolveGrokModelAndEffort({ kind: 'send', config: BUILTIN_CONFIG }), {
    model: null,
    effort: 'high',
  });
  assert.deepEqual(resolveGrokModelAndEffort({ kind: 'ask', config: BUILTIN_CONFIG }), {
    model: null,
    effort: 'low',
  });
  assert.deepEqual(
    resolveGrokModelAndEffort({
      kind: 'send',
      model: 'build',
      effort: 'max',
      config: BUILTIN_CONFIG,
    }),
    { model: 'grok-4.7', effort: 'max' }
  );
  assert.deepEqual(
    resolveGrokModelAndEffort({ kind: 'send', model: 'fast', config: BUILTIN_CONFIG }),
    { model: 'grok-4.7-build-fast', effort: 'high' }
  );
  assert.deepEqual(
    resolveGrokModelAndEffort({
      kind: 'send',
      model: 'build-fast',
      effort: 'minimal',
      config: BUILTIN_CONFIG,
    }),
    { model: 'build-fast', effort: 'minimal' }
  );
  assert.deepEqual(resolveGrokModelAndEffort({ kind: 'ask', config: cfgAskMax }), {
    model: null,
    effort: 'max',
  });
  assert.throws(
    () => resolveGrokModelAndEffort({ kind: 'send', effort: 'bogus', config: BUILTIN_CONFIG }),
    /invalid --effort/
  );
  assert.throws(
    () => resolveGrokModelAndEffort({ kind: 'send', config: cfgBad }),
    /invalid --effort/
  );
});

test('grok 4-quadrant flags keep trailing -p, read-only filtering, and sandboxes', () => {
  const flag = (inv, name) => inv.args[inv.args.indexOf(name) + 1];
  const rwUnres = grokDriver.buildInvocation({
    kind: 'send',
    prompt: 'fix bug',
    model: 'grok-4.7',
    effort: 'max',
    workspace: '/repo',
  });
  assert.equal(rwUnres.args.at(-1), '-p');
  assert.ok(!rwUnres.args.includes('--add-dir') && !rwUnres.args.includes('--sandbox'));
  assert.ok(
    rwUnres.args.includes('--always-approve') && !rwUnres.args.includes('--disallowed-tools')
  );
  assert.equal(flag(rwUnres, '--reasoning-effort'), 'max');
  assert.equal(flag(rwUnres, '--output-format'), 'streaming-json');

  const roUnres = grokDriver.buildInvocation({
    kind: 'send',
    prompt: 'audit code',
    workspace: '/repo',
    readonly: true,
    conversationId: 'g-1',
  });
  assert.equal(roUnres.args.at(-1), '-p');
  assert.equal(flag(roUnres, '--resume'), 'g-1');
  assert.equal(flag(roUnres, '--permission-mode'), 'dontAsk');
  assert.ok(!roUnres.args.includes('--always-approve') && !roUnres.args.includes('--sandbox'));
  assert.equal(flag(roUnres, '--disallowed-tools'), 'search_replace,task');
  assert.ok(roUnres.args.includes('Bash(mkdir*)') && roUnres.args.includes('Bash(touch*)'));

  const rwRes = grokDriver.buildInvocation({
    kind: 'send',
    prompt: 'edit safely',
    workspace: '/repo',
    permissions: 'restricted',
  });
  assert.equal(rwRes.args.at(-1), '-p');
  assert.equal(flag(rwRes, '--permission-mode'), 'acceptEdits');
  assert.equal(flag(rwRes, '--sandbox'), 'workspace');

  const askRes = grokDriver.buildInvocation({
    kind: 'ask',
    prompt: 'ping',
    workspace: '/repo',
    permissions: 'restricted',
  });
  assert.equal(askRes.args.at(-1), '-p');
  assert.equal(flag(askRes, '--permission-mode'), 'dontAsk');
  assert.equal(flag(askRes, '--sandbox'), 'read-only');
  assert.equal(flag(askRes, '--output-format'), 'json');
});

test('grok foreground and stream protocol enforce end_turn and correlate tool calls', () => {
  const askFailCases = [
    [{ type: 'error', message: 'auth failed' }, '', 0, /auth failed/],
    [{ text: 'cut short', stopReason: 'max_tokens' }, '', 0, /stopReason=max_tokens/],
    [{ text: '', stopReason: 'hook_blocked', error: 'blocked by hook' }, '', 1, /blocked by hook/],
    [{ text: 'partial' }, 'boom', 1, /boom/],
    [{}, '', 0, /unexpected JSON payload/],
  ];
  for (const [obj, stderr, exitCode, re] of askFailCases) {
    assert.throws(
      () => grokDriver.parseForegroundOutput({ stdout: JSON.stringify(obj), stderr, exitCode }),
      re
    );
  }

  let seenId = null;
  const session = grokDriver.createStreamSession({ onConversation: (id) => (seenId = id) });
  session.acceptEvent({ type: 'available_commands', tools: ['read_file'] });
  session.acceptEvent({
    type: 'tool_call',
    toolCallId: 'call-1',
    title: 'Edit',
    kind: 'edit',
    toolName: 'search_replace',
    rawInput: { target_file: 'src/a.mjs' },
  });
  session.acceptEvent({
    type: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    rawOutput: 'ok',
  });
  assert.equal(session.snapshot().phase, 'editing');
  session.acceptEvent({
    type: 'tool_call',
    toolCallId: 'call-verify',
    toolName: 'run_terminal_cmd',
    rawInput: { command: 'npm test' },
  });
  assert.equal(session.snapshot().phase, 'verifying');
  session.acceptEvent({ type: 'tool_call', toolName: 'Delete', rawInput: { path: 'src/old.mjs' } });
  session.acceptEvent({
    type: 'tool_call',
    toolCallId: 'call-3',
    kind: 'edit',
    toolName: 'custom_writer',
    rawInput: { filePath: 'src/b.mjs' },
  });
  session.acceptEvent({ type: 'tool_call_update', toolCallId: 'call-3', status: 'cancelled' });
  const snap = session.snapshot();
  assert.equal(snap.recent_activities.length, 4);
  assert.equal(snap.recent_activities[0].status, 'done');
  assert.equal(snap.recent_activities[1].tool, 'run_terminal_cmd');
  assert.equal(snap.recent_activities[3].status, 'error');
  assert.deepEqual(snap.touched_files, ['src/a.mjs', 'src/old.mjs', 'src/b.mjs']);

  session.acceptEvent({ type: 'usage', usage: { input_tokens: 10, output_tokens: 4 } });
  session.acceptEvent({ type: 'text', data: 'Hello ' });
  session.acceptEvent({ type: 'text', data: 'Grok' });
  session.acceptEvent({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-s42' });
  const fin = session.finalize(0);
  assert.equal(seenId, 'grok-s42');
  assert.equal(fin.streamFailure, null);
  assert.equal(fin.payload.response, 'Hello Grok');
  assert.equal(fin.payload.conversation_id, 'grok-s42');
  assert.deepEqual(fin.payload.usage, { input_tokens: 10, output_tokens: 4 });
  assert.equal(fin.native.stop_reason, 'end_turn');
});

test('grok stream failures reject hook_stopped, max_tokens, crash, and truncated EOF', () => {
  const hookSess = grokDriver.createStreamSession();
  hookSess.acceptEvent({
    type: 'end',
    stopReason: 'hook_stopped',
    error: 'Stopped by guard',
    sessionId: 'g-h',
  });
  assert.deepEqual(
    { p: hookSess.finalize(1).payload, f: hookSess.finalize(1).streamFailure },
    { p: null, f: 'Stopped by guard' }
  );

  const maxSess = grokDriver.createStreamSession();
  maxSess.acceptEvent({ type: 'text', data: 'partial output' });
  maxSess.acceptEvent({ type: 'end', stopReason: 'max_tokens', sessionId: 'g-m' });
  const maxFin = maxSess.finalize(0);
  assert.equal(maxFin.payload, null);
  assert.match(maxFin.streamFailure, /max_tokens/);

  const crashSess = grokDriver.createStreamSession();
  crashSess.writeStderr('connection reset');
  crashSess.acceptEvent({ type: 'text', data: 'partial' });
  const crashFin = crashSess.finalize(1);
  assert.equal(crashFin.payload, null);
  assert.match(crashFin.streamFailure, /code 1: connection reset/);

  const truncSess = grokDriver.createStreamSession();
  truncSess.acceptEvent({ type: 'text', data: 'partial without end' });
  assert.deepEqual(
    { p: truncSess.finalize(0).payload, f: truncSess.finalize(0).streamFailure },
    { p: null, f: null }
  );

  const errSess = grokDriver.createStreamSession();
  errSess.acceptEvent({ type: 'error', message: 'backend boom' });
  errSess.acceptEvent({ type: 'end', stopReason: 'cancelled', sessionId: 'g-e' });
  const errFin = errSess.finalize(1);
  assert.equal(errFin.payload, null);
  assert.equal(errFin.streamFailure, 'backend boom');
});

test('grok CLI contract check validates 11 flags and ~/.grok/bin fallback resolves', () => {
  const okRes = checkTargetCliContract('grok', FAKE_GROK);
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  assert.ok(okRes.verified_flags >= 11);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-grok-disc-'));
  const prevEnv = Object.fromEntries(
    ['COSPAN_HOME', 'COSPAN_CONFIG_DIR', 'GROK_BIN', 'PATH', 'HOME', 'USERPROFILE'].map((k) => [
      k,
      process.env[k],
    ])
  );
  try {
    const drifted = path.join(tmpDir, 'drifted-grok.mjs');
    fs.writeFileSync(drifted, `#!/usr/bin/env node\nprocess.stdout.write('--single --cwd\\n');\n`);
    const driftRes = checkTargetCliContract('grok', drifted);
    assert.equal(driftRes.ok, false);
    assert.ok(driftRes.missing_flags.some((f) => f.includes('--sandbox')));
    assert.ok(driftRes.missing_flags.some((f) => f.includes('--deny')));

    const binName = process.platform === 'win32' ? 'grok.exe' : 'grok';
    const grokBinPath = path.join(tmpDir, '.grok', 'bin', binName);
    fs.mkdirSync(path.dirname(grokBinPath), { recursive: true });
    fs.writeFileSync(grokBinPath, '#!/bin/sh\necho fake\n', { mode: 0o755 });

    process.env.COSPAN_HOME = path.join(tmpDir, 'cospan-home');
    delete process.env.COSPAN_CONFIG_DIR;
    delete process.env.GROK_BIN;
    process.env.PATH = '';
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    assert.equal(resolveTargetBinary('grok'), grokBinPath);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, RM_OPTS);
  }
});

test('grok offline runtime handles ask, send->wait->continue, and error modes', () => {
  const repo = makeTempGitRepo();
  try {
    const askRes = runCospan(['ask', '--to', 'grok', '--model', 'fast', '--prompt', 'hello'], {
      cwd: repo,
    });
    assert.equal(askRes.code, 0, askRes.stderr);
    assert.match(askRes.stdout, /grok_model=grok-4\.7-build-fast effort=low/);

    const askFail = runCospan(['ask', '--to', 'grok', '--prompt', 'fail'], {
      cwd: repo,
      env: { FAKE_GROK_FAIL: '1' },
    });
    assert.equal(askFail.code, 1);
    assert.match(askFail.stderr, /Simulated grok ask failure/);

    const sendRes = runCospan(
      ['send', '--to', 'grok', '--readonly', '--json', '--prompt', 'Inspect src'],
      { cwd: repo, env: { FAKE_GROK_TOUCH_FILE: 'note.txt' } }
    );
    assert.equal(sendRes.code, 0, sendRes.stderr);
    const { job_id: job1 } = JSON.parse(sendRes.stdout);
    const wait1 = runCospan(['wait', job1, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait1.code, 0, wait1.stderr);
    assert.match(wait1.stdout, /status=done/);
    assert.match(wait1.stdout, /note\.txt/);
    const obs1 = JSON.parse(runCospan(['observe', job1], { cwd: repo }).stdout);
    assert.equal(obs1.status, 'done');
    assert.equal(obs1.native.stop_reason, 'end_turn');

    const contRes = runCospan(
      ['continue', '--last', '--to', 'grok', '--json', '--prompt', 'Follow-up'],
      {
        cwd: repo,
      }
    );
    assert.equal(contRes.code, 0, contRes.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(contRes.stdout);
    assert.equal(convId, 'grok-sess-999');
    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true session=grok-sess-999/);
    assert.match(wait2.stdout, /interactive_resume: grok --resume grok-sess-999/);

    for (const errEnv of [
      { FAKE_GROK_HOOK_STOP: '1' },
      { FAKE_GROK_MAX_TOKENS: '1' },
      { FAKE_GROK_PARTIAL_CRASH: '1' },
    ]) {
      const s = runCospan(['send', '--to', 'grok', '--json', '--prompt', 'Fail'], {
        cwd: repo,
        env: errEnv,
      });
      assert.equal(s.code, 0, s.stderr);
      const w = runCospan(['wait', JSON.parse(s.stdout).job_id, '--timeout', '10s'], { cwd: repo });
      assert.equal(w.code, 3, w.stdout);
      assert.doesNotMatch(w.stdout, /status=done/);
    }
  } finally {
    fs.rmSync(repo, RM_OPTS);
    fs.rmSync(`${repo}-cospan-cfg`, RM_OPTS);
  }
});
