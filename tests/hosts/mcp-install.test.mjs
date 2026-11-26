import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  durationToMs,
  JOB_EXIT_CODES,
  main,
  parseCliArgs,
  repoRoot,
  workspaceStateDir,
} from '../../src/cli.mjs';
import { installForAgyHost, installForCodexHost } from '../../src/installer.mjs';
import { TARGET_MODEL_SHORTCUTS } from '../../src/config.mjs';
import { listWorkspaceBoard } from '../../src/sidebar-state.mjs';
import { apply as applyDshPlugin } from '../../dsh/index.mjs';
import { FAKE_FILES, MCP_SERVER } from '../helpers/paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX, claude: FAKE_CLAUDE, dsh: FAKE_DSH } = FAKE_FILES;

function assertVerbatimSkillContract(skillText, targetId) {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/.exec(skillText);
  assert.ok(frontmatterMatch, `${targetId} SKILL.md must include YAML frontmatter`);
  const descLine = frontmatterMatch[1].split('\n').find((line) => line.startsWith('description:'));
  assert.ok(descLine, `${targetId} frontmatter must include description`);
  for (const shortcut of TARGET_MODEL_SHORTCUTS[targetId]) {
    assert.ok(
      descLine.includes(shortcut),
      `${targetId} frontmatter description must include shortcut "${shortcut}"`
    );
    assert.ok(
      skillText.includes(`\`${shortcut}\``),
      `${targetId} skill body must list shortcut "${shortcut}"`
    );
  }
  assert.match(skillText, /verbatim/i);
  assert.match(skillText, /Never guess or expand version numbers/i);
  assert.match(skillText, /append effort suffixes/i);
  assert.doesNotMatch(
    skillText,
    /gpt-6\.2-|gpt-6\.1-|gpt-6-|gpt-5\.3-codex-spark|gemini-3\.8-|gemini-4-|claude-opus-5-5|claude-sonnet-5-5|Opus 5\.5|Sonnet 5\.5|deepseek-flash|deepseek-v4-pro|deepseek-chat|deepseek-reasoner/
  );
}

function assertRenderedCodexSkills(codexPkgRoot) {
  for (const id of ['agy', 'codex', 'claude', 'dsh']) {
    const skillPath = path.join(codexPkgRoot, 'skills', id, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath));
    const text = fs.readFileSync(skillPath, 'utf8');
    assertVerbatimSkillContract(text, id);
    const drawPath = path.join(codexPkgRoot, 'skills', id, 'references', 'draw.md');
    assert.equal(fs.existsSync(drawPath), id === 'codex');
  }
  assert.match(
    fs.readFileSync(path.join(codexPkgRoot, 'skills', 'agy', 'SKILL.md'), 'utf8'),
    /<skill-dir>\/\.\.\/\.\.\/bin\/cospan\.mjs/
  );
  assert.match(
    fs.readFileSync(path.join(codexPkgRoot, 'skills', 'agy', 'SKILL.md'), 'utf8'),
    /Batch vs\. separate `cospan_wait`/
  );
  const mcpDraw = fs.readFileSync(
    path.join(codexPkgRoot, 'skills', 'codex', 'references', 'draw.md'),
    'utf8'
  );
  assert.match(mcpDraw, /\$imagegen/);
  assert.match(mcpDraw, /cospan_send/);
  assert.match(mcpDraw, /cospan_continue/);
  assert.match(mcpDraw, /Explicit opt-in only/);
}

function assertAgyDrawReference(agyPluginDir) {
  for (const id of ['agy', 'codex', 'claude', 'dsh']) {
    const drawPath = path.join(agyPluginDir, 'skills', `cospan-${id}`, 'references', 'draw.md');
    assert.equal(fs.existsSync(drawPath), id === 'codex');
  }
  const agyCodexSkill = fs.readFileSync(
    path.join(agyPluginDir, 'skills', 'cospan-codex', 'SKILL.md'),
    'utf8'
  );
  assert.match(agyCodexSkill, /references\/draw\.md/);
  assert.match(agyCodexSkill, /only when explicitly requested via Codex/i);
  assert.match(agyCodexSkill, /Batch vs\. separate `wait`/);
  const agyDraw = fs.readFileSync(
    path.join(agyPluginDir, 'skills', 'cospan-codex', 'references', 'draw.md'),
    'utf8'
  );
  assert.match(agyDraw, /\$imagegen/);
  assert.match(agyDraw, /--effort low/);
  assert.match(agyDraw, /continue --id/);
  assert.match(agyDraw, /Explicit opt-in only/);
}

