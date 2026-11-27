# AGENTS.md

> `CLAUDE.md` is a symlink to this file so all coding-agent harnesses share one entry.

## Engineering & Modularity Invariants

1. **Pure ESM & Zero Runtime Dependencies**: Target Node `>=20` using `.mjs` modules only, `node:` prefixes for built-ins, and explicit `.mjs` extensions on relative imports. **Never add runtime `dependencies`**; tooling belongs strictly in `devDependencies` and must not enter `package.json` `"files"`.
2. **Thin Entrypoints (`src/cli.mjs`, `src/mcp/cospan-mcp.mjs`)**: Keep entry files strictly to argument/RPC dispatch and public re-exports—never accumulate state persistence, worker execution, diagnostics, or subcommand bodies inside a single file.
3. **Module Responsibilities**:
   - `src/cli-args.mjs` (flags/prompts/help), `src/job-store.mjs` (state & trajectories), `src/job-diagnostics.mjs` (bounded `observe` & recovery), `src/job-worker.mjs` (detached launch & `_worker`), `src/commands/{dispatch,lifecycle,admin}.mjs` (CLI subcommands).
   - `src/config.mjs` & `src/targets.mjs` (layered config & binary discovery), `src/contract-check.mjs` (zero-token `--help` CLI contract verification), `src/process-tree.mjs` & `src/stream-worker.mjs` (descendant PID tracking & NDJSON streaming), `src/installer-templates.mjs` & `src/installer.mjs` (host bundles), `src/drivers/{agy,codex,claude,dsh}.mjs` (target harnesses), `src/mcp/{cospan-mcp,tools}.mjs` (stdio MCP), `src/sidebar-state.mjs`, `src/sidecar/*`, `src/ui/*`, `dsh/*` (host sidebars).
4. **Hard Anti-Bloat Gates**: Every `.mjs` module must stay `<= 600` effective lines (`max-lines`), functions `<= 120` lines (`max-lines-per-function`), nesting `<= 4` (`max-depth`), cyclomatic complexity `<= 20` (`complexity`), with zero circular imports (`import-x/no-cycle`).
5. **Contract Stability**: Preserve CLI flags, job exit codes (`0/2/3/4/5`), `<= 8 KiB` bounded `observe` JSON, out-of-tree `~/.cospan/trajectories/` storage, public exports (`durationToMs`, `repoRoot`, `workspaceStateDir`, `parseCliArgs`, `JOB_EXIT_CODES`, `main`), and stdio MCP behavior.

## Scenario Routing

Load only the guide for the phase you are in:

| When you are…                                                             | Read                                                                                                                          |
| :------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| Setting up, running change-surface checks, labeling, or cutting a release | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                                                          |
| Trimming diff bloat before review or planning architectural cleanup       | [`SIMPLIFY.md`](SIMPLIFY.md)                                                                                                  |
| Reviewing a PR (risk depth, core lenses, findings & convergence)          | [`REVIEW.md`](REVIEW.md)                                                                                                      |
| Filing an issue or writing a human-first PR description                   | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) & [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Base Verification Gate

Run `npm run lint`, `npm run format:check`, and `npm test` before finishing any change (plus `node bin/cospan.mjs install` whenever installer/skill templates or `src/mcp/` change, and `npm run sync:ui` whenever `src/ui/` or `dsh/client-bridge.js` changes).
