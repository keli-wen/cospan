import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TARGET_MODEL_SHORTCUTS = {
  agy: ['flash', 'neon', 'carbon', 'argon', 'hydrogen', 'opus', 'sonnet'],
  codex: ['sol', 'terra', 'astra', 'luna'],
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  dsh: ['flash', 'pro', 'v4.1-flash', 'v4-pro'],
  grok: ['build', 'fast'],
};

export const BUILTIN_CONFIG = {
  permissions: 'unrestricted',
  updateCheck: true,
  defaults: {
    agy: {
      model: 'gemini-3.8-flash-medium',
      askModel: 'gemini-3.8-flash-medium',
      effort: 'medium',
    },
    codex: {
      model: 'gpt-6.2-sol',
      effort: 'high',
      askModel: 'gpt-6.2-sol',
      askEffort: 'low',
    },
    claude: {
      model: 'sonnet',
      effort: 'high',
      askModel: 'sonnet',
      askEffort: 'low',
    },
    dsh: {
      model: 'inherit',
      effort: 'inherit',
      askModel: 'inherit',
      askEffort: 'inherit',
      provider: 'deepseek-official',
    },
    grok: {
      model: 'inherit',
      effort: 'high',
      askModel: 'inherit',
      askEffort: 'low',
    },
  },
  mappings: {
    agy: {
      'gemini-3.8-flash': 'gemini-3.8-flash-medium',
      flash: 'gemini-3.8-flash-medium',
      'gemini-4-neon': 'gemini-4-neon-medium',
      neon: 'gemini-4-neon-medium',
      'gemini-4-carbon': 'gemini-4-carbon-medium',
      carbon: 'gemini-4-carbon-medium',
      'gemini-4-argon': 'gemini-4-argon-medium',
      argon: 'gemini-4-argon-medium',
      'gemini-4-hydrogen': 'gemini-4-hydrogen-medium',
      hydrogen: 'gemini-4-hydrogen-medium',
      'claude-opus-5-5': 'claude-opus-5-5-medium',
      opus: 'claude-opus-5-5-medium',
      'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
      sonnet: 'claude-sonnet-5-5-medium',
    },
    codex: {
      sol: 'gpt-6.2-sol',
      terra: 'gpt-6.1-terra',
      astra: 'gpt-6.2-astra',
      luna: 'gpt-6-luna',
      spark: 'gpt-5.3-codex-spark',
    },
    claude: {
      sonnet: 'sonnet',
      'sonnet5.5': 'sonnet',
      'sonnet-5.5': 'sonnet',
      opus: 'opus',
      'opus5.5': 'opus',
      'opus-5.5': 'opus',
      haiku: 'haiku',
      fable: 'fable',
    },
    dsh: {
      flash: 'deepseek-flash',
      'v4.1-flash': 'deepseek-flash',
      'deepseek-v4.1-flash': 'deepseek-flash',
      pro: 'deepseek-v4-pro',
      'v4-pro': 'deepseek-v4-pro',
    },
    grok: {
      build: 'grok-4.7',
      fast: 'grok-4.7-build-fast',
    },
  },
};

export function cospanHomeDir() {
  return (
    process.env.COSPAN_HOME || process.env.COSPAN_CONFIG_DIR || path.join(os.homedir(), '.cospan')
  );
}

export const configDir = cospanHomeDir;

export function targetsFilePath() {
  return path.join(cospanHomeDir(), 'targets.json');
}

export function globalConfigFilePath() {
  return path.join(cospanHomeDir(), 'config.json');
}

export function realpathNative(targetPath) {
  return (fs.realpathSync.native || fs.realpathSync)(targetPath);
}

export function workspaceTrajectoryDir(workspaceRoot) {
  let canonical = workspaceRoot || process.cwd();
  try {
    canonical = realpathNative(canonical);
  } catch {}
  const baseSlug =
    (path.basename(canonical) || 'workspace')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace';
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return path.join(cospanHomeDir(), 'trajectories', `${baseSlug}-${hash}`);
}

export function trajectoryConfigFilePath(workspaceRoot) {
  return path.join(workspaceTrajectoryDir(workspaceRoot), 'config.json');
}

export function workspaceConfigCandidates(workspaceRoot) {
  if (!workspaceRoot) return [];
  return [
    path.join(workspaceRoot, '.cospan', 'config.json'),
    path.join(workspaceRoot, 'cospan.config.json'),
  ];
}

