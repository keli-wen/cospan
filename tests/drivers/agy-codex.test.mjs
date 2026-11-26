import test from 'node:test';
import assert from 'node:assert/strict';
import { agyDriver, resolveAgyModel } from '../../src/drivers/agy.mjs';
import { codexDriver, resolveCodexModelAndEffort } from '../../src/drivers/codex.mjs';
import { BUILTIN_CONFIG } from '../../src/targets.mjs';

test('agy model resolution: gemini-3.8-flash-medium default, mappings, and overrides', () => {
  const emptyCfg = { defaults: {}, mappings: {} };
  assert.equal(resolveAgyModel({ kind: 'send', config: emptyCfg }), 'gemini-3.8-flash-medium');
  assert.equal(resolveAgyModel({ kind: 'ask', config: emptyCfg }), 'gemini-3.8-flash-medium');
  assert.equal(
    resolveAgyModel({ kind: 'send', effort: 'high', config: emptyCfg }),
    'gemini-3.8-flash-high'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'gemini-3.8-flash', config: emptyCfg }),
    'gemini-3.8-flash-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'flash', effort: 'low', config: emptyCfg }),
    'gemini-3.8-flash-low'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'carbon', config: emptyCfg }),
    'gemini-4-carbon-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'argon', effort: 'low', config: emptyCfg }),
    'gemini-4-argon-low'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'hydrogen', config: BUILTIN_CONFIG }),
    'gemini-4-hydrogen-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'opus', config: BUILTIN_CONFIG }),
    'claude-opus-5-5-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'sonnet', config: BUILTIN_CONFIG }),
    'claude-sonnet-5-5-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'hydrogen', effort: 'xhigh', config: BUILTIN_CONFIG }),
    'gemini-4-hydrogen-xhigh'
  );
  assert.equal(
    resolveAgyModel({
      kind: 'send',
      model: 'gemini-4-hydrogen',
      effort: 'xhigh',
      config: emptyCfg,
    }),
    'gemini-4-hydrogen-xhigh'
  );
  assert.equal(
    resolveAgyModel({
      kind: 'send',
      model: 'gemini-4-hydrogen-xhigh',
      effort: 'medium',
      config: emptyCfg,
    }),
    'gemini-4-hydrogen-medium'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'carbon', effort: 'xhigh', config: BUILTIN_CONFIG }),
    'gemini-4-carbon-high'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'gpt-oss-120b-medium', config: emptyCfg }),
    'gpt-oss-120b-medium'
  );

  const customCfg = {
    defaults: { agy: { model: 'gemini-4-carbon-medium', effort: 'medium' } },
    mappings: { agy: { fast: 'gemini-3.7-flash' } },
  };
  assert.equal(resolveAgyModel({ kind: 'send', config: customCfg }), 'gemini-4-carbon-medium');
  assert.equal(
    resolveAgyModel({ kind: 'send', model: 'fast', config: customCfg }),
    'gemini-3.7-flash-medium'
  );

  const hydrogenDefaultCfg = {
    defaults: { agy: { model: 'gemini-4-hydrogen-xhigh' } },
    mappings: {},
  };
  assert.equal(
    resolveAgyModel({ kind: 'send', config: hydrogenDefaultCfg }),
    'gemini-4-hydrogen-xhigh'
  );
  assert.equal(
    resolveAgyModel({ kind: 'send', effort: 'low', config: hydrogenDefaultCfg }),
    'gemini-4-hydrogen-low'
  );

  // Custom non-family default model + --effort must NOT fall back to gemini-3.8-flash
  const customEnterpriseCfg = {
    defaults: { agy: { model: 'custom-enterprise-model' } },
    mappings: {},
  };
  assert.equal(
    resolveAgyModel({ kind: 'send', effort: 'high', config: customEnterpriseCfg }),
    'custom-enterprise-model'
  );
  assert.equal(
    resolveAgyModel({
      kind: 'send',
      effort: 'high',
      config: { defaults: { agy: { model: 'custom-enterprise-model-medium' } }, mappings: {} },
    }),
    'custom-enterprise-model-medium'
  );
  assert.equal(
    resolveAgyModel({
      kind: 'send',
      model: 'my-org/custom-model',
      effort: 'high',
      config: emptyCfg,
    }),
    'my-org/custom-model'
  );
});

