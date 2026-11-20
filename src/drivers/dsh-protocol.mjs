import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildSpawnCommand,
  BUILTIN_CONFIG,
  loadEffectiveConfig,
  resolveTargetBinary,
  workspaceTrajectoryDir,
} from '../targets.mjs';

const NATIVE_DSH_EFFORTS = new Set(['off', 'low', 'high', 'max']);
const MAX_RETAINED_PATCHES = 20;

export function normalizeDshEffort(effort, fallback) {
  if (!effort) return fallback;
  const e = String(effort).toLowerCase();
  if (e === 'inherit') return null;
  if (NATIVE_DSH_EFFORTS.has(e)) return e;
  if (e === 'none' || e === 'minimal') return 'off';
  if (e === 'medium') {
    process.stderr.write(
      `cospan: dsh uses off|low|high|max reasoningEffort; mapping --effort medium -> high\n`
    );
    return 'high';
  }
  if (e === 'xhigh') {
    process.stderr.write(
      `cospan: dsh uses off|low|high|max reasoningEffort; mapping --effort xhigh -> max\n`
    );
    return 'max';
  }
  throw new Error(`invalid --effort "${effort}" for dsh (expected off|low|medium|high|xhigh|max)`);
}

function pickDshBaseDefaults(defaults, kind) {
  const sendModel = defaults.model || defaults.sendModel || 'inherit';
  if (kind === 'ask') {
    return {
      defaultModel: defaults.askModel || sendModel,
      defaultEffort: defaults.askEffort || 'inherit',
    };
  }
  return {
    defaultModel: sendModel,
    defaultEffort: defaults.effort || defaults.sendEffort || 'inherit',
  };
}

function encodeDshModelWithProvider(mappedModel, provider) {
  if (!mappedModel || mappedModel.includes('/')) return mappedModel;
  return provider && provider !== 'deepseek-official' ? `${provider}/${mappedModel}` : mappedModel;
}

export function resolveDshModelAndEffort({ kind = 'send', model, effort, config } = {}) {
  const effective = config || loadEffectiveConfig().config;
  const defaults = { ...BUILTIN_CONFIG.defaults.dsh, ...(effective?.defaults?.dsh || {}) };
  const mappings = { ...BUILTIN_CONFIG.mappings.dsh, ...(effective?.mappings?.dsh || {}) };

  const { defaultModel, defaultEffort } = pickDshBaseDefaults(defaults, kind);
  const rawModel = model || defaultModel;
  const mappedModel =
    rawModel === 'inherit'
      ? null
      : Object.hasOwn(mappings, rawModel)
        ? mappings[rawModel]
        : rawModel;
  const encodedModel = encodeDshModelWithProvider(mappedModel, defaults.provider);
  const resolvedEffort = normalizeDshEffort(
    effort,
    defaultEffort === 'inherit' ? null : defaultEffort
  );
  return { model: encodedModel, effort: resolvedEffort };
}

function splitProviderAndModel(modelSpec, workspace) {
  if (modelSpec.includes('/')) {
    const slash = modelSpec.indexOf('/');
    return { provider: modelSpec.slice(0, slash), model: modelSpec.slice(slash + 1) };
  }
  const cfgProvider = loadEffectiveConfig({ workspaceRoot: workspace }).config?.defaults?.dsh
    ?.provider;
  return {
    provider: cfgProvider || 'deepseek-official',
    model: modelSpec,
  };
}

function cleanYamlScalar(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.startsWith('!!js')) return null;
  const quoted = /^(?:"([^"]*)"|'([^']*)')(?:\s+#.*)?$/.exec(trimmed);
  if (quoted) return (quoted[1] ?? quoted[2]).trim() || null;
  return trimmed.replace(/\s+#.*$/, '').trim() || null;
}

function splitYamlListItems(raw) {
  const items = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const itemStart = /^-\s*(.*)$/.exec(line);
    if (itemStart) {
      current = itemStart[1].trim() ? [`  ${itemStart[1].trim()}`] : [];
      items.push(current);
    } else if (current && /^\s+/.test(line)) {
      current.push(line);
    } else {
      current = null;
    }
  }
  return items;
}

