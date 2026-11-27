import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cospanHomeDir, targetsFilePath } from './config.mjs';

export {
  BUILTIN_CONFIG,
  TARGET_MODEL_SHORTCUTS,
  cospanHomeDir,
  configDir,
  targetsFilePath,
  globalConfigFilePath,
  workspaceTrajectoryDir,
  trajectoryConfigFilePath,
  workspaceConfigCandidates,
  loadEffectiveConfig,
  resolveEffectivePermissions,
  ensureDefaultGlobalConfig,
  resolveJobModelAndEffort,
  writeConfigTemplate,
} from './config.mjs';

export function loadPinnedTargets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(targetsFilePath(), 'utf8'));
    return parsed?.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
  } catch {
    return {};
  }
}

export function savePinnedTargets(targets) {
  const dir = cospanHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    updated_at: new Date().toISOString(),
    targets,
  };
  fs.writeFileSync(targetsFilePath(), JSON.stringify(payload, null, 2) + '\n');
  return targetsFilePath();
}

const CANDIDATE_SPECS = {
  agy: {
    envVar: 'AGY_BIN',
    binName: 'agy',
    phase: 1,
    winProgramSubpath: ['Antigravity', 'bin', 'agy'],
    posixFallbacks: (home) => [
      path.join(home, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    ],
  },
  codex: {
    envVar: 'CODEX_BIN',
    binName: 'codex',
    phase: 1,
    winProgramSubpath: ['Codex', 'bin', 'codex'],
    posixFallbacks: (home) => [
      '/opt/homebrew/bin/codex',
      path.join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ],
  },
  claude: {
    envVar: 'CLAUDE_BIN',
    binName: 'claude',
    phase: 1,
    winProgramSubpath: ['claude', 'bin', 'claude'],
    posixFallbacks: (home) => [
      '/opt/homebrew/bin/claude',
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
    ],
  },
  dsh: {
    envVar: 'DSH_BIN',
    binName: 'dsh',
    phase: 1,
    winProgramSubpath: ['DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'],
    posixFallbacks: (home) => [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(home, '.local', 'bin', 'dsh'),
      '/opt/homebrew/bin/dsh',
    ],
  },
  grok: {
    envVar: 'GROK_BIN',
    binName: 'grok',
    phase: 1,
    winProgramSubpath: ['Grok', 'bin', 'grok'],
    winFallbacks: (home) => [path.join(home, '.grok', 'bin', 'grok')],
    posixFallbacks: (home) => [
      path.join(home, '.grok', 'bin', 'grok'),
      path.join(home, '.local', 'bin', 'grok'),
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
    ],
  },
};

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (/\.(mjs|cjs|js)$/i.test(filePath)) return true;
    if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWithExts(stem, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const ext of exts) {
    const full = stem + ext;
    if (isExecutableFile(full)) return full;
  }
  return null;
}

function whichBinary(binName) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"|"$/g, '');
    const found = resolveWithExts(path.join(dir, binName));
    if (found) return found;
  }
  return null;
}

function fallbackCandidates(spec, platform = process.platform) {
  const home = platform === 'win32' ? process.env.USERPROFILE || os.homedir() : os.homedir();
  if (platform !== 'win32') return spec.posixFallbacks(home);
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    ...(spec.winFallbacks ? spec.winFallbacks(home) : []),
    path.join(appData, 'npm', spec.binName),
    path.join(home, '.local', 'bin', spec.binName),
    path.join(localAppData, 'Programs', ...spec.winProgramSubpath),
  ];
}

export function resolveTargetBinary(targetId) {
  const spec = CANDIDATE_SPECS[targetId];
  if (!spec) return null;

  const fromEnv = process.env[spec.envVar];
  if (fromEnv) return fromEnv;

  const pinned = loadPinnedTargets()[targetId]?.binary;
  if (pinned && isExecutableFile(pinned)) return pinned;

  const fromPath = whichBinary(spec.binName);
  if (fromPath) return fromPath;

  for (const stem of fallbackCandidates(spec)) {
    const found = resolveWithExts(stem);
    if (found) return found;
  }
  return null;
}

function unwrapNodeCmdShim(binary) {
  let fd;
  try {
    fd = fs.openSync(binary, 'r');
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    if (!/node|%_prog%/i.test(text)) return null;
    const match = /%(?:~)?dp0%[\\/]*([^"%*\r\n]+?\.(?:mjs|cjs|js))"?\s+%\*/i.exec(text);
    if (!match) return null;
    const rel = match[1].replaceAll('\\', '/').replace(/^\/+/, '');
    const scriptPath = path.resolve(path.dirname(binary), rel);
    return fs.existsSync(scriptPath) ? scriptPath : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function quoteCmdArg(value) {
  const str = String(value);
  if (str.length === 0) return '""';
  if (!/[\s"&|<>()^%!;,=]/.test(str)) return str;
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped.replaceAll('%', '"^%"')}"`;
}

export function buildSpawnCommand(binary, args, platform = process.platform) {
  if (/\.(mjs|cjs|js)$/i.test(binary)) {
    return { cmd: process.execPath, args: [binary, ...args], windowsVerbatimArguments: false };
  }
  if (/\.(cmd|bat)$/i.test(binary)) {
    const unwrapped = unwrapNodeCmdShim(binary);
    if (unwrapped) {
      return {
        cmd: process.execPath,
        args: [unwrapped, ...args],
        windowsVerbatimArguments: false,
      };
    }
    if (platform === 'win32') {
      const cmdLine = [binary, ...args].map(quoteCmdArg).join(' ');
      return {
        cmd: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${cmdLine}"`],
        windowsVerbatimArguments: true,
      };
    }
  }
  return { cmd: binary, args, windowsVerbatimArguments: false };
}

export function probeTargetVersion(binary) {
  if (!binary) return null;
  try {
    const spawnCmd = buildSpawnCommand(binary, ['--version']);
    const r = spawnSync(spawnCmd.cmd, spawnCmd.args, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spawnCmd.windowsVerbatimArguments),
    });
    if (r.error || r.status !== 0) return null;
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return text.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function discoverAllTargets() {
  const result = {};
  for (const [id, spec] of Object.entries(CANDIDATE_SPECS)) {
    const binary = resolveTargetBinary(id);
    const installed = !!binary && isExecutableFile(binary);
    result[id] = {
      id,
      phase: spec.phase,
      driverReady: spec.phase === 1,
      installed,
      binary: installed ? binary : null,
      version: installed ? probeTargetVersion(binary) : null,
    };
  }
  return result;
}
