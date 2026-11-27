# Installing & Upgrading Cospan — A Guide for Coding Agents

You are a coding agent asked to install, upgrade, or verify **Cospan**. Follow this guide top to bottom. When you finish (or get blocked), report the outcome to the user **in the user's own language** — the language they have been using with you, not necessarily English.

> [!IMPORTANT]
> If you reached this file through a URL, read its **raw** text — `curl -fsSL https://raw.githubusercontent.com/keli-wen/cospan/master/docs/INSTALL_FOR_AGENTS.md` — or clone the repo. Fetching a rendered HTML page through a web-summarizing tool can paraphrase commands and break installation.

## 0. Prerequisites

1. **Node.js `>= 20` and `git`** — verify `node --version` and `git --version`. Cospan uses pure ESM with zero runtime dependencies.
2. **Target harness CLIs (`agy`, `claude`, `codex`, `dsh`, `grok`)** — check which CLIs are installed and authenticated on this machine (`command -v agy claude codex dsh grok` on macOS/Linux, or `Get-Command agy, claude, codex, dsh, grok` in PowerShell). Cospan only needs the host you run in plus whichever peer harnesses the user wants to delegate to.
   - **Never install or authenticate missing target CLIs yourself.** If a target CLI the user wants is missing or unauthenticated, tell them how to install/sign in to that CLI and let them handle it.

## 1. Detect Which Host Harness You Are Running In

Follow the section matching the host harness you are currently running inside (or the host(s) the user asked you to set up):

- **Antigravity (`agy`)** — you use `/cospan-*` skills, `run_command`, and plugins under `~/.gemini/config/plugins/` → **Section 2a**
- **Claude Code (`claude`)** — you use `/cospan:*` skills, `CLAUDE.md`, and `claude plugin` → **Section 2b**
- **OpenAI Codex (`codex`)** — you use `$cospan:*` skills, `AGENTS.md`, and `codex plugin` → **Section 2c**
- **DeepSeek Harness (`dsh`)** — you run inside DeepSeek Harness (Desktop or Web), have `plugin_manager` or `dsh plugin`, and invoke `/cospan-*` skills → **Section 2d**

## 2a. Antigravity (`agy`) — Install / Upgrade

**Install** (or point `COSPAN_REPO` to a user-provided local checkout path):

- macOS / Linux (bash/zsh):

  ```bash
  git clone https://github.com/keli-wen/cospan.git ~/.cospan/repo
  node ~/.cospan/repo/bin/cospan.mjs install --host agy
  ```

- Windows (PowerShell):

  ```powershell
  git clone https://github.com/keli-wen/cospan.git "$HOME\.cospan\repo"
  node "$HOME\.cospan\repo\bin\cospan.mjs" install --host agy
  ```

`install --host agy` detects installed peer CLIs (`agy`, `codex`, `claude`, `dsh`, `grok`), writes `~/.gemini/config/plugins/cospan/` (skills `cospan-<target>` + `cospan-jobs` + sidecar `cospan_board`), and initializes `~/.cospan/config.json` and `~/.cospan/targets.json`. Pass `--force` if the user wants skills mounted even for targets not yet installed.

**Upgrade** an existing `~/.cospan/repo` install:

```bash
git -C ~/.cospan/repo pull --ff-only
node ~/.cospan/repo/bin/cospan.mjs install --host agy
```

_(On Windows PowerShell, replace `~/.cospan/repo` with `"$HOME\.cospan\repo"`.)_

Tell the user to **reload/restart Antigravity** if skills or the `Cospan` sidebar panel do not appear immediately.

## 2b. Claude Code (`claude`) — Install / Upgrade

Use the `claude` CLI (humans can type `/plugin ...` in the TUI; from shell tools, run `claude plugin ...`):

**Install** (use a local path instead of `keli-wen/cospan` if the user supplied a local checkout):

```bash
claude plugin marketplace add keli-wen/cospan
claude plugin install cospan@cospan
```

**Upgrade** an existing install:

```bash
claude plugin marketplace update cospan
claude plugin update cospan@cospan
```

> [!IMPORTANT]
> `claude plugin install` does not upgrade an already-installed plugin, and `claude plugin update` skips updating if `version` in `.claude-plugin/plugin.json` has not bumped. If the marketplace git commit moved without a version bump (check `gitCommitSha` in `~/.claude/plugins/installed_plugins.json` against `git -C ~/.claude/plugins/marketplaces/cospan log -1`), refresh explicitly:
>
> ```bash
> claude plugin uninstall cospan@cospan && claude plugin install cospan@cospan
> ```

