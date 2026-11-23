# Contributing to Cospan

Cospan is designed to be developed and verified cleanly by **both human contributors and coding agents**. This guide defines the concrete engineering rules, offline test setup, and verification matrix required before opening a pull request.

> **For coding agents:** Read [`AGENTS.md`](AGENTS.md) and this file before editing code. Follow the [Verification Matrix](#verification-matrix-for-agents--humans) for every surface you touch, and report actual observed outputs—never fabricated checkmarks—in the pull request body.

---

## 1. Local Setup

- **Runtime:** Node.js `>= 20` (Pure ESM `.mjs`, zero runtime `dependencies`).
- **Install dev tooling (linting & formatting only):**

```bash
npm ci
```

- **Run the baseline gate:**

```bash
npm run lint
npm run format:check
npm test
```

All tests in `npm test` run **100% offline with zero token burn** using deterministic fake CLI harnesses in [`tests/fakes/`](tests/fakes/). You do not need live subscriptions or API keys to develop and test most changes.

---

## 2. Hard Engineering Rules

These rules are enforced by ESLint ([`eslint.config.mjs`](eslint.config.mjs)) and tests:

1. **Pure ESM & Zero Runtime Dependencies:** Target Node `>= 20` with `.mjs` modules, `node:` specifiers for built-ins, and explicit `.mjs` extensions on relative imports. Never add `"dependencies"` to `package.json` or leak dev tooling into `package.json` `"files"`.
2. **Thin Entrypoints & Modularity Gates:** Keep `src/cli.mjs` and `src/mcp/cospan-mcp.mjs` to dispatch/re-exports only. Every `.mjs` file must stay `<= 350` effective lines, functions `<= 80` lines (`<= 120` in tests), max nesting `<= 4`, cyclomatic complexity `<= 15`, line width `<= 100`, with zero circular imports (`import-x/no-cycle`).
3. **Contract Stability:** Preserve existing CLI flags, job exit codes (`0` done / `2` running / `3` error / `4` canceled / `5` attention), `<= 8 KiB` bounded `observe` JSON, out-of-tree `~/.cospan/trajectories/` state storage, public exports (`durationToMs`, `repoRoot`, `workspaceStateDir`, `parseCliArgs`, `JOB_EXIT_CODES`, `main`), and stdio MCP behavior.
4. **Cross-Platform Process Safety:** Every `spawn` / `spawnSync` call in `src/**/*.mjs` must pass `windowsHide: true` (asserted in [`tests/windows-process.test.mjs`](tests/windows-process.test.mjs)). Route external binary launches through `buildSpawnCommand()` in `src/targets.mjs` so `.cmd` / `.bat` shims unwrap safely on Windows, and keep parsers CRLF-safe.
5. **Verbatim Model Shortcut Contract:** Host skill templates (`agy`, `codex`, `claude`, `dsh`) must list shortcuts verbatim and never hardcode ephemeral full model version strings that go stale—let `src/config.mjs` and driver resolvers map shortcuts deterministically at runtime.

---

## 3. Verification Matrix (For Agents & Humans)

Run the **Base Gate** on every PR, plus every row that matches the files you modified:

| Changed Surface                                                                                                                                                                     | Required Verification & Evidence                                                                                                                                                                                         |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Base Gate (every change)**                                                                                                                                                        | `npm run lint`, `npm run format:check`, and `npm test` must all pass with 0 failures.                                                                                                                                    |
| **Drivers, model mappings, or binary discovery**<br>(`src/drivers/*`, `src/targets.mjs`, `src/config.mjs`, `src/contract-check.mjs`)                                                | Base Gate + unit tests in `tests/drivers*.test.mjs` + run `node bin/cospan.mjs doctor --check` (zero-token `--help` flag contract verification against locally installed CLIs).                                          |
| **Installer, skills, or stdio MCP**<br>(`src/installer*.mjs`, `src/mcp/*`, `skills/*`, `.mcp.json`)                                                                                 | Base Gate + run `node bin/cospan.mjs install` (regenerates deterministic bundles) + re-run `npm run format:check` and `tests/mcp-install.test.mjs`.                                                                      |
| **Sidebar UI or DSH client bundle**<br>(`src/ui/*`, `src/sidebar-state.mjs`, `src/sidecar/*`, `dsh/*`)                                                                              | Base Gate + `npm run sync:ui` (or `node bin/cospan.mjs install`) so `dsh/client.js` stays in sync with `src/ui/` + `tests/sidebar-ui.test.mjs`. Note visual verification in PR when modifying CSS/layout.                |
| **Process tree, state locking, workers, or Windows shims**<br>(`src/process-tree.mjs`, `src/state-lock.mjs`, `src/job-worker.mjs`, `src/commands/lifecycle.mjs`, `src/targets.mjs`) | Base Gate + verify `tests/state-lock.test.mjs` & `tests/windows-*.test.mjs` invariants. Explicitly flag in the PR body that the manually gated `test-windows` CI job (`windows-latest`) should be approved before merge. |
| **CLI flags, subcommands, or help text**<br>(`src/cli*.mjs`, `src/commands/*`)                                                                                                      | Base Gate + update `printHelp()` in `src/cli-args.mjs`, expose/update `src/mcp/tools.mjs` if applicable, and cover with tests in `tests/runtime*.test.mjs`.                                                              |

### Offline Fake vs. Live CLI Testing Policy

- **Never burn paid tokens in `npm test`:** Always write deterministic tests against `tests/fakes/fake-{agy,codex,claude,dsh}.mjs` by overriding `AGY_BIN`, `CODEX_BIN`, `CLAUDE_BIN`, `DSH_BIN` and pointing `COSPAN_HOME` / `COSPAN_CONFIG_DIR` to a temp directory.
- **Verify real upstream CLI flags before changing drivers:** Never guess or invent upstream CLI flags from memory. Inspect the real binary's `--help` output first (for example, `codex exec resume` rejects `-C` and `-s`), update [`src/contract-check.mjs`](src/contract-check.mjs), and mirror real flag asymmetries in `tests/fakes/`.
- **Avoid temp-dir teardown flakes:** Always `wait` or `cancel` any background jobs spawned during a test before calling `fs.rmSync()` on temp directories so Windows file handles are released cleanly.
- **Live smoke tests are opt-in:** Only run `cospan doctor --ping` or live delegation smoke checks when validating real upstream CLI behavior; report live smoke output separately in the PR description.

---

## 4. Issues & Pull Request Workflow

### Opening an Issue

Use the matching template in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/):