test('agy neon model resolution: medium default and low|medium|high|xhigh tiers', () => {
  const emptyCfg = { defaults: {}, mappings: {} };
  const resolve = (model, effort, config = BUILTIN_CONFIG) =>
    resolveAgyModel({ kind: 'send', model, effort, config });
  assert.equal(resolve('neon'), 'gemini-4-neon-medium');
  assert.equal(resolve('gemini-4-neon', undefined, emptyCfg), 'gemini-4-neon-medium');
  assert.equal(resolve('neon', 'low'), 'gemini-4-neon-low');
  assert.equal(resolve('neon', 'high'), 'gemini-4-neon-high');
  assert.equal(resolve('neon', 'xhigh'), 'gemini-4-neon-xhigh');
  assert.equal(resolve('neon', 'max'), 'gemini-4-neon-xhigh');
  assert.equal(resolve('gemini-4-neon-xhigh', 'medium', emptyCfg), 'gemini-4-neon-medium');
  const neonDefaultCfg = { defaults: { agy: { model: 'gemini-4-neon-high' } }, mappings: {} };
  assert.equal(resolve(undefined, undefined, neonDefaultCfg), 'gemini-4-neon-high');
  assert.equal(resolve(undefined, 'low', neonDefaultCfg), 'gemini-4-neon-low');
});

test('agy invocation flags: unrestricted default vs restricted sandbox', () => {
  const rw = agyDriver.buildInvocation({
    kind: 'send',
    prompt: 'fix bug',
    model: 'gemini-3.8-flash-low',
    timeout: '60m',
    workspace: '/repo',
    readonly: false,
  });
  assert.ok(!rw.args.includes('-p'));
  assert.equal(rw.stdinText, 'fix bug');
  assert.ok(rw.args.includes('--dangerously-skip-permissions'));
  assert.ok(!rw.args.includes('--sandbox'));
  assert.ok(!rw.args.includes('--mode'));

  const ro = agyDriver.buildInvocation({
    kind: 'send',
    prompt: 'review diff',
    model: 'gemini-3.8-flash-low',
    timeout: '60m',
    workspace: '/repo',
    readonly: true,
    conversationId: 'conv-1',
  });
  assert.ok(!ro.args.includes('-p'));
  assert.equal(ro.stdinText, 'review diff');
  assert.ok(ro.args.includes('--mode'));
  assert.equal(ro.args[ro.args.indexOf('--mode') + 1], 'plan');
  assert.ok(ro.args.includes('--dangerously-skip-permissions'));
  assert.equal(ro.args[ro.args.indexOf('--conversation') + 1], 'conv-1');

  const askUnrestricted = agyDriver.buildInvocation({
    kind: 'ask',
    prompt: 'ping',
    model: 'gemini-3.8-flash-low',
    timeout: '2m',
    workspace: '/repo',
  });
  assert.ok(!askUnrestricted.args.includes('-p'));
  assert.equal(askUnrestricted.stdinText, 'ping');
  assert.ok(askUnrestricted.args.includes('--dangerously-skip-permissions'));
  assert.equal(askUnrestricted.args[askUnrestricted.args.indexOf('--output-format') + 1], 'json');

  const restricted = agyDriver.buildInvocation({
    kind: 'send',
    prompt: 'sandboxed task',
    model: 'gemini-3.8-flash-low',
    timeout: '60m',
    workspace: '/repo',
    readonly: false,
    permissions: 'restricted',
  });
  assert.equal(restricted.stdinText, 'sandboxed task');
  assert.ok(!restricted.args.includes('--dangerously-skip-permissions'));
  assert.ok(restricted.args.includes('--sandbox'));
});

