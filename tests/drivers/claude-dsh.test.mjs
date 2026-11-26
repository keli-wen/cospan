import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTargetCliContract } from '../../src/contract-check.mjs';
import { claudeDriver, resolveClaudeModelAndEffort } from '../../src/drivers/claude.mjs';
import { dshDriver, resolveDshModelAndEffort } from '../../src/drivers/dsh.mjs';
import { extractDshAgentDefaultModelFromText } from '../../src/drivers/dsh-protocol.mjs';
import { listActiveTargetIds } from '../../src/drivers/index.mjs';
import { FAKE_FILES } from '../helpers/paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX, claude: FAKE_CLAUDE, dsh: FAKE_DSH } = FAKE_FILES;

test('active target registry exposes full 4-harness quartet', () => {
  assert.deepEqual(listActiveTargetIds(), ['agy', 'codex', 'claude', 'dsh']);
});

test('claude model/effort resolution and 4-quadrant permission/readonly flags', () => {
  const emptyCfg = { defaults: {}, mappings: {} };
  assert.deepEqual(resolveClaudeModelAndEffort({ kind: 'send', config: emptyCfg }), {
    model: 'sonnet',
    effort: 'high',
  });
  assert.deepEqual(resolveClaudeModelAndEffort({ kind: 'ask', config: emptyCfg }), {
    model: 'sonnet',
    effort: 'low',
  });
  assert.deepEqual(
    resolveClaudeModelAndEffort({ kind: 'send', model: 'opus', effort: 'max', config: emptyCfg }),
    {
      model: 'opus',
      effort: 'max',
    }
  );
  assert.deepEqual(
    resolveClaudeModelAndEffort({ kind: 'send', model: 'opus5.5', config: emptyCfg }),
    {
      model: 'opus',
      effort: 'high',
    }
  );
  assert.deepEqual(
    resolveClaudeModelAndEffort({
      kind: 'send',
      model: 'inherit',
      effort: 'inherit',
      config: emptyCfg,
    }),
    {
      model: null,
      effort: null,
    }
  );

  // 1. unrestricted + writable
  const rwUnres = claudeDriver.buildInvocation({
    kind: 'send',
    prompt: 'fix auth',
    model: 'sonnet',
    effort: 'high',
    workspace: '/repo',
    readonly: false,
  });
  assert.ok(rwUnres.args.includes('--output-format'));
  assert.equal(rwUnres.args[rwUnres.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(rwUnres.args.includes('--verbose'));
  assert.ok(rwUnres.args.includes('--dangerously-skip-permissions'));
  assert.ok(!rwUnres.args.includes('--disallowed-tools'));
  assert.equal(rwUnres.stdinText, 'fix auth');

  // 2. unrestricted + readonly
  const roUnres = claudeDriver.buildInvocation({
    kind: 'send',
    prompt: 'review auth',
    model: 'sonnet',
    effort: 'high',
    workspace: '/repo',
    readonly: true,
    conversationId: 'sess-123',
  });
  assert.ok(roUnres.args.includes('--dangerously-skip-permissions'));
  assert.equal(
    roUnres.args[roUnres.args.indexOf('--disallowed-tools') + 1],
    'Edit,Write,NotebookEdit'
  );
  assert.equal(roUnres.args[roUnres.args.indexOf('--resume') + 1], 'sess-123');

  // 3. restricted + writable
  const rwRes = claudeDriver.buildInvocation({
    kind: 'send',
    prompt: 'apply edit safely',
    model: 'sonnet',
    effort: 'medium',
    workspace: '/repo',
    readonly: false,
    permissions: 'restricted',
  });
  assert.ok(!rwRes.args.includes('--dangerously-skip-permissions'));
  assert.equal(rwRes.args[rwRes.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(rwRes.args[rwRes.args.indexOf('--permission-prompts') + 1], 'none');

  // 4. restricted + readonly / ask
  const askRes = claudeDriver.buildInvocation({
    kind: 'ask',
    prompt: 'ping',
    model: 'sonnet',
    effort: 'low',
    workspace: '/repo',
    permissions: 'restricted',
  });
  assert.ok(askRes.args.includes('--restricted'));
  assert.ok(askRes.args.includes('--no-session-persistence'));
  assert.equal(askRes.args[askRes.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(askRes.args[askRes.args.indexOf('--output-format') + 1], 'json');
});

test('claude stream session projects tool_use, touched_files, tool_result, and result', () => {
  let seenSession = null;
  const session = claudeDriver.createStreamSession({
    onConversation: (id) => {
      seenSession = id;
    },
  });

  session.acceptEvent({ type: 'system', subtype: 'init', session_id: 'claude-s1' });
  assert.equal(seenSession, 'claude-s1');

  session.acceptEvent({
    type: 'assistant',
    session_id: 'claude-s1',
    message: {
      content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'src/app.mjs' } }],
    },
  });
  assert.equal(session.snapshot().phase, 'editing');
  assert.deepEqual(session.snapshot().touched_files, ['src/app.mjs']);

  session.acceptEvent({
    type: 'user',
    session_id: 'claude-s1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'updated', is_error: false }],
    },
  });
  session.acceptEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'claude-s1',
    result: 'Status: DONE\nUpdated src/app.mjs.',
    usage: { input_tokens: 42, output_tokens: 15 },
    total_cost_usd: 0.01,
  });

  const fin = session.finalize(0);
  assert.equal(fin.streamFailure, null);
  assert.equal(fin.payload.conversation_id, 'claude-s1');
  assert.equal(fin.payload.response, 'Status: DONE\nUpdated src/app.mjs.');
  assert.equal(fin.native.subtype, 'success');
});