- **Bug Report** (`bug`): unexpected behavior, crashes, cross-platform or worktree bugs. Include `cospan doctor --check --json` output when relevant.
- **Feature Request / RFC** (`feature`): new capabilities, CLI/MCP ergonomics, or protocol improvements.
- **New Harness or Model Support** (`feature`, `drivers`): adding a new target coding agent CLI or model/effort mapping.

### Submitting a Pull Request

1. Branch from `master` using a descriptive prefix (`feat/...`, `fix/...`, `chore/...`, `docs/...`). Never commit directly to `master`.
2. Keep each PR focused on one logical change and use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`).
3. Fill out [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) for **human comprehension, not diff narration**:
   - Start with a plain-language **TL;DR** and a small **Before → After** CUJ example so a reviewer understands the user-visible impact in 10 seconds.
   - **Never narrate the diff** (no file-by-file summaries or internal function lists)—agents and reviewers inspect the git diff for implementation details; keep the PR body strictly to incremental value (intent, examples, non-obvious trade-offs/boundaries, linked issues, and verification).
   - Link related issues (`Fixes #N` / `Closes #N` / `Relates to #N`) and paste **actual observed verification results** (commands run, test pass/skip counts, and any manual/real-OS checks).
4. **Apply GitHub labels (`--label`) on every PR and issue:** pick one **Type** label (`bug`, `feature`, `docs`, `chore`, or `tracking`) plus every affected **Area** label (`core`, `drivers`, `hosts`)—for example, `bug,core` for a CLI runtime fix, `chore,docs` for template/doc updates, or `chore` + all affected areas for a release PR.
5. Never commit local trajectory artifacts (`~/.cospan/`), `.env` files, or unrelated scratch directories.

---

## 5. Release Checklist

Follow this deterministic checklist when cutting a `vX.Y.Z` release (see [`docs/releases/README.md`](docs/releases/README.md) for header-image and upgrade-block conventions):

1. **Sync & branch:** Fast-forward `master` to `origin/master` and create `chore/release-vX.Y.Z`.
2. **Bump version across all 8 locations** (enforced by `tests/update-check.test.mjs`):
   - `package.json` and `package-lock.json` (both top-level `"version"` and `packages[""].version`)
   - `.antigravity-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `dsh/package.json`
   - Runtime version fallback literals in `src/mcp/cospan-mcp.mjs` and `src/update-check.mjs`
3. **Header illustration & release notes:**
   - Generate `releases/assets/cospan-X.Y.Z-overview.png` (`3:2` Pixel Blueprint, layout matched to release scope) via `cospan-codex` (`--effort low`), visually inspect the saved PNG for text and layout accuracy, and record the prompt metadata in `releases/assets/prompt.json`.
   - Create `docs/releases/vX.Y.Z.md` (header image + `cospan-codex` attribution, `## Highlights`, `### What's New`, `## Validation`, and agent-first `## Upgrade` pinned to `vX.Y.Z`) and prepend the release to `docs/releases/README.md`.
4. **Verify & open the Release PR:**
   - Run `node bin/cospan.mjs install` (plus `npm run sync:ui` if UI assets changed), `npm run lint`, `npm run format:check`, `npm test`, and `node bin/cospan.mjs doctor --check`.
   - Open `chore(release): cospan vX.Y.Z — <headline>` with labels `chore` + affected areas (`core`, `drivers`, `hosts`). Approve gated `Tests (Windows)` CI before merging whenever the release includes runtime, lifecycle, locking, or OS-path changes.
5. **Tag & publish GitHub Release (after merge):**
   - Squash-merge the release PR, fast-forward `master`, and push an annotated tag:
     `git tag -a vX.Y.Z -m "cospan vX.Y.Z" && git push origin vX.Y.Z`
   - Publish the GitHub Release via `gh release create vX.Y.Z --title "cospan vX.Y.Z — <headline>" ...`, rewriting the relative header image link to `https://raw.githubusercontent.com/keli-wen/cospan/vX.Y.Z/releases/assets/cospan-X.Y.Z-overview.png` so it renders on GitHub's Releases page.