function parseAgentDefaultModelBlock(lines) {
  const isTarget = lines.some((l) =>
    /^id:\s*['"]?agent-default-model['"]?(?:\s+#.*)?$/.test(l.trim())
  );
  if (!isTarget) return null;

  let configIndent = -1;
  const cfg = {};
  for (const line of lines) {
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    if (configIndent >= 0 && indent <= configIndent) configIndent = -1;
    if (/^config:\s*(?:#.*)?$/.test(trimmed)) {
      configIndent = indent;
      continue;
    }
    if (configIndent >= 0) {
      const kv = /^(provider|model):\s*(.+)$/.exec(trimmed);
      if (kv) cfg[kv[1]] = cleanYamlScalar(kv[2]);
    }
  }
  return cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;
}

function extractAgentDefaultModelFromJson(trimmed) {
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    for (const entry of [...parsed].reverse()) {
      const cfg = entry?.id === 'agent-default-model' ? entry?.config : null;
      if (
        typeof cfg?.provider === 'string' &&
        cfg.provider &&
        typeof cfg?.model === 'string' &&
        cfg.model
      ) {
        return { provider: cfg.provider, model: cfg.model };
      }
    }
  } catch {}
  return null;
}

export function extractDshAgentDefaultModelFromText(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const fromJson = extractAgentDefaultModelFromJson(trimmed);
  if (fromJson) return fromJson;
  const items = splitYamlListItems(trimmed);
  for (const block of [...items].reverse()) {
    const found = parseAgentDefaultModelBlock(block);
    if (found) return found;
  }
  return null;
}

export function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readDshConfiguredModelFromHome(dshHome) {
  const candidates = [
    path.join(dshHome, 'cordis.patch.yml'),
    path.join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const found = extractDshAgentDefaultModelFromText(fs.readFileSync(file, 'utf8'));
      if (found) return found;
    } catch {}
  }
  return null;
}

function probeDshProfileDefaultModel(dshHome) {
  const binary = resolveTargetBinary('dsh');
  if (!binary || /\.(mjs|cjs|js)$/i.test(binary)) return null;
  if (!fs.existsSync(path.join(dshHome, 'profiles', 'headless'))) return null;
  const spawnCmd = buildSpawnCommand(binary, ['--profile', 'headless', '--dump-config']);
  const res = spawnSync(spawnCmd.cmd, spawnCmd.args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
  });
  if (res.error || res.status !== 0) return null;
  return extractDshAgentDefaultModelFromText(res.stdout);
}

function resolveDshPatchTarget({ model, effort, workspace }) {
  if (model) return splitProviderAndModel(model, workspace);
  const dshHome = dshHomeDir();
  const inherited = readDshConfiguredModelFromHome(dshHome) || probeDshProfileDefaultModel(dshHome);
  if (inherited) return inherited;
  throw new Error(
    `cannot apply --effort "${effort}" for dsh when model is "inherit" because no configured ` +
      `provider/model was found in ${dshHome}; configure agent-default-model in ${dshHome} or ` +
      'pass an explicit --model (e.g. flash, pro, or <provider>/<model>)'
  );
}

function pruneOldPatchFiles(patchesDir) {
  try {
    const files = fs
      .readdirSync(patchesDir)
      .filter((f) => f.startsWith('dsh-patch-') && f.endsWith('.json'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_RETAINED_PATCHES))) {
      fs.unlinkSync(path.join(patchesDir, stale));
    }
  } catch {}
}

export function writeDshModelPatchFile({ workspace, model, effort }) {
  if (!model && !effort) return null;
  const { provider, model: modelId } = resolveDshPatchTarget({ model, effort, workspace });
  const patchPayload = [
    {
      id: 'agent-default-model',
      config: {
        provider,
        model: modelId,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    },
  ];
  const patchesDir = path.join(workspaceTrajectoryDir(workspace), 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `dsh-patch-${Date.now()}-${process.pid}-${rand}.json`;
  const patchPath = path.join(patchesDir, filename);
  fs.writeFileSync(patchPath, JSON.stringify(patchPayload, null, 2) + '\n');
  pruneOldPatchFiles(patchesDir);
  return patchPath;
}
