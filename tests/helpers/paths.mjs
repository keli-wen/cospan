import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const TESTS_DIR = path.resolve(HELPERS_DIR, '..');
export const ROOT_DIR = path.resolve(TESTS_DIR, '..');
export const SRC_DIR = path.join(ROOT_DIR, 'src');
export const COSPAN_BIN = path.join(ROOT_DIR, 'bin', 'cospan.mjs');
export const MCP_SERVER = path.join(ROOT_DIR, 'src', 'mcp', 'cospan-mcp.mjs');
export const FAKE_FILES = {
  agy: path.join(TESTS_DIR, 'fakes', 'fake-agy.mjs'),
  codex: path.join(TESTS_DIR, 'fakes', 'fake-codex.mjs'),
  claude: path.join(TESTS_DIR, 'fakes', 'fake-claude.mjs'),
  dsh: path.join(TESTS_DIR, 'fakes', 'fake-dsh.mjs'),
  grok: path.join(TESTS_DIR, 'fakes', 'fake-grok.mjs'),
};
