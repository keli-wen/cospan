import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getDriver } from '../drivers/index.mjs';
import {
  buildSpawnCommand,
  loadEffectiveConfig,
  resolveEffectivePermissions,
  resolveTargetBinary,
} from '../targets.mjs';
import {
  DEFAULT_ASK_TIMEOUT,
  die,
  durationToMs,
  pickExplicitPermission,
  readTaskPrompt,
  validatePermissionsFlags,
  validateSendTimeout,
} from '../cli-args.mjs';
import { findJob, liveJobStatus, loadState, repoRoot } from '../job-store.mjs';
import { launchDetachedJob } from '../job-worker.mjs';
import { consumeCachedUpdateNotice, triggerBackgroundUpdateCheck } from '../update-check.mjs';

function maybeEmitUpdateNotice(config) {
  triggerBackgroundUpdateCheck({ config });
  const notice = consumeCachedUpdateNotice({ config });
  if (notice) process.stderr.write(`${notice}\n`);
}

export function cmdSend(opts) {
  if (!opts.to) die('`send` requires `--to <agy|codex|claude|dsh>`');
  validatePermissionsFlags(opts);
  const prompt = readTaskPrompt(opts);
  const timeout = validateSendTimeout(opts.timeout);
  const root = repoRoot(process.cwd());
  const { config } = loadEffectiveConfig({ workspaceRoot: root, explicitConfigPath: opts.config });
  const permissions = resolveEffectivePermissions(config, String(opts.to).toLowerCase(), {
    restricted: Boolean(opts.restricted),
    unrestricted: Boolean(opts.unrestricted),
  });
  maybeEmitUpdateNotice(config);
  const record = launchDetachedJob({
    target: opts.to,
    prompt,
    readonly: Boolean(opts.readonly),
    permissions,
    explicitConfigPath: opts.config,
    raw: Boolean(opts.raw),
    model: opts.model,
    effort: opts.effort,
    timeout,
    cwd: process.cwd(),
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        job_id: record.id,
        target: record.target,
        status: record.status,
        readonly: record.readonly,
        permissions: record.permissions,
        model: record.model,
        effort: record.effort,
        timeout: record.timeout,
        started_at: record.started_at,
      }) + '\n'
    );
    return;
  }

  const access = record.readonly ? 'readonly' : 'writable';
  process.stdout.write(
    `Job ${record.id} started (target=${record.target}, access=${access}, ` +
      `permissions=${record.permissions}, model=${record.model || 'default'}` +
      (record.effort ? `, effort=${record.effort}` : '') +
      `).\nCollect with: cospan wait ${record.id}\n`
  );
}

function executeForegroundAsk(driver, binary, inv, workspace, timeout, timeoutMs) {
  const spawnCmd = buildSpawnCommand(binary, inv.args);
  const r = spawnSync(spawnCmd.cmd, spawnCmd.args, {
    cwd: inv.cwd || workspace,
    input: inv.stdinText !== null ? inv.stdinText : undefined,
    encoding: 'utf8',
    timeout: timeoutMs + 15000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
  });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') die(`ask timed out after ${timeout}`);
    die(`failed to launch ${driver.id}: ${r.error.message}`);
  }
  try {
    return driver.parseForegroundOutput({
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      exitCode: r.status ?? 1,
    });
  } catch (err) {
    die(err.message);
  }
}