Verify with `claude plugin list` that `cospan@cospan` is enabled. **A Claude Code restart is required** before `/cospan:*` skills and the `cospan` MCP server load into the active session.

## 2c. OpenAI Codex (`codex`) — Install / Upgrade

**Install** (or pass a local checkout path if the user supplied one):

```bash
codex plugin marketplace add https://github.com/keli-wen/cospan
codex plugin add cospan@cospan
```

**Upgrade** an existing install:

```bash
codex plugin marketplace upgrade
codex plugin add cospan@cospan
```

**Restart Codex** afterwards — Codex caches plugins per version directory.

> [!NOTE]
> Once loaded, always prefer the bundled **`cospan_*` MCP tools** (`cospan_send`, `cospan_wait`, `cospan_continue`, `cospan_observe`, `cospan_ask`, `cospan_cancel`) over raw shell fallback calls, because the MCP server runs outside Codex's command sandbox where peer CLIs need network/keychain/local socket access.

## 2d. DeepSeek Harness (`dsh`) — Install / Upgrade

Requires `pnpm` on `PATH` when installing via CLI.

- If you have the native `plugin_manager` tool in your session:

  ```json
  {
    "action": "install_bundle",
    "target": "github:keli-wen/cospan",
    "enabled": true
  }
  ```

- Or from the terminal (`--profile desktop` for the Desktop app, `--profile web` for Web):

  ```bash
  dsh plugin --profile desktop add github:keli-wen/cospan
  ```

  _(For a local checkout during development, pass `/absolute/path/to/cospan` instead of `github:keli-wen/cospan`.)_

**Upgrade** to a newer tag or commit ref:

```bash
dsh plugin --profile desktop add 'github:keli-wen/cospan#<tag-or-commit>'
```

Once enabled, the Cordis bundle (`dsh/index.mjs` + `dsh/client.js`) registers `/cospan-*` skills, native `cospan_*` tools, `/cospan-ctl`, and the right-sidebar task panel.

## 3. Verification & Optional Smoke Test

1. **Zero-token CLI & contract verification (run this automatically):**
   Locate the installed `cospan` root (`~/.cospan/repo` for `agy`; `installPath` from `~/.claude/plugins/installed_plugins.json` for `claude`; `codex plugin list` path for `codex`) and run:

   ```bash
   node "<cospan-root>/bin/cospan.mjs" doctor --check
   ```

   This probes installed peer binaries and verifies `--help` CLI flag contracts without spending any model tokens.
   - If a peer CLI shows `NOT FOUND` even though it is installed in a non-standard path, tell the user they can set `AGY_BIN` / `CODEX_BIN` / `CLAUDE_BIN` / `DSH_BIN` / `GROK_BIN` or pin binaries via `cospan install`.

2. **Optional live smoke test (ask the user before spending model quota):**
   After restarting the host harness (or invoking `cospan` directly), ask the user if they want to run a quick zero-tool check on a target of their choice:
   - Via skill/MCP: e.g. `/cospan-codex` / `/cospan:codex` / `$cospan:codex` asking `"reply with OK"` (calls `cospan_ask`), or
   - Via CLI: `node "<cospan-root>/bin/cospan.mjs" doctor --ping` (pings every installed target).

## 4. Config & Execution Model Notes

- **Permissions**: Tool-using `send` runs `unrestricted` by default so builds, tests, and local sockets do not stall. Pass `--readonly` (or `readonly: true`) for inspection/review, and `--restricted` (or `"permissions": "restricted"` in `config.json`) when OS sandboxing is wanted.
- **Layered config**: Effective settings merge built-ins → `~/.cospan/config.json` → `~/.cospan/trajectories/<repo-hash>/config.json` → `<workspace>/.cospan/config.json`. Run `cospan config` to inspect active defaults and override provenance, or `cospan config --init --global` to create a starter override file.
- **Out-of-tree state**: Job logs, diffs, and trajectories live under `~/.cospan/trajectories/` so the target repository's `git status` stays clean.

## 5. Report Back

Summarize cleanly in the user's language:

1. Whether install/upgrade succeeded (and from GitHub or a local checkout).
2. The `doctor --check` inventory (which of `agy`, `codex`, `claude`, `dsh`, `grok` are `READY` vs `NOT FOUND`).
3. Whether the user needs to **restart/reload** their host client before using `/cospan-*` / `/cospan:*` / `$cospan:*`.
4. Offer the optional live smoke test if not already run.
