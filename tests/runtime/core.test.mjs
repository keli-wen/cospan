import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COSPAN_BIN as BIN, FAKE_FILES } from '../helpers/paths.mjs';

const { agy: FAKE_AGY, codex: FAKE_CODEX } = FAKE_FILES;

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-test-'));
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

test('ask foreground works for agy and codex (unrestricted default + --restricted)', () => {
  const repo = makeTempGitRepo();
  try {
    const agyRes = runCospan(['ask', '--to', 'agy', '--prompt', 'hello agy'], { cwd: repo });
    assert.equal(agyRes.code, 0, agyRes.stderr);
    assert.match(
      agyRes.stdout,
      /AGY_ASK_OK model=gemini-3\.8-flash-medium mode=plan skip_perms=true sandbox=false/
    );

    const codexRes = runCospan(['ask', '--to', 'codex', '--prompt', 'hello codex'], { cwd: repo });
    assert.equal(codexRes.code, 0, codexRes.stderr);
    assert.match(codexRes.stdout, /codex_model=gpt-6\.2-sol/);
    assert.match(codexRes.stdout, /bypass=true/);

    const restrictedCodex = runCospan(
      ['ask', '--to', 'codex', '--restricted', '--prompt', 'hello restricted'],
      {
        cwd: repo,
      }
    );
    assert.equal(restrictedCodex.code, 0, restrictedCodex.stderr);
    assert.match(restrictedCodex.stdout, /bypass=false sandbox=read-only/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('send -> observe -> wait -> continue lifecycle on codex keeps git status clean', () => {
  const repo = makeTempGitRepo();
  try {
    const sendRes = runCospan(
      [
        'send',
        '--to',
        'codex',
        '--readonly',
        '--json',
        '--prompt',
        'Inspect --flag literal safely',
      ],
      { cwd: repo, env: { FAKE_CODEX_DELAY_MS: '400' } }
    );
    assert.equal(sendRes.code, 0, sendRes.stderr);
    const { job_id: jobId } = JSON.parse(sendRes.stdout);
    assert.match(jobId, /^codex-/);

    // Wait with short timeout returns exit 2 while still running
    const shortWait = runCospan(['wait', jobId, '--timeout', '50ms'], { cwd: repo });
    if (shortWait.code === 2) {
      const snap = JSON.parse(shortWait.stdout);
      assert.equal(snap.status, 'running');
      assert.ok(Buffer.byteLength(shortWait.stdout, 'utf8') <= 8192);
    }

    // Full wait collects output with exit 0
    const doneWait = runCospan(['wait', jobId, '--timeout', '10s'], { cwd: repo });
    assert.equal(doneWait.code, 0, doneWait.stderr);
    assert.match(doneWait.stdout, /codex_model=gpt-6\.2-sol/);
    assert.match(doneWait.stdout, /Access mode: READ-ONLY/);
    assert.match(doneWait.stdout, /Inspect --flag literal safely/);

    // Terminal observe never leaks full result body and stays <= 8 KiB
    const obs = runCospan(['observe', jobId], { cwd: repo });
    assert.equal(obs.code, 0);
    const obsJson = JSON.parse(obs.stdout);
    assert.equal(obsJson.status, 'done');
    assert.equal(obsJson.result_available, true);
    assert.ok(!obs.stdout.includes('Inspect --flag literal safely'));

    // Continue with `--last` reuses `codex-thread-999` via `codex exec resume`
    // (which enforces no -C/-s!)
    const cont = runCospan(
      ['continue', '--last', '--to', 'codex', '--json', '--prompt', 'Follow-up check'],
      {
        cwd: repo,
      }
    );
    assert.equal(cont.code, 0, cont.stderr);
    const { job_id: job2, conversation_id: convId } = JSON.parse(cont.stdout);
    assert.equal(convId, 'codex-thread-999');

    const wait2 = runCospan(['wait', job2, '--timeout', '10s'], { cwd: repo });
    assert.equal(wait2.code, 0, wait2.stderr);
    assert.match(wait2.stdout, /resumed=true thread=codex-thread-999/);
    assert.match(wait2.stdout, /interactive_resume: codex resume codex-thread-999/);

    // Verify workspace directory was never polluted with `.cospan/`
    assert.equal(fs.existsSync(path.join(repo, '.cospan')), false);
    const gitSt = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(gitSt.stdout.trim(), '');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('writable dirty context + workspace delta vs --readonly guard warning vs --raw', () => {
  const repo = makeTempGitRepo();
  try {
    // Pre-existing dirty file
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'user uncommitted\n');

    const sendRw = runCospan(['send', '--to', 'agy', '--json', '--prompt', 'Add generated.txt'], {
      cwd: repo,
      env: { FAKE_AGY_TOUCH_FILE: 'generated.txt' },
    });
    assert.equal(sendRw.code, 0, sendRw.stderr);
    const { job_id: rwId } = JSON.parse(sendRw.stdout);
    const rwOut = runCospan(['wait', rwId, '--timeout', '10s'], { cwd: repo });
    assert.equal(rwOut.code, 0, rwOut.stderr);
    assert.match(rwOut.stdout, /Pre-existing dirty workspace paths/);
    assert.match(rwOut.stdout, /dirty\.txt/);
    assert.match(rwOut.stdout, /\[cospan workspace delta\]/);
    assert.match(rwOut.stdout, /generated\.txt/);

    // Readonly violation emits explicit guard warning
    const sendRo = runCospan(
      ['send', '--to', 'agy', '--readonly', '--json', '--prompt', 'Inspect only'],
      {
        cwd: repo,
        env: { FAKE_AGY_TOUCH_FILE: 'rogue.txt' },
      }
    );
    const { job_id: roId } = JSON.parse(sendRo.stdout);
    const roOut = runCospan(['wait', roId, '--timeout', '10s'], { cwd: repo });
    assert.equal(roOut.code, 0);
    assert.match(roOut.stdout, /\[cospan warning\] Job ran with --readonly/);
    assert.match(roOut.stdout, /rogue\.txt/);

    // --raw skips protocol envelope completely
    const sendRaw = runCospan(
      ['send', '--to', 'agy', '--raw', '--json', '--prompt', 'EXACT_RAW_PAYLOAD'],
      {
        cwd: repo,
      }
    );
    const { job_id: rawId } = JSON.parse(sendRaw.stdout);
    const rawOut = runCospan(['wait', rawId, '--timeout', '10s'], { cwd: repo });
    assert.equal(rawOut.code, 0);
    assert.ok(!rawOut.stdout.includes('[cospan delegation context]'));
    assert.match(rawOut.stdout, /prompt_echo=EXACT_RAW_PAYLOAD/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('cancel and resumable timeout (attention exit code 5)', () => {
  const repo = makeTempGitRepo();
  try {
    // 1. Cancel a hanging job -> exit code 4
    const hang = runCospan(['send', '--to', 'codex', '--json', '--prompt', 'Long task'], {
      cwd: repo,
      env: { FAKE_CODEX_HANG: '1' },
    });
    const { job_id: hangId } = JSON.parse(hang.stdout);
    const cancelRes = runCospan(['cancel', hangId], { cwd: repo });
    assert.equal(cancelRes.code, 0, cancelRes.stderr);
    const canceledWait = runCospan(['wait', hangId, '--timeout', '2s'], { cwd: repo });
    assert.equal(canceledWait.code, 4);

    // 2. Timeout after session started -> status=attention, exit code 5
    const slow = runCospan(
      ['send', '--to', 'agy', '--timeout', '300ms', '--json', '--prompt', 'Slow task'],
      {
        cwd: repo,
        env: { FAKE_AGY_HANG: '1' },
      }
    );
    const { job_id: slowId } = JSON.parse(slow.stdout);
    const attnWait = runCospan(['wait', slowId, '--timeout', '15s'], { cwd: repo });
    assert.equal(attnWait.code, 5, attnWait.stdout);
    assert.match(attnWait.stdout, /Job needs attention/);
    assert.match(attnWait.stdout, /continue --id/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('layered config (global -> trajectory -> workspace) and events.jsonl retention', () => {
  const repo = makeTempGitRepo();
  try {
    // 1. Default config with zero files on disk: agy uses gemini-3.8-flash-medium + unrestricted
    const cfg0 = runCospan(['config', '--json'], { cwd: repo });
    assert.equal(cfg0.code, 0, cfg0.stderr);
    const parsed0 = JSON.parse(cfg0.stdout);
    assert.deepEqual(parsed0.loaded_files, []);
    assert.equal(parsed0.effective_config.permissions, 'unrestricted');
    assert.equal(parsed0.effective_config.defaults.agy.model, 'gemini-3.8-flash-medium');
    assert.ok(parsed0.trajectory_dir.includes(path.join('trajectories', path.basename(repo))));

    // 2. Initialize trajectory-level config and override agy default model
    const initTraj = runCospan(['config', '--init', '--trajectory', '--json'], { cwd: repo });
    assert.equal(initTraj.code, 0, initTraj.stderr);
    const trajCfgFile = JSON.parse(initTraj.stdout).initialized;
    fs.writeFileSync(
      trajCfgFile,
      JSON.stringify({
        defaults: { agy: { model: 'gemini-4-carbon-medium' } },
        mappings: { agy: { myflash: 'gemini-3.8-flash-high' } },
      })
    );

    const sendTraj = runCospan(
      ['send', '--to', 'agy', '--json', '--prompt', 'Check trajectory config'],
      { cwd: repo }
    );
    assert.equal(sendTraj.code, 0, sendTraj.stderr);
    const sendTrajInfo = JSON.parse(sendTraj.stdout);
    assert.equal(sendTrajInfo.model, 'gemini-4-carbon-medium');
    assert.equal(sendTrajInfo.permissions, 'unrestricted');
    const waitTraj = runCospan(['wait', sendTrajInfo.job_id, '--timeout', '10s'], { cwd: repo });
    assert.equal(waitTraj.code, 0, waitTraj.stderr);
    assert.match(
      waitTraj.stdout,
      /agy_model=gemini-4-carbon-medium.*skip_perms=true sandbox=false/
    );

    // Verify raw trajectory JSONL (`<job_id>.events.jsonl`) is retained in `trajectory_dir/jobs/`!
    const retainedEvents = path.join(
      parsed0.trajectory_dir,
      'jobs',
      `${sendTrajInfo.job_id}.events.jsonl`
    );
    assert.equal(fs.existsSync(retainedEvents), true);

    // 3. Workspace `.cospan/config.json` overrides trajectory config (and can opt into restricted)
    fs.mkdirSync(path.join(repo, '.cospan'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.cospan', 'config.json'),
      JSON.stringify({
        permissions: 'restricted',
        defaults: { agy: { model: 'myflash' } },
      })
    );

    const sendWs = runCospan(
      ['send', '--to', 'agy', '--json', '--prompt', 'Check workspace config'],
      { cwd: repo }
    );
    assert.equal(sendWs.code, 0, sendWs.stderr);
    const sendWsInfo = JSON.parse(sendWs.stdout);
    assert.equal(sendWsInfo.model, 'gemini-3.8-flash-high');
    assert.equal(sendWsInfo.permissions, 'restricted');
    const waitWs = runCospan(['wait', sendWsInfo.job_id, '--timeout', '10s'], { cwd: repo });
    assert.equal(waitWs.code, 0, waitWs.stderr);
    assert.match(waitWs.stdout, /agy_model=gemini-3\.8-flash-high.*skip_perms=false sandbox=true/);

    // 4. Explicit `--unrestricted` CLI flag overrides workspace `"permissions": "restricted"`
    const sendOverride = runCospan(
      ['send', '--to', 'agy', '--unrestricted', '--json', '--prompt', 'CLI override'],
      {
        cwd: repo,
      }
    );
    assert.equal(JSON.parse(sendOverride.stdout).permissions, 'unrestricted');
    runCospan(['wait', JSON.parse(sendOverride.stdout).job_id, '--timeout', '10s'], { cwd: repo });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});

test('sparse config --init writes {} and config --json exposes override provenance', () => {
  const repo = makeTempGitRepo();
  try {
    // 1. Initialize global config with --init --global -> writes sparse {}
    const initGlobal = runCospan(['config', '--init', '--global', '--json'], { cwd: repo });
    assert.equal(initGlobal.code, 0, initGlobal.stderr);
    const globalPath = JSON.parse(initGlobal.stdout).initialized;
    assert.equal(fs.readFileSync(globalPath, 'utf8'), '{}\n');

    // 2. Sparse global config leaves overrides empty and preserves builtin effective_config
    const cfgSparse = runCospan(['config', '--json'], { cwd: repo });
    assert.equal(cfgSparse.code, 0, cfgSparse.stderr);
    const parsedSparse = JSON.parse(cfgSparse.stdout);
    assert.deepEqual(parsedSparse.loaded_files, [globalPath]);
    assert.deepEqual(parsedSparse.overrides, {});
    assert.deepEqual(parsedSparse.sources, [{ scope: 'global', path: globalPath, keys: [] }]);
    assert.equal(parsedSparse.effective_config.defaults.agy.model, 'gemini-3.8-flash-medium');

    // 3. Trajectory + workspace overrides report exact winning provenance
    const initTraj = runCospan(['config', '--init', '--trajectory', '--json'], { cwd: repo });
    const trajPath = JSON.parse(initTraj.stdout).initialized;
    assert.equal(fs.readFileSync(trajPath, 'utf8'), '{}\n');
    fs.writeFileSync(
      trajPath,
      JSON.stringify({ defaults: { agy: { model: 'carbon' }, codex: { model: 'terra' } } })
    );

    const initWs = runCospan(['config', '--init', '--workspace', '--json'], { cwd: repo });
    const wsPath = JSON.parse(initWs.stdout).initialized;
    assert.equal(fs.readFileSync(wsPath, 'utf8'), '{}\n');
    fs.writeFileSync(wsPath, JSON.stringify({ defaults: { agy: { model: 'hydrogen' } } }));

    const cfgLayered = runCospan(['config', '--json'], { cwd: repo });
    assert.equal(cfgLayered.code, 0, cfgLayered.stderr);
    const parsedLayered = JSON.parse(cfgLayered.stdout);
    assert.deepEqual(parsedLayered.overrides['defaults.agy.model'], {
      value: 'hydrogen',
      source: wsPath,
      scope: 'workspace',
    });
    assert.deepEqual(parsedLayered.overrides['defaults.codex.model'], {
      value: 'terra',
      source: trajPath,
      scope: 'trajectory',
    });

    // 4. --init --workspace --force resets to sparse {}
    const resetWs = runCospan(['config', '--init', '--workspace', '--force', '--json'], {
      cwd: repo,
    });
    assert.equal(resetWs.code, 0, resetWs.stderr);
    assert.equal(fs.readFileSync(wsPath, 'utf8'), '{}\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-cospan-cfg`, { recursive: true, force: true });
  }
});
