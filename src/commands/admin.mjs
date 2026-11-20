import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkAllInstalledContracts } from '../contract-check.mjs';
import { getDriver, listActiveTargetIds } from '../drivers/index.mjs';
import { runInstall } from '../installer.mjs';
import { excerpt } from '../observation.mjs';
import {
  buildSpawnCommand,
  cospanHomeDir,
  discoverAllTargets,
  globalConfigFilePath,
  loadEffectiveConfig,
  resolveEffectivePermissions,
  trajectoryConfigFilePath,
  workspaceTrajectoryDir,
  writeConfigTemplate,
} from '../targets.mjs';
import { die } from '../cli-args.mjs';
import { repoRoot } from '../job-store.mjs';
import {
  checkForUpdate,
  detectStaleConfigOverrides,
  formatUpdateStatusLine,
} from '../update-check.mjs';

function pingTarget(targetId, binary, config) {
  const driver = getDriver(targetId);
  const resolvedCfg = driver.resolveConfig({ kind: 'ask', config });
  const workspace = repoRoot();
  const permissions = resolveEffectivePermissions(config, targetId);
  const inv = driver.buildInvocation({
    kind: 'ask',
    prompt: 'Reply with the exact word OK and nothing else.',
    model: resolvedCfg.model,
    effort: resolvedCfg.effort,
    timeout: '45s',
    workspace,
    readonly: true,
    permissions,
  });
  const spawnCmd = buildSpawnCommand(binary, inv.args);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spawnCmd.cmd, spawnCmd.args, {
      cwd: inv.cwd || workspace,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
      stdio: [inv.stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ ok: false, latency_ms: Date.now() - t0, error: 'ping timed out after 45s' });
    }, 45000);
    if (inv.stdinText !== null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(inv.stdinText, 'utf8');
    }
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, latency_ms: Date.now() - t0, error: err.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const out = driver.parseForegroundOutput({ stdout, stderr, exitCode: code ?? 1 });
        resolve({
          ok: true,
          latency_ms: Date.now() - t0,
          model: resolvedCfg.model,
          reply: excerpt((out.response || '').trim(), 80).text,
        });
      } catch (err) {
        resolve({ ok: false, latency_ms: Date.now() - t0, error: excerpt(err.message, 240).text });
      }
    });
  });
}

function formatTargetStatusLabel(info) {
  if (!info.installed) return 'NOT FOUND';
  return info.driverReady ? 'READY' : 'DETECTED (Phase 2)';
}

function formatContractLine(c) {
  if (c.ok) return `OK (${c.verified_flags} flags across ${c.probes_checked} --help probe(s))`;
  return c.error ? `FAILED (${c.error})` : `DRIFT (missing: ${c.missing_flags.join(', ')})`;
}

function printDoctorTargetBlock(id, info, contractReport, pingReport) {
  const statusLabel = formatTargetStatusLabel(info);
  const versionSuffix = info.version ? ` (${info.version})` : '';
  process.stdout.write(
    `  ${id.padEnd(8)} ${statusLabel.padEnd(20)} ${info.binary || '-'}${versionSuffix}\n`
  );
  if (contractReport)
    process.stdout.write(`           contract: ${formatContractLine(contractReport)}\n`);
  if (pingReport) {
    const model = pingReport.model || 'default';
    const msg = pingReport.ok
      ? `OK in ${pingReport.latency_ms}ms [${model}] -> "${pingReport.reply}"`
      : `FAILED (${pingReport.error})`;
    process.stdout.write(`           ping: ${msg}\n`);
  }
}

function printStaleOverridesWarning(staleOverrides) {
  if (!staleOverrides?.length) return;
  process.stdout.write(
    '\nWarning: global/repo config pins legacy model defaults that override newer built-ins:\n'
  );
  for (const item of staleOverrides) {
    process.stdout.write(
      `  - ${item.key} = ${JSON.stringify(item.current_value)} ` +
        `(builtin: ${JSON.stringify(item.builtin_value)}; from ${item.source})\n`
    );
  }
  process.stdout.write(
    '  Reset global config to sparse `{}` with: cospan config --init --global --force\n'
  );
}

