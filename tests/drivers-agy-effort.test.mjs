import test from 'node:test';
import assert from 'node:assert/strict';
import { isAgyEffortFamily, resolveAgyModel } from '../src/drivers/agy.mjs';
import { BUILTIN_CONFIG } from '../src/targets.mjs';

test('isAgyEffortFamily matches known and future versioned Gemini/Claude families only', () => {
  for (const name of [
    'gemini-4-neon',
    'gemini-4.1-neon',
    'gemini-3.9-flash',
    'gemini-5-pro',
    'claude-opus-5-6',
    'claude-sonnet-5-6',
    'claude-haiku-5-6',
    'Gemini-4.2-Pro',
  ]) {
    assert.equal(isAgyEffortFamily(name), true, `expected ${name} to match agy effort family`);
  }
  for (const name of [
    '',
    null,
    'custom-enterprise-model',
    'custom-enterprise-model-medium',
    'my-org/custom-model',
    'my-org/gemini-4-neon',
    'gpt-oss-120b-medium',
    'claude-custom-1',
  ]) {
    assert.equal(isAgyEffortFamily(name), false, `expected ${name} not to match agy effort family`);
  }
});

test('resolveAgyModel generalizes future Gemini/Claude effort suffixes cleanly', () => {
  const emptyCfg = { defaults: {}, mappings: {} };
  const resolve = (model, effort, config = emptyCfg) =>
    resolveAgyModel({ kind: 'send', model, effort, config });

  // Future Gemini families default to medium, accept xhigh & max -> xhigh, and override cleanly
  assert.equal(resolve('gemini-4.1-neon'), 'gemini-4.1-neon-medium');
  assert.equal(resolve('gemini-4.1-neon', 'low'), 'gemini-4.1-neon-low');
  assert.equal(resolve('gemini-4.1-neon', 'xhigh'), 'gemini-4.1-neon-xhigh');
  assert.equal(resolve('gemini-4.1-neon', 'max'), 'gemini-4.1-neon-xhigh');
  assert.equal(resolve('gemini-4.1-neon-xhigh'), 'gemini-4.1-neon-xhigh');
  assert.equal(resolve('gemini-4.1-neon-xhigh', 'medium'), 'gemini-4.1-neon-medium');
  assert.equal(resolve('gemini-3.9-flash', 'high'), 'gemini-3.9-flash-high');
  assert.equal(resolve('gemini-3.9-flash-medium'), 'gemini-3.9-flash-medium');
  assert.equal(resolve('gemini-3.9-flash-medium', 'low'), 'gemini-3.9-flash-low');

  // Future Claude families append effort, override cleanly, and clamp xhigh -> high
  assert.equal(resolve('claude-opus-5-6'), 'claude-opus-5-6-medium');
  assert.equal(resolve('claude-opus-5-6', 'high'), 'claude-opus-5-6-high');
  assert.equal(resolve('claude-opus-5-6', 'xhigh'), 'claude-opus-5-6-high');
  assert.equal(resolve('claude-sonnet-5-6-low'), 'claude-sonnet-5-6-low');
  assert.equal(resolve('claude-sonnet-5-6-low', 'high'), 'claude-sonnet-5-6-high');
  assert.equal(resolve('claude-haiku-5-6', 'low'), 'claude-haiku-5-6-low');

  // Existing known-family clamping & xhigh support remain intact
  assert.equal(resolve('gemini-4-carbon', 'xhigh', BUILTIN_CONFIG), 'gemini-4-carbon-high');
  assert.equal(resolve('gemini-4-carbon-medium', 'xhigh'), 'gemini-4-carbon-high');
  assert.equal(resolve('gemini-3.8-flash-medium'), 'gemini-3.8-flash-medium');
  assert.equal(resolve('gemini-3.8-flash-medium', 'xhigh'), 'gemini-3.8-flash-high');
  assert.equal(resolve('gemini-4-neon', 'xhigh'), 'gemini-4-neon-xhigh');
  assert.equal(resolve('gemini-4-hydrogen', 'xhigh'), 'gemini-4-hydrogen-xhigh');

  // Non-family custom/enterprise models pass through verbatim even with --effort
  assert.equal(resolve('custom-enterprise-model', 'high'), 'custom-enterprise-model');
  assert.equal(resolve('custom-enterprise-model-medium', 'high'), 'custom-enterprise-model-medium');
  assert.equal(resolve('my-org/custom-model', 'high'), 'my-org/custom-model');
  assert.equal(resolve('my-org/gemini-4-neon', 'high'), 'my-org/gemini-4-neon');
  assert.equal(resolve('gpt-oss-120b-medium', 'high'), 'gpt-oss-120b-medium');
});