test('host installer mounts all detected targets and adheres to host schemas', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-install-'));
  try {
    const mkTarget = (id, binary, version) => ({
      id,
      installed: true,
      binary,
      version,
      phase: 1,
      driverReady: true,
    });
    const discovered = {
      agy: mkTarget('agy', FAKE_AGY, '1.5.5-fake'),
      codex: mkTarget('codex', FAKE_CODEX, '0.167.2-fake'),
      claude: mkTarget('claude', FAKE_CLAUDE, '2.1.322-fake'),
      dsh: mkTarget('dsh', FAKE_DSH, '0.2.2-rc.1-fake'),
    };

    const agyPluginsRoot = path.join(tmp, 'agy-plugins');
    const agyRes = installForAgyHost({ discovered, pluginsRoot: agyPluginsRoot });
    assert.deepEqual(agyRes.skills, [
      'cospan-agy',
      'cospan-codex',
      'cospan-claude',
      'cospan-dsh',
      'cospan-jobs',
    ]);
    assert.ok(fs.existsSync(path.join(agyRes.pluginDir, 'skills', 'cospan-agy', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(agyRes.pluginDir, 'skills', 'cospan-codex', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(agyRes.pluginDir, 'skills', 'cospan-claude', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(agyRes.pluginDir, 'skills', 'cospan-dsh', 'SKILL.md')));
    for (const id of ['agy', 'codex', 'claude', 'dsh']) {
      const agySkill = fs.readFileSync(
        path.join(agyRes.pluginDir, 'skills', `cospan-${id}`, 'SKILL.md'),
        'utf8'
      );
      assertVerbatimSkillContract(agySkill, id);
    }
    assertAgyDrawReference(agyRes.pluginDir);

    const agyManifest = JSON.parse(
      fs.readFileSync(path.join(agyRes.pluginDir, 'plugin.json'), 'utf8')
    );
    const allowedAgyKeys = new Set([
      'name',
      'description',
      'logo',
      'suggestedPrompts',
      'displayName',
      'version',
      'author',
      'homepage',
      'repository',
      'disabled',
    ]);
    for (const key of Object.keys(agyManifest)) {
      assert.ok(allowedAgyKeys.has(key), `unexpected top-level key in agy plugin.json: ${key}`);
    }

    const codexPkgRoot = path.join(tmp, 'codex-pkg');
    fs.mkdirSync(path.join(codexPkgRoot, 'src', 'mcp'), { recursive: true });
    fs.copyFileSync(MCP_SERVER, path.join(codexPkgRoot, 'src', 'mcp', 'cospan-mcp.mjs'));
    const marketRoot = path.join(tmp, 'codex-market');

    const codexRes = installForCodexHost({
      discovered,
      registerWithCodexCli: false,
      packageRoot: codexPkgRoot,
      marketplaceRoot: marketRoot,
    });
    assert.deepEqual(codexRes.skills, [
      '$cospan:agy',
      '$cospan:codex',
      '$cospan:claude',
      '$cospan:dsh',
      'cospan:jobs',
    ]);
    assertRenderedCodexSkills(codexPkgRoot);

    const mcpJson = JSON.parse(fs.readFileSync(path.join(codexPkgRoot, '.mcp.json'), 'utf8'));
    assert.equal(mcpJson.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    assert.equal(mcpJson.mcpServers.cospan.command, 'node');
    assert.deepEqual(mcpJson.mcpServers.cospan.args, ['${PLUGIN_ROOT}/src/mcp/cospan-mcp.mjs']);

    const marketMcpJson = JSON.parse(
      fs.readFileSync(path.join(marketRoot, 'plugins', 'cospan', '.mcp.json'), 'utf8')
    );
    assert.ok(
      marketMcpJson.mcpServers.cospan.command === 'node' ||
        marketMcpJson.mcpServers.cospan.command.startsWith('./')
    );
    assert.ok(fs.existsSync(path.join(marketRoot, 'plugins', 'cospan', 'mcp', 'cospan-mcp.mjs')));
    assert.ok(fs.existsSync(path.join(marketRoot, 'plugins', 'cospan', 'mcp', 'tools.mjs')));
    assert.equal(durationToMs('5m'), 300000);
    assert.equal(JOB_EXIT_CODES.done, 0);
    assert.equal(typeof parseCliArgs, 'function');
    assert.equal(typeof repoRoot, 'function');
    assert.equal(typeof workspaceStateDir, 'function');
    assert.equal(typeof main, 'function');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('dsh Cordis bundle registers cospan-* skills and native cospan_* tools', async () => {
  let registeredSkillProvider = null;
  const registeredDshTools = [];
  applyDshPlugin({
    inject(deps, fn) {
      if (deps[0] === 'skills') {
        fn({
          effect: (cb) => cb(),
          skills: { registerProvider: (factory) => (registeredSkillProvider = factory()) },
        });
      } else if (deps[0] === 'tools') {
        fn({
          get: () => null,
          tools: { register: (t) => registeredDshTools.push(t) },
        });
      }
    },
  });
  assert.ok(registeredSkillProvider);
  const dshSkills = await registeredSkillProvider.list();
  assert.ok(dshSkills.some((s) => s.name === 'cospan-agy' && s.invocation.userInvocable === true));
  assert.ok(
    dshSkills.some((s) => s.name === 'cospan-jobs' && s.invocation.userInvocable === false)
  );
  assert.ok(registeredDshTools.some((t) => t.name === 'cospan_send'));
  assert.ok(registeredDshTools.some((t) => t.name === 'cospan_wait'));
});

test('stdio MCP server handles initialize, tools/list, cospan_send, and cospan_wait', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-mcp-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });

  const child = spawn(process.execPath, [MCP_SERVER], {
    env: {
      ...process.env,
      AGY_BIN: FAKE_AGY,
      CODEX_BIN: FAKE_CODEX,
      COSPAN_HOME: `${repo}-cfg`,
      COSPAN_CONFIG_DIR: `${repo}-cfg`,
      COSPAN_CALLER_HOST: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const childClosed = new Promise((resolve) => child.once('close', resolve));
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex-mcp-client', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'cospan');

    const list = await rpc('tools/list', {});
    const sendTool = list.result.tools.find((t) => t.name === 'cospan_send');
    assert.ok(sendTool);
    assert.match(sendTool.inputSchema.properties.model.description, /verbatim/i);
    assert.match(sendTool.inputSchema.properties.model.description, /never guess version numbers/i);
    const waitTool = list.result.tools.find((t) => t.name === 'cospan_wait');
    assert.ok(waitTool);
    assert.equal(waitTool.inputSchema.properties.ids.type, 'array');
    assert.deepEqual(waitTool.inputSchema.required, ['cwd']);

    const sendCall = await rpc('tools/call', {
      name: 'cospan_send',
      arguments: {
        cwd: repo,
        to: 'agy',
        readonly: true,
        prompt: 'Verify MCP delegation path',
      },
    });
    assert.equal(sendCall.result.isError, false, JSON.stringify(sendCall));
    const sendInfo = JSON.parse(sendCall.result.content[0].text);
    assert.match(sendInfo.job_id, /^agy-/);

    const waitCall = await rpc('tools/call', {
      name: 'cospan_wait',
      arguments: {
        cwd: repo,
        id: sendInfo.job_id,
        timeout: '10s',
      },
    });
    assert.equal(waitCall.result.isError, false);
    assert.match(waitCall.result.content[0].text, /exit_code=0 status=done/);
    assert.match(waitCall.result.content[0].text, /Verify MCP delegation path/);

    const sendCall2 = await rpc('tools/call', {
      name: 'cospan_send',
      arguments: { cwd: repo, to: 'codex', readonly: true, prompt: 'Verify MCP batch wait' },
    });
    const sendInfo2 = JSON.parse(sendCall2.result.content[0].text);
    const batchWait = await rpc('tools/call', {
      name: 'cospan_wait',
      arguments: { cwd: repo, ids: [sendInfo.job_id, sendInfo2.job_id], timeout: '10s' },
    });
    assert.equal(batchWait.result.isError, false);
    assert.match(batchWait.result.content[0].text, /exit_code=0 status=done/);
    assert.match(batchWait.result.content[0].text, /Verify MCP delegation path/);
    assert.match(batchWait.result.content[0].text, /Verify MCP batch wait/);

    const emptyBatch = await rpc('tools/call', {
      name: 'cospan_wait',
      arguments: { cwd: repo, ids: [], timeout: '5s' },
    });
    assert.equal(emptyBatch.result.isError, true);

    const prevHome = process.env.COSPAN_HOME;
    process.env.COSPAN_HOME = `${repo}-cfg`;
    try {
      const board = listWorkspaceBoard(repo);
      assert.equal(board.jobs[0].caller_host, 'codex-mcp-client');
    } finally {
      if (prevHome === undefined) delete process.env.COSPAN_HOME;
      else process.env.COSPAN_HOME = prevHome;
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    await Promise.race([childClosed, new Promise((r) => setTimeout(r, 3000))]);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(`${repo}-cfg`, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