export async function cmdDoctor(opts) {
  const discovered = discoverAllTargets();
  const { config, overrides } = loadEffectiveConfig({
    workspaceRoot: repoRoot(),
    explicitConfigPath: opts.config,
  });
  const staleOverrides = detectStaleConfigOverrides(overrides);
  const contractCheck = opts.check ? checkAllInstalledContracts(discovered) : null;
  if (contractCheck && !contractCheck.allOk) process.exitCode = 1;

  const updateInfo = await checkForUpdate({ offline: Boolean(opts.offline), config });
  const pings = {};
  if (opts.ping) {
    const active = listActiveTargetIds().filter((id) => discovered[id]?.installed);
    await Promise.all(
      active.map(async (id) => {
        pings[id] = await pingTarget(id, discovered[id].binary, config);
      })
    );
  }
  if (opts.json) {
    const out = {
      targets: discovered,
      update: updateInfo,
      stale_overrides: staleOverrides,
      ...(contractCheck
        ? { contracts_ok: contractCheck.allOk, contracts: contractCheck.contracts }
        : {}),
      ...(opts.ping ? { pings } : {}),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  process.stdout.write('cospan doctor — Target Harness Inventory\n\n');
  for (const [id, info] of Object.entries(discovered)) {
    printDoctorTargetBlock(id, info, contractCheck?.contracts?.[id], pings[id]);
  }
  process.stdout.write(`\n  update   ${formatUpdateStatusLine(updateInfo)}\n`);
  printStaleOverridesWarning(staleOverrides);
}

function resolveInitConfigPath(opts, root) {
  const scopes = [opts.global, opts.workspace, opts.trajectory].filter(Boolean);
  if (scopes.length > 1) {
    die('cannot combine `--global`, `--workspace`, and `--trajectory` in `cospan config --init`');
  }
  if (opts.workspace) return path.join(root, '.cospan', 'config.json');
  if (opts.trajectory) return trajectoryConfigFilePath(root);
  return globalConfigFilePath();
}

function printConfigOverridesSummary(overrides) {
  const entries = Object.entries(overrides || {});
  if (!entries.length) {
    process.stdout.write('active overrides:  none (all effective values from builtin)\n');
    return;
  }
  process.stdout.write('active overrides:\n');
  for (const [key, info] of entries) {
    process.stdout.write(
      `  - ${key} = ${JSON.stringify(info.value)} (${info.scope}: ${info.source})\n`
    );
  }
}

export function cmdConfig(opts) {
  const root = repoRoot();
  if (opts.init) {
    const targetFile = resolveInitConfigPath(opts, root);
    if (fs.existsSync(targetFile) && !opts.force) {
      die(`config file already exists at ${targetFile} (pass --force to overwrite)`);
    }
    writeConfigTemplate(targetFile);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ initialized: targetFile }, null, 2) + '\n');
    } else {
      process.stdout.write(`Initialized sparse cospan config -> ${targetFile}\n`);
    }
    return;
  }

  const { config, loadedFiles, sources, overrides } = loadEffectiveConfig({
    workspaceRoot: root,
    explicitConfigPath: opts.config,
  });
  const staleOverrides = detectStaleConfigOverrides(overrides);
  const payload = {
    home_dir: cospanHomeDir(),
    trajectory_dir: workspaceTrajectoryDir(root),
    loaded_files: loadedFiles,
    sources,
    overrides,
    stale_overrides: staleOverrides,
    effective_config: config,
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  process.stdout.write(`cospan home:       ${payload.home_dir}\n`);
  process.stdout.write(`trajectory dir:    ${payload.trajectory_dir}\n`);
  const loadedLabel = loadedFiles.length ? loadedFiles.join(' -> ') : '(built-in defaults only)';
  process.stdout.write(`loaded configs:    ${loadedLabel}\n`);
  printConfigOverridesSummary(overrides);
  printStaleOverridesWarning(staleOverrides);
  process.stdout.write(
    'init / reset:      cospan config --init [--global | --workspace | --trajectory] --force\n\n'
  );
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
}

function formatCodexRegistrationStatus(reg) {
  if (!reg.attempted) return 'skipped';
  return reg.ok ? 'OK' : 'WARN (see --json)';
}

export function cmdInstall(opts) {
  const host = (opts.host || 'all').toLowerCase();
  if (!['all', 'agy', 'codex'].includes(host)) {
    die(`invalid --host "${opts.host}" (expected all|agy|codex)`);
  }
  const outcome = runInstall({
    host,
    force: Boolean(opts.force),
    registerWithCodexCli: !opts.noCodexCli,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    return;
  }

  if (outcome.configFile) {
    const verb = outcome.configFile.created ? 'Created' : 'Verified';
    process.stdout.write(`${verb} global config -> ${outcome.configFile.path}\n`);
  }
  process.stdout.write(`Pinned discovered target binaries -> ${outcome.targetsPath}\n`);
  for (const r of outcome.results) {
    if (r.host === 'agy') {
      process.stdout.write(
        `Installed Antigravity host bundle -> ${r.pluginDir}\n` +
          `  skills: ${r.skills.join(', ')}\n`
      );
    } else if (r.host === 'codex') {
      const regStatus = formatCodexRegistrationStatus(r.registration);
      process.stdout.write(
        `Generated Codex host bundle -> ${r.packageRoot} (marketplace: ${r.marketplaceRoot})\n` +
          `  skills: ${r.skills.join(', ')}\n` +
          `  codex plugin registration: ${regStatus}\n`
      );
    }
  }
  const { overrides } = loadEffectiveConfig({ workspaceRoot: repoRoot() });
  printStaleOverridesWarning(detectStaleConfigOverrides(overrides));
}
