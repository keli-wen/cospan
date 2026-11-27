import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply as applyDshPlugin } from '../../dsh/index.mjs';
import { installForAgyHost } from '../../src/installer.mjs';
import { updateState } from '../../src/job-store.mjs';
import {
  cancelBoardJob,
  listWorkspaceBoard,
  readBoardJobDetail,
} from '../../src/sidebar-state.mjs';
import { startSidecarServer } from '../../src/sidecar/server.mjs';
import { buildDshClientBundle, syncDshClient } from '../../src/ui/sync-dsh-client.mjs';
import { FAKE_FILES, ROOT_DIR } from '../helpers/paths.mjs';
import { loadDshClientModule, runCospanInHome, withTempWorkspace } from '../helpers/sidebar.mjs';

const { codex: FAKE_CODEX } = FAKE_FILES;

test('sidebar-state queries board, caller attribution, legacy jobs, and safe cancel', async () => {
  await withTempWorkspace(async ({ repo, home }) => {
    // 1. Insert a legacy job without caller_host / caller_session_id
    const legacyResult = path.join(home, 'legacy.result.md');
    fs.writeFileSync(legacyResult, 'Legacy output\n');
    updateState((state) => {
      state.jobs.push({
        id: 'codex-legacy-001',
        target: 'codex',
        status: 'done',
        readonly: true,
        model: 'gpt-6.2-sol',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:00:05.000Z',
        result_file: legacyResult,
        log_file: path.join(home, 'legacy.log'),
      });
    }, repo);

    // 2. Launch a finished job with Antigravity caller session attribution
    const sendDone = runCospanInHome(
      ['send', '--to', 'agy', '--readonly', '--json', '--prompt', 'Audit sidebar module'],
      {
        cwd: repo,
        home,
        env: { COSPAN_CALLER_HOST: 'agy', ANTIGRAVITY_CONVERSATION_ID: 'conv-alpha' },
      }
    );
    assert.equal(sendDone.code, 0, sendDone.stderr);
    const doneId = JSON.parse(sendDone.stdout).job_id;
    const waitDone = runCospanInHome(['wait', doneId, '--timeout', '10s'], { cwd: repo, home });
    assert.equal(waitDone.code, 0, waitDone.stderr);

    // 3. Launch a running hanging job for another session to verify sort order & safe cancel
    const sendHang = runCospanInHome(
      ['send', '--to', 'codex', '--json', '--prompt', 'Long running task'],
      {
        cwd: repo,
        home,
        env: {
          FAKE_CODEX_HANG: '1',
          COSPAN_CALLER_HOST: 'dsh',
          COSPAN_CALLER_SESSION_ID: 'dsh-sess-2',
        },
      }
    );
    assert.equal(sendHang.code, 0, sendHang.stderr);
    const hangId = JSON.parse(sendHang.stdout).job_id;

    // Query via file:// URI
    const board = listWorkspaceBoard(pathToFileURL(repo).href, { callerSessionId: 'conv-alpha' });
    assert.equal(fs.realpathSync.native(board.workspace), fs.realpathSync.native(repo));
    assert.equal(board.caller_session_id, 'conv-alpha');
    assert.equal(board.jobs.length, 3);
    // Running job sorts first, then newest finished (doneId), then older legacy job
    assert.equal(board.jobs[0].id, hangId);
    assert.equal(board.jobs[0].status, 'running');
    assert.equal(board.jobs[0].caller_host, 'dsh');
    assert.equal(board.jobs[0].caller_match, false);

    const matchedJob = board.jobs.find((j) => j.id === doneId);
    assert.equal(matchedJob.caller_host, 'agy');
    assert.equal(matchedJob.caller_session_id, 'conv-alpha');
    assert.equal(matchedJob.caller_match, true);
    assert.match(matchedJob.prompt_preview, /Audit sidebar module/);
    assert.equal(matchedJob.has_result, true);

    const legacyJob = board.jobs.find((j) => j.id === 'codex-legacy-001');
    assert.equal(legacyJob.caller_host, null);
    assert.equal(legacyJob.caller_session_id, null);
    assert.equal(legacyJob.caller_match, false);

    // Detail view + missing job safety
    const detail = readBoardJobDetail(repo, doneId);
    assert.equal(detail.ok, true);
    assert.match(detail.result_text, /Audit sidebar module/);
    assert.equal(detail.diagnostics.job_id, doneId);
    assert.equal(readBoardJobDetail(repo, 'missing-job').ok, false);

    // Safe cancel never exits process on missing or running jobs
    const missingCancel = await cancelBoardJob(repo, 'does-not-exist');
    assert.equal(missingCancel.ok, false);

    const cancelRes = await cancelBoardJob(repo, hangId);
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.status, 'canceled');
    const idempotentCancel = await cancelBoardJob(repo, hangId);
    assert.equal(idempotentCancel.ok, true);
    assert.equal(idempotentCancel.status, 'canceled');
  });
});

