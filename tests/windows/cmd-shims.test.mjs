import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { installForCodexHost } from '../../src/installer.mjs';
import {
  buildChildEnv,
  createCmdShimFixture,
  FAKE_FILES,
  MCP_SERVER,
  rmTree,
  ROOT_DIR,
  runCospan,
  TARGET_BIN_ENV_VARS,
  WIN_ONLY,
  writeNpmCmdShim,
} from '../helpers/windows.mjs';

test(
  'win32 .cmd shims: doctor --check discovers all 4 targets, versions, and contracts',
  WIN_ONLY,
  () => {
    const fx = createCmdShimFixture('cospan-win-doc-');
    try {
      const docRes = runCospan(['doctor', '--check', '--offline', '--json'], {
        cwd: fx.repo,
        env: fx.env,
      });
      assert.equal(docRes.code, 0, `doctor stderr=${docRes.stderr}\nstdout=${docRes.stdout}`);
      const parsed = JSON.parse(docRes.stdout);
      assert.equal(parsed.contracts_ok, true, JSON.stringify(parsed.contracts, null, 2));
      for (const id of ['agy', 'codex', 'claude', 'dsh']) {
        assert.equal(parsed.targets[id].installed, true, `${id} should be discovered`);
        assert.match(parsed.targets[id].binary, /\.cmd$/i, `${id} should resolve to .cmd shim`);
        assert.ok(parsed.targets[id].version, `${id} version probe should succeed via .cmd shim`);
        assert.equal(parsed.contracts[id]?.ok, true, `${id} --help contract probe should succeed`);
      }
    } finally {
      rmTree(fx.root);
    }
  }
);

test(
  'win32 .cmd shims: ask and send+wait preserve cmd.exe-hostile prompts on codex and agy',
  WIN_ONLY,
  () => {
    const fx = createCmdShimFixture('cospan-win-cmd-');
    try {
      const askRes = runCospan(['ask', '--to', 'codex', '--prompt', 'hello via cmd'], {
        cwd: fx.repo,
        env: fx.env,
      });
      assert.equal(askRes.code, 0, `ask failed: ${askRes.stderr}\n${askRes.stdout}`);
      assert.match(askRes.stdout, /codex_model=/);
      assert.match(askRes.stdout, /hello via cmd/);

      const hostilePrompt = [
        'Line 1: "double quotes" & ampersand | pipe',
        'Line 2: literal %OS% must stay unexpanded',
        'Line 3: trailing sentinel END_HOSTILE',
      ].join('\n');

      for (const target of ['codex', 'agy']) {
        const sendRes = runCospan(['send', '--to', target, '--raw', '--stdin', '--json'], {
          cwd: fx.repo,
          env: fx.env,
          input: hostilePrompt,
        });
        assert.equal(sendRes.code, 0, `${target} send failed: ${sendRes.stderr}`);
        const { job_id: jobId } = JSON.parse(sendRes.stdout);

        const waitRes = runCospan(['wait', jobId, '--timeout', '30s'], {
          cwd: fx.repo,
          env: fx.env,
        });
        assert.equal(
          waitRes.code,
          0,
          `${target} wait failed (code ${waitRes.code}):\n${waitRes.stdout}\n${waitRes.stderr}`
        );
        assert.ok(waitRes.stdout.includes('Line 1: "double quotes" & ampersand | pipe'));
        assert.ok(waitRes.stdout.includes('Line 2: literal %OS% must stay unexpanded'));
        assert.ok(waitRes.stdout.includes('Line 3: trailing sentinel END_HOSTILE'));
        assert.ok(
          !waitRes.stdout.includes('Windows_NT'),
          `${target} must not expand %OS% via cmd.exe`
        );
      }
    } finally {
      rmTree(fx.root);
    }
  }
);

test(
  'win32 .cmd shims: installForCodexHost registers marketplace via codex.cmd without EINVAL',
  WIN_ONLY,
  () => {
    const fx = createCmdShimFixture('cospan-win-reg-');
    try {
      const codexPkgRoot = path.join(fx.root, 'codex-pkg');
      const marketRoot = path.join(fx.root, 'codex-market');
      fs.mkdirSync(path.join(codexPkgRoot, 'src', 'mcp'), { recursive: true });
      fs.copyFileSync(MCP_SERVER, path.join(codexPkgRoot, 'src', 'mcp', 'cospan-mcp.mjs'));

      const discovered = {
        codex: {
          id: 'codex',
          installed: true,
          binary: fx.shims.codex,
          version: '0.167.2-fake',
          phase: 1,
          driverReady: true,
        },
      };
      const res = installForCodexHost({
        discovered,
        registerWithCodexCli: true,
        packageRoot: codexPkgRoot,
        marketplaceRoot: marketRoot,
      });
      assert.equal(res.registration.attempted, true);
      assert.equal(res.registration.ok, true, JSON.stringify(res.registration, null, 2));
    } finally {
      rmTree(fx.root);
    }
  }
);

test(
  'win32 fallback discovery: discoverAllTargets finds %APPDATA%\\npm and .local\\bin shims',
  WIN_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cospan-win-fallback-'));
    try {
      const profile = path.join(root, 'profile');
      const appData = path.join(profile, 'AppData', 'Roaming');
      const localAppData = path.join(profile, 'AppData', 'Local');
      const npmBin = path.join(appData, 'npm');
      const localBin = path.join(profile, '.local', 'bin');
      const home = path.join(root, 'cospan-home');

      for (const d of [npmBin, localBin, localAppData, home]) {
        fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
      }
      fs.copyFileSync(FAKE_FILES.codex, path.join(npmBin, 'scripts', 'fake-codex.mjs'));
      fs.copyFileSync(FAKE_FILES.claude, path.join(localBin, 'scripts', 'fake-claude.mjs'));
      const codexShim = writeNpmCmdShim(npmBin, 'codex', 'scripts\\fake-codex.mjs');
      const claudeShim = writeNpmCmdShim(localBin, 'claude', 'scripts\\fake-claude.mjs');

      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const targetsUrl = pathToFileURL(path.join(ROOT_DIR, 'src', 'targets.mjs')).href;
      const probeScript =
        `import { discoverAllTargets } from ${JSON.stringify(targetsUrl)};` +
        'process.stdout.write(JSON.stringify(discoverAllTargets()));';

      const env = buildChildEnv(
        {
          USERPROFILE: profile,
          HOME: profile,
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
          COSPAN_HOME: home,
          COSPAN_CONFIG_DIR: home,
          PATH: `${sysRoot}\\System32;${sysRoot}`,
        },
        [...TARGET_BIN_ENV_VARS, 'HOMEDRIVE', 'HOMEPATH']
      );
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(res.status, 0, res.stderr);
      const discovered = JSON.parse(res.stdout);
      assert.equal(discovered.codex.installed, true, JSON.stringify(discovered.codex));
      assert.equal(path.resolve(discovered.codex.binary), path.resolve(codexShim));
      assert.equal(discovered.claude.installed, true, JSON.stringify(discovered.claude));
      assert.equal(path.resolve(discovered.claude.binary), path.resolve(claudeShim));
    } finally {
      rmTree(root);
    }
  }
);