test('dsh model/effort resolution, out-of-tree --patch overlay, and stream projection', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-unit-'));
  const prevHome = process.env.COSPAN_HOME;
  process.env.COSPAN_HOME = tmpHome;
  try {
    const emptyCfg = { defaults: {}, mappings: {} };
    assert.deepEqual(resolveDshModelAndEffort({ kind: 'send', config: emptyCfg }), {
      model: null,
      effort: null,
    });
    assert.deepEqual(
      resolveDshModelAndEffort({ kind: 'send', model: 'pro', effort: 'xhigh', config: emptyCfg }),
      {
        model: 'deepseek-v4-pro',
        effort: 'max',
      }
    );
    assert.deepEqual(
      resolveDshModelAndEffort({ kind: 'send', model: 'v4.1-flash', config: emptyCfg }),
      {
        model: 'deepseek-flash',
        effort: null,
      }
    );
    assert.deepEqual(resolveDshModelAndEffort({ kind: 'send', model: 'chat', config: emptyCfg }), {
      model: 'chat',
      effort: null,
    });

    // Default inherit omits --patch completely so user profile model is preserved
    const invInherit = dshDriver.buildInvocation({
      kind: 'send',
      prompt: 'check tests',
      model: null,
      effort: null,
      workspace: '/repo',
      readonly: false,
    });
    assert.ok(!invInherit.args.includes('--patch'));
    assert.deepEqual(invInherit.args.slice(0, 3), ['--profile', 'headless', '--json']);
    assert.equal(
      invInherit.args[invInherit.args.indexOf('--permission-mode') + 1],
      'danger-full-access'
    );
    assert.equal(invInherit.args.at(-1), '-');

    // Explicit model/effort generates out-of-tree patch BEFORE --json
    const invPatched = dshDriver.buildInvocation({
      kind: 'send',
      prompt: 'deep fix',
      model: 'deepseek-v4-pro',
      effort: 'max',
      workspace: '/repo',
      readonly: true,
      permissions: 'restricted',
      conversationId: 'dsh-s9',
    });
    const patchIdx = invPatched.args.indexOf('--patch');
    const jsonIdx = invPatched.args.indexOf('--json');
    assert.ok(patchIdx > 0 && patchIdx < jsonIdx, '--patch launcher flag must precede --json');
    const patchFile = invPatched.args[patchIdx + 1];
    assert.ok(patchFile.startsWith(tmpHome), 'patch file must live out-of-tree under COSPAN_HOME');
    const patchJson = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
    assert.deepEqual(patchJson, [
      {
        id: 'agent-default-model',
        config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      },
    ]);
    assert.equal(invPatched.args[invPatched.args.indexOf('--permission-mode') + 1], 'read-only');
    assert.equal(invPatched.args[invPatched.args.indexOf('--session-id') + 1], 'dsh-s9');

    // Stream projection
    let seenSession = null;
    const sess = dshDriver.createStreamSession({ onConversation: (id) => (seenSession = id) });
    sess.acceptEvent({ type: 'session', sessionId: 'dsh-s9' });
    sess.acceptEvent({ type: 'tool_call', id: 'c1', name: 'write_file', input: { path: 'a.txt' } });
    sess.acceptEvent({ type: 'tool_result', id: 'c1', name: 'write_file', output: 'ok' });
    sess.acceptEvent({ type: 'text', delta: 'Part 1 ' });
    sess.acceptEvent({ type: 'text', delta: 'Part 2' });
    sess.acceptEvent({ type: 'final', sessionId: 'dsh-s9', text: 'Part 1 Part 2' });
    assert.equal(seenSession, 'dsh-s9');
    assert.deepEqual(sess.snapshot().touched_files, ['a.txt']);
    assert.equal(sess.finalize(0).payload.response, 'Part 1 Part 2');
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('dsh inherit + --effort preserves DSH_HOME model without deepseek-flash fallback', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-inherit-'));
  const tmpDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-home-'));
  const prevHome = process.env.COSPAN_HOME;
  const prevDshHome = process.env.DSH_HOME;
  const prevDshBin = process.env.DSH_BIN;
  process.env.COSPAN_HOME = tmpHome;
  process.env.DSH_HOME = tmpDsh;
  process.env.DSH_BIN = FAKE_DSH;
  try {
    assert.throws(
      () =>
        dshDriver.buildInvocation({
          kind: 'send',
          prompt: 'hi',
          model: null,
          effort: 'high',
          workspace: '/repo',
        }),
      /cannot apply --effort "high" for dsh when model is "inherit"/
    );

    fs.mkdirSync(path.join(tmpDsh, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDsh, 'profiles', 'headless', 'cordis.patch.yml'),
      `- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n` +
        `  config:\n    provider: custom-prov\n    model: deepseek-v4-pro\n`
    );
    const invProfile = dshDriver.buildInvocation({
      kind: 'send',
      prompt: 'hi',
      model: null,
      effort: 'high',
      workspace: '/repo',
    });
    const pIdx1 = invProfile.args.indexOf('--patch');
    const patch1 = JSON.parse(fs.readFileSync(invProfile.args[pIdx1 + 1], 'utf8'));
    assert.deepEqual(patch1, [
      {
        id: 'agent-default-model',
        config: { provider: 'custom-prov', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      },
    ]);

    fs.writeFileSync(
      path.join(tmpDsh, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'agent-default-model',
          config: { provider: 'home-prov', model: 'home-model' },
        },
      ])
    );
    const invHome = dshDriver.buildInvocation({
      kind: 'send',
      prompt: 'hi',
      model: null,
      effort: 'max',
      workspace: '/repo',
    });
    const pIdx2 = invHome.args.indexOf('--patch');
    const patch2 = JSON.parse(fs.readFileSync(invHome.args[pIdx2 + 1], 'utf8'));
    assert.deepEqual(patch2, [
      {
        id: 'agent-default-model',
        config: { provider: 'home-prov', model: 'home-model', reasoningEffort: 'max' },
      },
    ]);

    assert.deepEqual(
      extractDshAgentDefaultModelFromText(
        '- id: other\n  config:\n    foo: bar\n' +
          '- id: agent-default-model\n  config:\n    provider: "p1"\n    model: \'m1\' # comment\n'
      ),
      { provider: 'p1', model: 'm1' }
    );
  } finally {
    if (prevHome === undefined) delete process.env.COSPAN_HOME;
    else process.env.COSPAN_HOME = prevHome;
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    if (prevDshBin === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = prevDshBin;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpDsh, { recursive: true, force: true });
  }
});

test('zero-token CLI contract checker validates all 4 fakes and detects flag drift', () => {
  for (const [id, bin] of [
    ['agy', FAKE_AGY],
    ['codex', FAKE_CODEX],
    ['claude', FAKE_CLAUDE],
    ['dsh', FAKE_DSH],
  ]) {
    const res = checkTargetCliContract(id, bin);
    assert.equal(res.ok, true, `${id} contract check failed: ${JSON.stringify(res)}`);
    assert.ok(res.verified_flags >= 5);
  }

  // Simulate upstream CLI dropping `--verbose` and `--permission-prompts`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-drift-'));
  try {
    const driftedClaude = path.join(tmpDir, 'drifted-claude.mjs');
    fs.writeFileSync(
      driftedClaude,
      `#!/usr/bin/env node\nprocess.stdout.write('--print --output-format --model\\n');\n`
    );
    const driftRes = checkTargetCliContract('claude', driftedClaude);
    assert.equal(driftRes.ok, false);
    assert.ok(driftRes.missing_flags.some((f) => f.includes('--verbose')));
    assert.ok(driftRes.missing_flags.some((f) => f.includes('--permission-prompts')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