test('dsh client bundle has zero drift, exposes ./client, and runs /cospan-ctl', async () => {
  await withTempWorkspace(async ({ repo, home }) => {
    // 1. Verify zero drift between src/ui/* + dsh/client-bridge.js and dsh/client.js
    const syncCheck = syncDshClient({ write: false });
    const diskClient = fs.readFileSync(path.join(ROOT_DIR, 'dsh', 'client.js'), 'utf8');
    assert.equal(diskClient, buildDshClientBundle());
    assert.equal(syncCheck.changed, false);
    assert.doesNotMatch(diskClient, /^\s*(?:import|export)\s/m);

    // 2. Verify dsh/package.json manifest
    const dshPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'dsh', 'package.json'), 'utf8'));
    assert.equal(dshPkg.exports['./client'], './client.js');
    assert.equal(dshPkg.dsh.client.platform, 'web');
    assert.deepEqual(dshPkg.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-api-remotes',
    ]);

    // 3. Verify client.js UMD registration via simulated __ModuleLoader__
    const loadedModule = loadDshClientModule(diskClient);
    const tabRegs = [];
    const slotRegs = [];
    loadedModule.apply({
      effect: (fn) => fn(),
      sidebarRightTabs: { register: (cfg) => tabRegs.push(cfg) },
      slots: {
        inject: (_slot, cb) => cb(),
        register: (meta) => slotRegs.push(meta.name),
      },
      sidebarRight: {},
      remote: { commands: {} },
    });
    assert.equal(tabRegs[0].id, 'cospan-dsh');
    assert.equal(tabRegs[0].kind, 'cospan');
    assert.deepEqual(slotRegs, [
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
      'conversation.session.header.actions',
    ]);

    // 4. Verify dsh/index.mjs registers /cospan-ctl and handles list / detail / cancel
    const registeredCommands = [];
    const registeredTools = [];
    applyDshPlugin({
      inject(deps, fn) {
        if (deps[0] === 'tools') {
          fn({ get: () => null, tools: { register: (t) => registeredTools.push(t) } });
        } else if (deps[0] === 'commands') {
          fn({ get: () => null, commands: { register: (c) => registeredCommands.push(c) } });
        }
      },
    });
    const ctl = registeredCommands.find((c) => c.name === 'cospan-ctl');
    const sendTool = registeredTools.find((t) => t.name === 'cospan_send');
    assert.ok(ctl && sendTool, 'expected /cospan-ctl and cospan_send registrations');

    const fakeAgent = { session: { id: 'dsh-s42', header: { id: 'dsh-s42', cwd: repo } } };
    const savedEnv = {
      CODEX_BIN: process.env.CODEX_BIN,
      COSPAN_CONFIG_DIR: process.env.COSPAN_CONFIG_DIR,
      FAKE_CODEX_HANG: process.env.FAKE_CODEX_HANG,
    };
    process.env.CODEX_BIN = FAKE_CODEX;
    process.env.COSPAN_CONFIG_DIR = home;
    process.env.FAKE_CODEX_HANG = '1';
    let dshSend;
    try {
      dshSend = await sendTool.execute({ to: 'codex', prompt: 'DSH task' }, { agent: fakeAgent });
    } finally {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
    assert.equal(dshSend.ok, true, dshSend.output);
    const hangId = JSON.parse(dshSend.output).job_id;

    const listRes = await ctl.handler({ agent: fakeAgent, rawInput: '{"action":"list"}' });
    assert.equal(listRes.kind, 'success');
    const listBody = JSON.parse(listRes.text);
    assert.equal(listBody.jobs[0].id, hangId);
    assert.equal(listBody.jobs[0].caller_host, 'dsh');
    assert.equal(listBody.jobs[0].caller_session_id, 'dsh-s42');
    assert.equal(listBody.jobs[0].caller_match, true);

    const detailRes = await ctl.handler({
      agent: fakeAgent,
      rawInput: JSON.stringify({ action: 'detail', id: hangId }),
    });
    assert.equal(detailRes.kind, 'success');
    assert.equal(JSON.parse(detailRes.text).job_id, hangId);

    const cancelRes = await ctl.handler({
      agent: fakeAgent,
      rawInput: JSON.stringify({ action: 'cancel', id: hangId }),
    });
    assert.equal(cancelRes.kind, 'success');
    assert.equal(JSON.parse(cancelRes.text).status, 'canceled');
  });
});

