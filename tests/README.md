# Verification & Test Guide (`tests/README.md`)

Single source of truth for Cospan's offline test suite, shared fixtures, verification tiers, and known blind spots. For setup, change-surface checks, and releases, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## 1. Running Tests

[`tests/run.mjs`](run.mjs) discovers every `*.test.mjs` recursively across Node `>= 20` with zero runtime dependencies and zero token burn:

```bash
npm test                                    # full offline suite
npm test -- hosts                           # one domain directory
npm test -- hosts/sidebar-ui.test.mjs       # one test file
node tests/run.mjs --test-timeout=60000     # pass node --test flags directly
```

## 2. Domain Layout & Placement

Keep `tests/` root limited to `run.mjs` and this README. Append new regression cases to the matching domain file instead of creating per-PR or per-round files:

| Directory        | Owns                                                                                                                                     |
| :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/drivers/` | Target harness drivers (`agy`, `codex`, `claude`, `dsh`), flag mapping, error propagation, model/effort resolution                       |
| `tests/hosts/`   | Host bundles & sidebars (`dsh/index.mjs`, `dsh/client.js`, Antigravity sidecar, `cospan-board.js` polling, installer, MCP, version sync) |
| `tests/runtime/` | CLI commands, detached workers, job store, `wait` / `observe` / `cancel`, `repo-family`, `state-lock`                                    |
| `tests/windows/` | Windows `.cmd` shim unwrapping, `windowsHide: true` invariants, Windows process/runtime behavior                                         |

## 3. Shared Helpers & Deterministic Fakes

Reuse existing helpers and fakes before writing new harnesses:

- [`tests/helpers/paths.mjs`](helpers/paths.mjs): canonical `ROOT_DIR`, `SRC_DIR`, `TESTS_DIR`, `COSPAN_BIN`, `MCP_SERVER`, and `FAKE_FILES` (`agy`, `codex`, `claude`, `dsh`).
- [`tests/helpers/sidebar.mjs`](helpers/sidebar.mjs): `withTempWorkspaces`, `withTempWorkspace`, `runCospanInHome`, and `loadDshClientModule` (`window.__ModuleLoader__` + minimal React stub).
- [`tests/helpers/windows.mjs`](helpers/windows.mjs): `WIN_ONLY`, `rmTree`, `buildChildEnv`, `makeTempGitRepo`, `createCmdShimFixture`, `runCospan`, and `spawnTracked`.
- [`tests/fakes/`](fakes/): deterministic fake target CLIs (`fake-{agy,codex,claude,dsh}.mjs`) mirroring real upstream flag/NDJSON contracts.

## 4. Verification Tiers, Cost & Blind Spots

| Check                                             | Cost / Isolation                       | Proves                                                                                                      | Known Blind Spots                                                                                 |
| :------------------------------------------------ | :------------------------------------- | :---------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| `npm run lint` & `npm run format:check`           | ~2s, static                            | ESM imports, Prettier, modularity caps (`<= 600` lines, `<= 120` lines/fn, `<= 20` complexity, zero cycles) | No runtime behavior                                                                               |
| `npm test`                                        | Seconds, 100% offline, 0 tokens        | CLI/MCP contracts, workers, locks, drivers, host sidebars against deterministic fakes                       | Real upstream CLI flags, real Electron/DSH/browser rendering, Windows-only handle locking on Unix |
| `node bin/cospan.mjs doctor --check`              | Seconds, 0 tokens, local CLIs          | Real installed CLI `--help` flag contracts (`src/contract-check.mjs`)                                       | Skips CLIs not installed locally; no live model inference                                         |
| `npm run sync:ui` / `node bin/cospan.mjs install` | Seconds, deterministic local codegen   | `dsh/client.js`, `skills/*`, and host manifests stay in sync with sources                                   | Does not load bundles inside live host UI                                                         |
| `Tests (Windows)` CI (`windows-latest`)           | Manually gated CI env                  | `.cmd` shims, `windowsHide`, file-handle release, Windows lock retries                                      | Must be explicitly approved on PRs touching processes, locks, or OS paths                         |
| Live smoke (`doctor --ping` / live host UI)       | Opt-in, burns tokens / needs live host | End-to-end upstream CLI or host UI behavior                                                                 | Never run in `npm test`; report observed output separately in the PR body                         |

## 5. Repo-Specific Test Rules

1. **Zero token burn & strict isolation:** Always point `COSPAN_HOME` and `COSPAN_CONFIG_DIR` to a temp directory and override `{AGY,CODEX,CLAUDE,DSH}_BIN` with `FAKE_FILES` so tests never touch `~/.cospan/` or call real CLIs.
2. **Release background handles before teardown:** Always `wait` or `cancel` spawned background jobs before calling `fs.rmSync(..., { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })` to avoid Windows `EPERM` flakes.
3. **Mirror real upstream CLI flags:** Inspect the real binary's `--help` output first, update [`src/contract-check.mjs`](../src/contract-check.mjs), and reflect real flag asymmetries (e.g., `codex exec resume` rejecting `-C`/`-s`) in `tests/fakes/`.
