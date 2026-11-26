import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_DIR, TESTS_DIR } from './helpers/paths.mjs';

const VALUE_FLAGS = new Set([
  '--test-concurrency',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-timeout',
]);

function collectTestFiles(entryPath, out) {
  const stat = fs.statSync(entryPath);
  if (stat.isFile()) {
    if (entryPath.endsWith('.test.mjs')) out.push(entryPath);
    return;
  }
  const entries = fs.readdirSync(entryPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(entryPath, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full);
  }
}

function resolveTarget(raw) {
  const direct = path.resolve(ROOT_DIR, raw);
  if (fs.existsSync(direct)) return direct;
  const underTests = path.resolve(TESTS_DIR, raw);
  if (fs.existsSync(underTests)) return underTests;
  console.error(`Test target not found: ${raw}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = [];
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      flags.push(arg);
      if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) flags.push(argv[++i]);
    } else {
      targets.push(resolveTarget(arg));
    }
  }
  return { flags, targets };
}

const { flags, targets } = parseArgs(process.argv.slice(2));
const roots = targets.length > 0 ? targets : [TESTS_DIR];
const files = [];
for (const root of roots) collectTestFiles(root, files);
const uniqueFiles = [...new Set(files)];

if (uniqueFiles.length === 0) {
  console.error('No *.test.mjs files matched.');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...flags, ...uniqueFiles], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
