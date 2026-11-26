import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COSPAN_BIN as BIN, FAKE_FILES } from '../helpers/paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX, claude: FAKE_CLAUDE, dsh: FAKE_DSH } = FAKE_FILES;

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-p2-'));
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
      AGY_BIN: FAKE_AGY,
      CODEX_BIN: FAKE_CODEX,
      CLAUDE_BIN: FAKE_CLAUDE,
      DSH_BIN: FAKE_DSH,
      COSPAN_CONFIG_DIR: cfgDir,
      ...env,
    },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

test('claude foreground ask + detached send -> wait -> continue lifecycle', () => {
  const repo = makeTempGitRepo();
  try {
    const askUnres = runCospan(['ask', '--to', 'claude', '--prompt', 'hello claude'], {
      cwd: repo,
    });
    assert.equal(askUnres.code, 0, askUnres.stderr);
    assert.match(
      askUnres.stdout,
      /claude_model=sonnet effort=low.*skip_perms=true.*disallowed=Edit,Write,NotebookEdit/
    );

    const askRes = runCospan(
      ['ask', '--to', 'claude', '--restricted', '--prompt', 'hello restricted claude'],
      { cwd: repo }
    );
    assert.equal(askRes.code, 0, askRes.stderr);
    assert.match(askRes.stdout, /perm_mode=plan skip_perms=false restricted=true/);

    const send1 = runCospan(
      [
        'send',
        '--to',
        'claude',
        '--readonly',
        '--model',
        'opus',
        '--effort',
        'max',
        '--json',
        '--prompt',
        'Audit repo',
      ],
      { cwd: repo }
    );
    assert.equal(send1.code, 0, send1.stderr);
    const { job_id: job1 } = JSON.parse(send1.stdout);
    assert.match(job1, /^claude-/);

    const wait1 = runCospan(['wait', job1, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait1.code, 0, wait1.stderr);
    assert.match(wait1.stdout, /claude_model=opus effort=max.*session=claude-sess-777/);

    const cont = runCospan(
      ['continue', '--last', '--to', 'claude', '--json', '--prompt', 'Check second file'],
      { cwd: repo }
    );
    assert.equal(cont.code, 0, cont.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(cont.stdout);
    assert.equal(convId, 'claude-sess-777');

    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true session=claude-sess-777/);
    assert.match(wait2.stdout, /interactive_resume: claude --resume claude-sess-777/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('dsh foreground ask + detached send -> wait -> continue lifecycle stays clean', () => {
  const repo = makeTempGitRepo();
  try {
    // Default inherit does not patch user's dsh profile
    const askInherit = runCospan(['ask', '--to', 'dsh', '--prompt', 'hello dsh'], { cwd: repo });
    assert.equal(askInherit.code, 0, askInherit.stderr);
    assert.match(
      askInherit.stdout,
      /dsh_model=deepseek-flash.*patched=false perm=danger-full-access approval=never/
    );

    // Explicit model + effort + restricted applies --patch and workspace-write
    const send1 = runCospan(
      [
        'send',
        '--to',
        'dsh',
        '--restricted',
        '--model',
        'pro',
        '--effort',
        'high',
        '--json',
        '--prompt',
        'Verify build',
      ],
      { cwd: repo }
    );
    assert.equal(send1.code, 0, send1.stderr);
    const { job_id: job1 } = JSON.parse(send1.stdout);
    assert.match(job1, /^dsh-/);

    const wait1 = runCospan(['wait', job1, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait1.code, 0, wait1.stderr);
    assert.match(
      wait1.stdout,
      /dsh_model=deepseek-v4-pro effort=high patched=true perm=workspace-write/
    );

    const cont = runCospan(
      ['continue', '--last', '--to', 'dsh', '--json', '--prompt', 'Follow-up dsh'],
      { cwd: repo }
    );
    assert.equal(cont.code, 0, cont.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(cont.stdout);
    assert.equal(convId, 'dsh-session-888');

    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true session=dsh-session-888/);
    assert.match(wait2.stdout, /interactive_resume: dsh tui --resume dsh-session-888/);

    const gitSt = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(gitSt.stdout.trim(), '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('unauthenticated claude/dsh errors surface and doctor --check verifies all targets', () => {
  const repo = makeTempGitRepo();
  try {
    const unauthAsk = runCospan(['ask', '--to', 'claude', '--prompt', 'test'], {
      cwd: repo,
      env: { FAKE_CLAUDE_UNAUTH: '1' },
    });
    assert.notEqual(unauthAsk.code, 0);
    assert.match(unauthAsk.stderr, /Not logged in/);

    const unauthSend = runCospan(['send', '--to', 'dsh', '--json', '--prompt', 'test'], {
      cwd: repo,
      env: { FAKE_DSH_UNAUTH: '1' },
    });
    const { job_id: jobId } = JSON.parse(unauthSend.stdout);
    const unauthWait = runCospan(['wait', jobId, '--timeout', '10s'], { cwd: repo });
    assert.equal(unauthWait.code, 3);
    assert.match(unauthWait.stdout, /No API key or logged-in DeepSeek account configured/);

    const docOk = runCospan(['doctor', '--check', '--json'], { cwd: repo });
    assert.equal(docOk.code, 0, docOk.stderr);
    const parsedDoc = JSON.parse(docOk.stdout);
    assert.equal(parsedDoc.contracts_ok, true);
    for (const id of ['agy', 'codex', 'claude', 'dsh']) {
      assert.equal(parsedDoc.targets[id].driverReady, true);
      assert.equal(parsedDoc.contracts[id].ok, true);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('continue preserves inherit mode and prior resolved models across config changes', () => {
  const repo = makeTempGitRepo();
  try {
    const dshSend = runCospan(['send', '--to', 'dsh', '--json', '--prompt', 'Turn 1 inherit'], {
      cwd: repo,
    });
    const { job_id: dshJob1 } = JSON.parse(dshSend.stdout);
    assert.equal(runCospan(['wait', dshJob1, '--timeout', '10s'], { cwd: repo }).code, 0);

    const claudeInherit = runCospan(
      [
        'send',
        '--to',
        'claude',
        '--model',
        'inherit',
        '--effort',
        'inherit',
        '--json',
        '--prompt',
        'Claude inherit turn 1',
      ],
      { cwd: repo }
    );
    const { job_id: claudeJob1 } = JSON.parse(claudeInherit.stdout);
    assert.equal(runCospan(['wait', claudeJob1, '--timeout', '10s'], { cwd: repo }).code, 0);

    const claudeConcrete = runCospan(
      [
        'send',
        '--to',
        'claude',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--json',
        '--prompt',
        'Claude concrete turn 1',
      ],
      { cwd: repo }
    );
    const { job_id: claudeConcreteJob1 } = JSON.parse(claudeConcrete.stdout);
    assert.equal(
      runCospan(['wait', claudeConcreteJob1, '--timeout', '10s'], { cwd: repo }).code,
      0
    );

    fs.mkdirSync(path.join(repo, '.cospan'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.cospan', 'config.json'),
      JSON.stringify({
        defaults: {
          dsh: { model: 'pro', effort: 'high' },
          claude: { model: 'opus', effort: 'max' },
        },
        mappings: { claude: { sonnet: 'claude-sonnet-4-6', fastopus: 'opus' } },
      })
    );

    const dshCont = runCospan(
      ['continue', '--id', dshJob1, '--json', '--prompt', 'Turn 2 inherit'],
      { cwd: repo }
    );
    const dshContInfo = JSON.parse(dshCont.stdout);
    assert.equal(dshContInfo.model, null);
    assert.equal(dshContInfo.effort, null);
    const dshContWait = runCospan(['wait', dshContInfo.job_id, '--timeout', '10s'], { cwd: repo });
    assert.match(dshContWait.stdout, /patched=false/);

    const claudeContInherit = runCospan(
      ['continue', '--id', claudeJob1, '--json', '--prompt', 'Claude inherit turn 2'],
      { cwd: repo }
    );
    const claudeContInheritInfo = JSON.parse(claudeContInherit.stdout);
    assert.equal(claudeContInheritInfo.model, null);
    assert.equal(claudeContInheritInfo.effort, null);
    assert.equal(
      runCospan(['wait', claudeContInheritInfo.job_id, '--timeout', '10s'], { cwd: repo }).code,
      0
    );

    const claudeContConcrete = runCospan(
      ['continue', '--id', claudeConcreteJob1, '--json', '--prompt', 'Claude concrete turn 2'],
      { cwd: repo }
    );
    const claudeContConcreteInfo = JSON.parse(claudeContConcrete.stdout);
    assert.equal(claudeContConcreteInfo.model, 'sonnet');
    assert.equal(claudeContConcreteInfo.effort, 'high');
    assert.equal(
      runCospan(['wait', claudeContConcreteInfo.job_id, '--timeout', '10s'], { cwd: repo }).code,
      0
    );

    const claudeContExplicit = runCospan(
      [
        'continue',
        '--id',
        claudeJob1,
        '--model',
        'fastopus',
        '--json',
        '--prompt',
        'Claude explicit override',
      ],
      { cwd: repo }
    );
    const claudeContExplicitInfo = JSON.parse(claudeContExplicit.stdout);
    assert.equal(claudeContExplicitInfo.model, 'opus');
    assert.equal(claudeContExplicitInfo.effort, null);
    assert.equal(
      runCospan(['wait', claudeContExplicitInfo.job_id, '--timeout', '10s'], { cwd: repo }).code,
      0
    );

    // restart also preserves prior inherit mode when --model/--effort omitted
    const restartRes = runCospan(['restart', dshJob1], { cwd: repo });
    assert.equal(restartRes.code, 0, restartRes.stderr);
    const restartedId = /new job (dsh-[^\s]+)/.exec(restartRes.stdout)?.[1];
    assert.ok(restartedId);
    const restartWait = runCospan(['wait', restartedId, '--timeout', '10s'], { cwd: repo });
    assert.match(restartWait.stdout, /patched=false/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('dsh inherit + --effort uses DSH_HOME configured model in runtime execution', () => {
  const repo = makeTempGitRepo();
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-dsh-rt-'));
  try {
    fs.mkdirSync(path.join(dshHome, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(
      path.join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: custom-prov\n    model: custom-v4\n'
    );
    const sendRes = runCospan(
      ['send', '--to', 'dsh', '--effort', 'high', '--json', '--prompt', 'Use DSH_HOME model'],
      { cwd: repo, env: { DSH_HOME: dshHome } }
    );
    assert.equal(sendRes.code, 0, sendRes.stderr);
    const { job_id: jobId, model, effort } = JSON.parse(sendRes.stdout);
    assert.equal(model, null);
    assert.equal(effort, 'high');
    const waitRes = runCospan(['wait', jobId, '--timeout', '10s'], {
      cwd: repo,
      env: { DSH_HOME: dshHome },
    });
    assert.equal(waitRes.code, 0, waitRes.stderr);
    assert.match(
      waitRes.stdout,
      /dsh_provider=custom-prov dsh_model=custom-v4 effort=high patched=true/
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
});