function isPermissionMode(value) {
  return value === 'restricted' || value === 'unrestricted';
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeGroupWithProvenance({
  targetGroup,
  incomingGroup,
  prefix,
  filePath,
  scope,
  overrides,
  keys,
}) {
  if (!incomingGroup || typeof incomingGroup !== 'object') return;
  for (const [targetId, vals] of Object.entries(incomingGroup)) {
    if (!vals || typeof vals !== 'object' || Array.isArray(vals)) continue;
    targetGroup[targetId] = { ...(targetGroup[targetId] || {}), ...vals };
    for (const [k, v] of Object.entries(vals)) {
      const dotted = `${prefix}.${targetId}.${k}`;
      overrides[dotted] = { value: v, source: filePath, scope };
      keys.push(dotted);
    }
  }
}

function mergeConfigLayer(base, layer, { filePath, scope, overrides }) {
  if (!layer || typeof layer !== 'object') return { merged: base, keys: [] };
  const out = structuredClone(base);
  const keys = [];
  if (isPermissionMode(layer.permissions)) {
    out.permissions = layer.permissions;
    overrides.permissions = { value: layer.permissions, source: filePath, scope };
    keys.push('permissions');
  }
  if (typeof layer.updateCheck === 'boolean') {
    out.updateCheck = layer.updateCheck;
    overrides.updateCheck = { value: layer.updateCheck, source: filePath, scope };
    keys.push('updateCheck');
  }
  mergeGroupWithProvenance({
    targetGroup: out.defaults,
    incomingGroup: layer.defaults,
    prefix: 'defaults',
    filePath,
    scope,
    overrides,
    keys,
  });
  mergeGroupWithProvenance({
    targetGroup: out.mappings,
    incomingGroup: layer.mappings,
    prefix: 'mappings',
    filePath,
    scope,
    overrides,
    keys,
  });
  return { merged: out, keys };
}

function nonWorkspaceConfigCandidates(workspaceRoot) {
  const useLegacy = !process.env.COSPAN_HOME && !process.env.COSPAN_CONFIG_DIR;
  const legacyXdgPath = useLegacy
    ? path.join(os.homedir(), '.config', 'cospan', 'config.json')
    : null;
  const trajPath = workspaceRoot ? trajectoryConfigFilePath(workspaceRoot) : null;
  return [
    legacyXdgPath ? { scope: 'legacy_global', path: legacyXdgPath } : null,
    { scope: 'global', path: globalConfigFilePath() },
    trajPath ? { scope: 'trajectory', path: trajPath } : null,
  ].filter(Boolean);
}

/**
 * Load effective configuration across:
 * built-in -> legacy global -> global -> trajectory -> workspace -> explicit `--config`.
 */
export function loadEffectiveConfig({
  workspaceRoot = process.cwd(),
  explicitConfigPath = null,
} = {}) {
  let merged = structuredClone(BUILTIN_CONFIG);
  const loadedFiles = [];
  const sources = [];
  const overrides = {};

  const applyLayer = (scope, filePath, data) => {
    const res = mergeConfigLayer(merged, data, { filePath, scope, overrides });
    merged = res.merged;
    loadedFiles.push(filePath);
    sources.push({ scope, path: filePath, keys: res.keys });
  };

  for (const candidate of nonWorkspaceConfigCandidates(workspaceRoot)) {
    const data = readJsonIfExists(candidate.path);
    if (data) applyLayer(candidate.scope, candidate.path, data);
  }

  for (const wsCandidate of workspaceConfigCandidates(workspaceRoot)) {
    const data = readJsonIfExists(wsCandidate);
    if (data) {
      applyLayer('workspace', wsCandidate, data);
      break;
    }
  }

  const explicit = explicitConfigPath || process.env.COSPAN_CONFIG || null;
  if (explicit) {
    const resolved = path.resolve(explicit);
    const data = readJsonIfExists(resolved);
    if (!data) throw new Error(`cannot read or parse config file: ${resolved}`);
    applyLayer('explicit', resolved, data);
  }

  return { config: merged, loadedFiles, sources, overrides };
}

export function resolveEffectivePermissions(
  config,
  targetId,
  { restricted = false, unrestricted = false } = {}
) {
  if (restricted) return 'restricted';
  if (unrestricted) return 'unrestricted';
  const targetPerm = targetId ? config?.defaults?.[targetId]?.permissions : null;
  if (isPermissionMode(targetPerm)) return targetPerm;
  if (isPermissionMode(config?.permissions)) return config.permissions;
  return 'unrestricted';
}

export function ensureDefaultGlobalConfig() {
  const file = globalConfigFilePath();
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  return { path: file, created: true };
}

export function writeConfigTemplate(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, '{}\n');
  return targetFile;
}

function resolvePriorEffortInput(driver, prior) {
  const priorEffortInherit = prior.effort_inherit ?? (driver.id !== 'agy' && prior.effort == null);
  if (priorEffortInherit) return 'inherit';
  return prior.effort || undefined;
}

export function resolveJobModelAndEffort({ driver, model, effort, config, prior = null }) {
  if (!prior) return driver.resolveConfig({ kind: 'send', model, effort, config });
  const hasModel = model !== undefined;
  const hasEffort = effort !== undefined;
  if (hasModel && hasEffort) return driver.resolveConfig({ kind: 'send', model, effort, config });
  if (!hasModel && !hasEffort) {
    return { model: prior.model ?? null, effort: prior.effort ?? null };
  }
  if (hasModel) {
    return driver.resolveConfig({
      kind: 'send',
      model,
      effort: resolvePriorEffortInput(driver, prior),
      config,
    });
  }
  const priorModelInherit = prior.model_inherit ?? prior.model == null;
  if (priorModelInherit) {
    const modelInput = driver.id === 'agy' ? undefined : 'inherit';
    return driver.resolveConfig({ kind: 'send', model: modelInput, effort, config });
  }
  if (driver.id === 'agy') {
    return driver.resolveConfig({ kind: 'send', model: prior.model, effort, config });
  }
  const effortOnly = driver.resolveConfig({ kind: 'send', model: 'inherit', effort, config });
  return { model: prior.model, effort: effortOnly.effort };
}