test('codex model resolution, unrestricted default, and restricted flag asymmetry', () => {
  const emptyCfg = { defaults: {}, mappings: {} };
  assert.deepEqual(resolveCodexModelAndEffort({ kind: 'send', config: emptyCfg }), {
    model: 'gpt-6.2-sol',
    effort: 'high',
  });
  assert.deepEqual(resolveCodexModelAndEffort({ kind: 'ask', config: emptyCfg }), {
    model: 'gpt-6.2-sol',
    effort: 'low',
  });
  assert.deepEqual(resolveCodexModelAndEffort({ kind: 'send', model: 'astra', config: emptyCfg }), {
    model: 'gpt-6.2-astra',
    effort: 'high',
  });
  assert.deepEqual(
    resolveCodexModelAndEffort({ kind: 'send', model: 'terra', effort: 'xhigh', config: emptyCfg }),
    {
      model: 'gpt-6.1-terra',
      effort: 'xhigh',
    }
  );
  assert.deepEqual(
    resolveCodexModelAndEffort({
      kind: 'send',
      model: 'spark',
      effort: 'minimal',
      config: emptyCfg,
    }),
    {
      model: 'gpt-5.3-codex-spark',
      effort: 'minimal',
    }
  );
  assert.deepEqual(
    resolveCodexModelAndEffort({
      kind: 'send',
      config: { defaults: { codex: { model: 'inherit', effort: 'inherit' } }, mappings: {} },
    }),
    { model: null, effort: null }
  );
  // Single-hop lookup (never recursive) and unknown IDs pass through untouched
  assert.deepEqual(
    resolveCodexModelAndEffort({
      kind: 'send',
      model: 'hop1',
      config: { defaults: {}, mappings: { codex: { hop1: 'hop2', hop2: 'gpt-6.1-terra' } } },
    }),
    { model: 'hop2', effort: 'high' }
  );
  assert.deepEqual(
    resolveCodexModelAndEffort({
      kind: 'send',
      model: 'openai/gpt-custom-preview',
      config: emptyCfg,
    }),
    { model: 'openai/gpt-custom-preview', effort: 'high' }
  );

  // Default (`permissions: "unrestricted"`) bypasses approvals/sandbox for writable & readonly
  const initialRw = codexDriver.buildInvocation({
    kind: 'send',
    prompt: 'apply patch',
    model: 'gpt-6.2-sol',
    effort: 'high',
    workspace: '/repo',
    readonly: false,
  });
  assert.ok(initialRw.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!initialRw.args.includes('-s'));

  const initialRoUnrestricted = codexDriver.buildInvocation({
    kind: 'send',
    prompt: 'inspect repo across caches',
    model: 'gpt-6.2-sol',
    effort: 'high',
    workspace: '/repo',
    readonly: true,
  });
  assert.ok(initialRoUnrestricted.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(initialRoUnrestricted.stdinText, 'inspect repo across caches');

  // Opt-in `permissions: "restricted"` enables Seatbelt `-s` on exec and `-c sandbox_mode=...`
  // on resume
  const restrictedRw = codexDriver.buildInvocation({
    kind: 'send',
    prompt: 'apply patch safely',
    model: 'gpt-6.2-sol',
    effort: 'high',
    workspace: '/repo',
    readonly: false,
    permissions: 'restricted',
  });
  assert.equal(restrictedRw.args[restrictedRw.args.indexOf('-s') + 1], 'workspace-write');
  assert.ok(!restrictedRw.args.includes('--dangerously-bypass-approvals-and-sandbox'));

  // Resume MUST NOT pass -C or -s (rejected by codex exec resume) in either permission mode
  const resumeUnrestricted = codexDriver.buildInvocation({
    kind: 'send',
    prompt: 'follow up',
    model: 'gpt-6.2-sol',
    effort: 'high',
    workspace: '/repo',
    readonly: false,
    conversationId: 'thr-42',
  });
  assert.deepEqual(resumeUnrestricted.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(!resumeUnrestricted.args.includes('-C'));
  assert.ok(!resumeUnrestricted.args.includes('-s'));
  assert.ok(resumeUnrestricted.args.includes('--dangerously-bypass-approvals-and-sandbox'));

  const resumeRestrictedRo = codexDriver.buildInvocation({
    kind: 'send',
    prompt: 'follow up readonly',
    model: 'gpt-6.2-sol',
    effort: 'high',
    workspace: '/repo',
    readonly: true,
    permissions: 'restricted',
    conversationId: 'thr-42',
  });
  assert.deepEqual(resumeRestrictedRo.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(!resumeRestrictedRo.args.includes('-C'));
  assert.ok(!resumeRestrictedRo.args.includes('-s'));
  assert.ok(resumeRestrictedRo.args.some((x) => x.includes('sandbox_mode="read-only"')));
  assert.equal(resumeRestrictedRo.args.at(-2), 'thr-42');
  assert.equal(resumeRestrictedRo.args.at(-1), '-');
  assert.equal(resumeRestrictedRo.cwd, '/repo');
});

test('codex stream session projects ThreadEvents and keeps last agent_message', () => {
  let seenThread = null;
  const session = codexDriver.createStreamSession({
    onConversation: (id) => {
      seenThread = id;
    },
  });

  session.acceptEvent({ type: 'thread.started', thread_id: 'thr-abc' });
  assert.equal(seenThread, 'thr-abc');

  session.acceptEvent({
    type: 'item.completed',
    item: { id: 'msg1', type: 'agent_message', text: 'Let me check files first.' },
  });
  session.acceptEvent({
    type: 'item.completed',
    item: {
      id: 'cmd1',
      type: 'command_execution',
      command: 'rg foo',
      aggregated_output: 'bar.js:1:foo',
      exit_code: 0,
      status: 'completed',
    },
  });
  session.acceptEvent({
    type: 'item.completed',
    item: { id: 'msg2', type: 'agent_message', text: 'Status: DONE\nFound foo in bar.js.' },
  });
  session.acceptEvent({
    type: 'turn.completed',
    usage: {
      input_tokens: 50,
      cached_input_tokens: 10,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    },
  });

  const snap = session.snapshot();
  assert.equal(snap.recent_activities.length, 1);
  assert.equal(snap.recent_activities[0].tool, 'command_execution');
  assert.equal(snap.latest_text.text, 'Status: DONE\nFound foo in bar.js.');

  const fin = session.finalize(0);
  assert.equal(fin.payload.conversation_id, 'thr-abc');
  assert.equal(fin.payload.response, 'Status: DONE\nFound foo in bar.js.');
});
