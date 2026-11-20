import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cospanHomeDir, realpathNative, workspaceTrajectoryDir } from './config.mjs';
import { sh } from './envelope.mjs';
import { readTextRetry, replaceFile } from './state-lock.mjs';

const WORKTREE_CACHE_TTL_MS = 10000;
const commonDirCache = new Map();
const worktreeListCache = new Map();
const registeredTrajectories = new Map();

function canonicalizeExistingPath(targetPath) {
  const normalized = path.normalize(path.resolve(targetPath));
  try {
    return realpathNative(normalized);
  } catch {
    return normalized;
  }
}

export function gitCommonDir(cwd = process.cwd()) {
  const key = path.resolve(cwd);
  const cached = commonDirCache.get(key);
  if (cached && Date.now() - cached.at < WORKTREE_CACHE_TTL_MS) {
    return cached.value;
  }
  const r = sh('git', ['rev-parse', '--git-common-dir'], { cwd: key });
  const raw = r.code === 0 && r.out ? r.out.trim() : '';
  const value = raw ? canonicalizeExistingPath(path.resolve(key, raw)) : null;
  commonDirCache.set(key, { value, at: Date.now() });
  return value;
}

export function repoIndexFilePath(commonDir) {
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
  return path.join(cospanHomeDir(), 'repo-index', `${hash}.json`);
}

function readRepoIndex(filePath) {
  try {
    const parsed = JSON.parse(readTextRetry(filePath));
    if (parsed && Array.isArray(parsed.trajectories)) return parsed;
  } catch {}
  return { common_git_dir: null, trajectories: [] };
}

export function registerRepoTrajectory(workspaceRoot) {
  if (!workspaceRoot) return null;
  const canonicalRoot = canonicalizeExistingPath(workspaceRoot);
  const trajDir = workspaceTrajectoryDir(canonicalRoot);
  const cachedIndex = registeredTrajectories.get(trajDir);
  if (cachedIndex && fs.existsSync(cachedIndex)) return cachedIndex;

  const commonDir = gitCommonDir(canonicalRoot);
  if (!commonDir) return null;

  const indexFile = repoIndexFilePath(commonDir);
  const existing = readRepoIndex(indexFile);
  const found = existing.trajectories.find(
    (item) => item.trajectory_dir === trajDir && item.workspace_root === canonicalRoot
  );
  if (found) {
    registeredTrajectories.set(trajDir, indexFile);
    return indexFile;
  }

  const nextEntries = existing.trajectories.filter((item) => item.trajectory_dir !== trajDir);
  nextEntries.push({
    workspace_root: canonicalRoot,
    trajectory_dir: trajDir,
    updated_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const tmpFile = `${indexFile}.tmp-${process.pid}`;
  fs.writeFileSync(
    tmpFile,
    JSON.stringify({ common_git_dir: commonDir, trajectories: nextEntries }, null, 2) + '\n'
  );
  replaceFile(tmpFile, indexFile);
  registeredTrajectories.set(trajDir, indexFile);
  return indexFile;
}

function parseWorktreePorcelain(stdout) {
  const roots = [];
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      const wtPath = line.slice('worktree '.length).trim();
      if (wtPath) roots.push(canonicalizeExistingPath(wtPath));
    }
  }
  return roots;
}

export function listRepoWorktreeRoots(cwd, commonDir) {
  const cacheKey = commonDir || path.resolve(cwd);
  const cached = worktreeListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WORKTREE_CACHE_TTL_MS) {
    return cached.roots;
  }
  const r = sh('git', ['worktree', 'list', '--porcelain'], { cwd });
  const roots = r.code === 0 ? parseWorktreePorcelain(r.out) : [];
  worktreeListCache.set(cacheKey, { roots, at: Date.now() });
  return roots;
}

export function clearRepoFamilyCaches() {
  commonDirCache.clear();
  worktreeListCache.clear();
  registeredTrajectories.clear();
}

export function resolveFamilyTrajectories(workspaceRoot) {
  const primaryRoot = canonicalizeExistingPath(workspaceRoot);
  const primaryTrajDir = workspaceTrajectoryDir(primaryRoot);
  const primaryEntry = {
    workspace_root: primaryRoot,
    trajectory_dir: primaryTrajDir,
    is_primary: true,
    worktree_name: null,
  };

  const commonDir = gitCommonDir(primaryRoot);
  if (!commonDir) return [primaryEntry];

  const byTrajDir = new Map([[primaryTrajDir, primaryEntry]]);
  const addSibling = (wtRoot, trajDir) => {
    if (!trajDir || byTrajDir.has(trajDir)) return;
    byTrajDir.set(trajDir, {
      workspace_root: wtRoot,
      trajectory_dir: trajDir,
      is_primary: false,
      worktree_name: path.basename(wtRoot) || wtRoot,
    });
  };

  for (const wtRoot of listRepoWorktreeRoots(primaryRoot, commonDir)) {
    addSibling(wtRoot, workspaceTrajectoryDir(wtRoot));
  }

  const indexed = readRepoIndex(repoIndexFilePath(commonDir));
  for (const item of indexed.trajectories) {
    if (item && item.trajectory_dir && item.workspace_root) {
      addSibling(item.workspace_root, item.trajectory_dir);
    }
  }

  return [...byTrajDir.values()];
}