test('Antigravity sidecar enforces token auth and emits sidecar.json', async () => {
  await withTempWorkspace(async ({ repo, home }) => {
    const sidecar = await startSidecarServer({
      port: 0,
      token: 'test-tok',
      workspaceFallback: repo,
      quiet: true,
    });

    try {
      // 1. Static assets & HTML shell
      const htmlRes = await fetch(`${sidecar.url}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /\/board\.css/);
      assert.match(html, /\/board\.js/);
      assert.match(html, /\/sidecar-bridge\.js/);

      const jsRes = await fetch(`${sidecar.url}/board.js`);
      assert.equal(jsRes.status, 200);
      assert.match(await jsRes.text(), /CospanBoard/);

      // 2. Launch a hanging job and query /api/board + /api/job + /api/cancel
      const hang = runCospanInHome(['send', '--to', 'codex', '--json', '--prompt', 'Sidecar job'], {
        cwd: repo,
        home,
        env: { FAKE_CODEX_HANG: '1', ANTIGRAVITY_CONVERSATION_ID: 'agy-conv-9' },
      });
      const hangId = JSON.parse(hang.stdout).job_id;

      const wsParam = encodeURIComponent(pathToFileURL(repo).href);
      const boardRes = await fetch(
        `${sidecar.url}/api/board?workspace=${wsParam}&conversationId=agy-conv-9`
      );
      assert.equal(boardRes.status, 200);
      const boardJson = await boardRes.json();
      assert.equal(boardJson.jobs[0].id, hangId);
      assert.equal(boardJson.jobs[0].caller_match, true);

      const jobRes = await fetch(`${sidecar.url}/api/job?id=${encodeURIComponent(hangId)}`);
      assert.equal(jobRes.status, 200);
      assert.equal((await jobRes.json()).job_id, hangId);

      // Unauthorized POST without token -> 401
      const unauthCancel = await fetch(`${sidecar.url}/api/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: repo, id: hangId }),
      });
      assert.equal(unauthCancel.status, 401);

      // Authorized POST with X-Sidecar-Token -> 200
      const authCancel = await fetch(`${sidecar.url}/api/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': 'test-tok',
        },
        body: JSON.stringify({ workspace: repo, id: hangId }),
      });
      assert.equal(authCancel.status, 200);
      const cancelBody = await authCancel.json();
      assert.equal(cancelBody.ok, true);
      assert.equal(cancelBody.status, 'canceled');

      // 3. Verify installForAgyHost sidecar.json & plugin.json schema compliance
      const agyPluginsRoot = path.join(home, 'agy-plugins');
      const agyInstall = installForAgyHost({
        discovered: { agy: { installed: true } },
        pluginsRoot: agyPluginsRoot,
      });
      const sidecarJsonPath = path.join(
        agyInstall.pluginDir,
        'sidecars',
        'cospan_board',
        'sidecar.json'
      );
      assert.equal(fs.existsSync(sidecarJsonPath), true);
      const sidecarManifest = JSON.parse(fs.readFileSync(sidecarJsonPath, 'utf8'));
      assert.equal(sidecarManifest.command, process.execPath);
      assert.ok(sidecarManifest.args[0].endsWith(path.join('src', 'sidecar', 'server.mjs')));
      assert.equal(sidecarManifest.has_web_ui, true);
      assert.equal(sidecarManifest.restart_policy, 'always');
      assert.equal(sidecarManifest.agent_permissions.allows_user_interactions, false);
      const entrypoints = sidecarManifest.ui_config.views.map((v) => v.entrypoint);
      assert.deepEqual(entrypoints, [
        'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
        'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
      ]);

      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(agyInstall.pluginDir, 'plugin.json'), 'utf8')
      );
      const allowedKeys = new Set([
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
      for (const key of Object.keys(pluginJson)) {
        assert.ok(allowedKeys.has(key), `unexpected plugin.json key: ${key}`);
      }
    } finally {
      await sidecar.close();
    }
  });
});