export function cmdAsk(opts) {
  if (!opts.to) die('`ask` requires `--to <agy|codex|claude|dsh>`');
  validatePermissionsFlags(opts);
  const driver = getDriver(opts.to);
  const binary = resolveTargetBinary(driver.id);
  if (!binary) {
    const hint = driver.installHint || '';
    die(`target CLI "${driver.id}" is not installed or not found on PATH.\n${hint}`);
  }
  const prompt = readTaskPrompt(opts);
  const timeout = opts.timeout || DEFAULT_ASK_TIMEOUT;
  const timeoutMs = durationToMs(timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die(`invalid --timeout "${timeout}"`);

  const workspace = repoRoot(process.cwd());
  const { config } = loadEffectiveConfig({
    workspaceRoot: workspace,
    explicitConfigPath: opts.config,
  });
  const permissions = resolveEffectivePermissions(config, driver.id, {
    restricted: Boolean(opts.restricted),
    unrestricted: Boolean(opts.unrestricted),
  });
  const resolvedCfg = driver.resolveConfig({
    kind: 'ask',
    model: opts.model,
    effort: opts.effort,
    config,
  });
  const inv = driver.buildInvocation({
    kind: 'ask',
    prompt,
    model: resolvedCfg.model,
    effort: resolvedCfg.effort,
    timeout,
    workspace,
    readonly: true,
    permissions,
  });

  const t0 = Date.now();
  const parsed = executeForegroundAsk(driver, binary, inv, workspace, timeout, timeoutMs);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  maybeEmitUpdateNotice(config);
  process.stderr.write(
    `[cospan] ask target=${driver.id} model=${resolvedCfg.model || 'default'}` +
      (resolvedCfg.effort ? ` effort=${resolvedCfg.effort}` : '') +
      ` permissions=${permissions} duration=${elapsed}s\n`
  );
  process.stdout.write((parsed.response || '').trimEnd() + '\n');
}

function resolveContinuationSourceJob(opts, root) {
  if (!opts.last) {
    const prevId = opts.id || opts._[0];
    if (!prevId) die('`continue` requires `--id <job-id>` or `--last`');
    return findJob(prevId, root);
  }
  const targetFilter = opts.to ? String(opts.to).toLowerCase() : null;
  const jobs = loadState(root).jobs || [];
  const prev = [...jobs]
    .reverse()
    .find(
      (j) =>
        liveJobStatus(j) !== 'running' &&
        j.conversation_id &&
        (!targetFilter || j.target === targetFilter)
    );
  if (!prev) {
    die(
      opts.to
        ? `no previous resumable "${opts.to}" job found in this workspace`
        : 'no previous resumable cospan job found in this workspace'
    );
  }
  return prev;
}

export function cmdContinue(opts) {
  validatePermissionsFlags(opts);
  const root = repoRoot();
  const prev = resolveContinuationSourceJob(opts, root);
  if (liveJobStatus(prev) === 'running') {
    die(`job ${prev.id} is still running — wait for it or cancel it before continuing`);
  }
  if (!prev.conversation_id) {
    die(
      `job ${prev.id} has no recorded session/conversation ID to continue ` +
        `(use \`restart ${prev.id}\` instead)`
    );
  }
  const prompt = readTaskPrompt(opts);
  const timeout = validateSendTimeout(opts.timeout || prev.timeout);
  const { config } = loadEffectiveConfig({ workspaceRoot: root, explicitConfigPath: opts.config });
  maybeEmitUpdateNotice(config);
  const record = launchDetachedJob({
    target: prev.target,
    prompt,
    readonly: opts.readonly !== undefined ? Boolean(opts.readonly) : Boolean(prev.readonly),
    permissions: pickExplicitPermission(opts, prev.permissions || null),
    explicitConfigPath: opts.config,
    raw: opts.raw !== undefined ? Boolean(opts.raw) : Boolean(prev.raw),
    model: opts.model,
    effort: opts.effort,
    prior: prev,
    timeout,
    conversationId: prev.conversation_id,
    continuedFrom: prev.id,
    cwd: prev.cwd || process.cwd(),
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        job_id: record.id,
        continued_from: prev.id,
        conversation_id: record.conversation_id,
        target: record.target,
        status: record.status,
        readonly: record.readonly,
        permissions: record.permissions,
        model: record.model,
        effort: record.effort,
      }) + '\n'
    );
    return;
  }

  process.stdout.write(
    `Job ${record.id} started (continuing ${prev.id} on ${record.target}, ` +
      `session=${record.conversation_id}).\nCollect with: cospan wait ${record.id}\n`
  );
}

export function cmdRestart(opts) {
  validatePermissionsFlags(opts);
  const prevId = opts._[0] || opts.id;
  if (!prevId) die('`restart` requires `<job-id>`');
  const root = repoRoot();
  const prev = findJob(prevId, root);
  if (liveJobStatus(prev) === 'running') {
    die(`job ${prev.id} is still running — cancel it before restarting`);
  }
  if (!prev.spec_file || !fs.existsSync(prev.spec_file)) {
    die(`job ${prev.id} has no stored spec_file to restart`);
  }
  const spec = JSON.parse(fs.readFileSync(prev.spec_file, 'utf8'));
  const timeout = validateSendTimeout(opts.timeout || spec.timeout);
  const record = launchDetachedJob({
    target: spec.target,
    prompt: spec.prompt,
    readonly: spec.readonly,
    permissions: pickExplicitPermission(opts, spec.permissions || null),
    explicitConfigPath: opts.config,
    raw: spec.raw,
    model: opts.model,
    effort: opts.effort,
    prior: spec,
    timeout,
    restartedFrom: prev.id,
    cwd: spec.cwd || process.cwd(),
  });
  process.stdout.write(
    `Restarted ${prev.id} as new job ${record.id} (${record.target}).\n` +
      `Collect with: cospan wait ${record.id}\n`
  );
}
