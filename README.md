<p align="center"><img src="assets/logo/cospan.svg" width="330" alt="COSPAN"></p>

<p align="center"><a href="README.md">English</a> | <a href="README.zh-CN.md">Simplified Chinese</a></p>

<p align="center">
  <a href="https://antigravity.google/product/antigravity-cli"><img src="assets/badges/antigravity-plugin.svg" height="20" alt="Antigravity: plugin"></a> <a href="https://developers.openai.com/codex/"><img src="assets/badges/codex-plugin.svg" height="20" alt="Codex: plugin"></a><br>
  <a href="https://claude.com/claude-code"><img src="assets/badges/claude-code-plugin.svg" height="20" alt="Claude Code: plugin"></a> <a href="#install"><img src="assets/badges/dsh-plugin.svg" height="20" alt="DeepSeek Harness: plugin"></a><br>
  <a href="LICENSE"><img src="assets/badges/license-mit.svg" height="20" alt="license: MIT"></a>
</p>

**Unified orchestration across coding agents.**
Connect **Antigravity**, **Codex**, **Claude Code**, **DeepSeek Harness**, **Grok Build**, and more through one async delegation protocol.

[![Cospan orchestration adapter connecting Antigravity, Codex, Claude Code, and DeepSeek Harness](assets/design.png)](assets/design.svg)

**[40s Demo](#40s-demo) · [Why Cospan](#why-cospan) · [Core CUJs](#core-cujs) · [Install](#install) · [Harnesses](#harnesses) · [Roadmap](#roadmap) · [References](#references-and-license)**

## 40s Demo

https://github.com/user-attachments/assets/f51a33fc-486c-479c-95d5-3cf35a1aeab1

## Why Cospan

Frontier coding models perform best inside the native harnesses they were co-trained with—so the real unit of orchestration is **`Model × Harness`**, and different ecosystems bring distinct strengths: **Gemini 4 Carbon** (`agy`) for architecture and planning, **GPT-6.2-Sol** (`codex`) for deep bug-hunting review, **GPT-6.1-Terra** (`codex`) for live GUI and browser computer use, and **Claude** (`claude`) for frontend craft. Combining them unlocks massive leverage; humans can bridge harnesses manually with handoff prompts today, but orchestration belongs to the agents themselves.

Inspired and battle-tested by [`agy-staff`](https://github.com/keli-wen/agy-staff), Cospan turns cross-harness delegation into an **async, progressively disclosed protocol** behind one unified adapter: your host dispatches peer `Model × Harness` units in the background, stays unblocked with a clean context window, and pulls live status or full execution traces only when needed—forming a clean foundation for next-generation multi-agent collaboration.

![Why Cospan minimalist line-art diagram: moving from manual handoff ("You are the router") to Cospan ("Agents orchestrate peers") across Model × Harness units with async progressive disclosure](assets/why.png)

## Core CUJs

### Basic dispatch: one command, zero plumbing

Invoke `/cospan-<harness>` (or `/cospan:<harness>` in Claude Code, `$cospan:<harness>` in Codex) and specify any target **model**, **reasoning effort**, or **timeout** right in your prompt:

```text
/cospan-codex Use sol (high effort, 20m timeout) to review src/webhook/ and flag real edge cases.
```

> [!TIP]
> **Handled automatically under the hood (no need to manage this yourself):** Your host agent autonomously frames context (inline text or `--prompt-file`), launches a detached background session (`send`), monitors progress non-blockingly (`wait` / bounded `observe`, inspecting full trajectory logs only if needed), and collects the result—or resumes the same session (`continue`) for follow-up turns.

### Unified live sidebar (`agy` & `dsh`)

Installing on **Antigravity (`agy`)** or **DeepSeek Harness (`dsh`)** adds the unified Cospan sidebar panel—tracking live background runs across all five harnesses, inspecting Q&A outputs, and aggregating sibling Git worktrees (`wt:*`) in one view ([Install ↓](#install)):

<p align="center">
  <img src="assets/sidebar-extension.png" width="420" alt="Unified Cospan sidebar panel inside Antigravity (agy) and DeepSeek Harness (dsh) tracking Codex, Claude Code, Antigravity worktree, and DeepSeek Harness tasks">
</p>

### Cross-ecosystem workflows

- <img src="assets/badges/cuj-parallel-review.svg" height="18" alt="Parallel Review"> **Fan out 2× Sol slice reviews from Carbon** _(Antigravity → 2× Codex)_ — Split deep code reviews across modules without blocking local tests; staggered async results merge cleanly on wakeup:

  > `/cospan-codex` _"Fan out 2 `sol` reviews across `webhook/` and `retry/` for real bugs."_

  ![Gemini 4 Carbon uses 2 GPT-6.2-Sol reviewers to audit webhook/ & retry/ in parallel without blocking](assets/cuj-carbon-sol.svg)

- <img src="assets/badges/cuj-second-brain.svg" height="18" alt="Second Brain"> **Multi-turn Carbon second brain for Astra** _(Codex ⇄ Antigravity)_ — Stress-test migration plans against a second model family and follow up in the same session while staying unblocked locally:

  > `$cospan:agy` _"Ask `carbon` to stress-test `docs/plan.md`, propose a cleaner route, and verify crash recovery."_

  ![GPT-6.2-Astra consults Gemini 4 Carbon across 2 turns to stress-test docs/plan.md & verify crash safety](assets/cuj-astra-carbon.svg)

- <img src="assets/badges/cuj-computer-use.svg" height="18" alt="Computer Use"> **Live browser & GUI testing via Terra** _(Claude Code → Codex)_ — Keep code and unit-test orchestration in **Claude Sonnet**, while **GPT-6.1-Terra** drives the live browser to catch layout bugs:

  > `/cospan:codex` _"Have `terra` open the local app and walk through the checkout coupon flow."_

  ![Claude Sonnet uses GPT-6.1-Terra to drive the browser GUI, test SAVE20 at 375px, and catch a mobile CTA bug](assets/cuj-claude-terra.svg)

- <img src="assets/badges/cuj-fast-sidecars.svg" height="18" alt="Fast Sidecars"> **Offload repo scans & race checks to protect Fable quota** _(Claude Code → Antigravity + DeepSeek Harness)_ — Save scarce flagship context and quota by delegating repo surveys and concurrency checks simultaneously:

  > _"Map auth token refresh with `hydrogen` and verify 401 race conditions with `v4.1-flash`."_

  ![Claude Fable offloads auth mapping to Gemini 4 Hydrogen & race checks to DeepSeek V4.1 Flash in parallel](assets/cuj-fanout-sidecars.svg)

- <img src="assets/badges/cuj-full-pipeline.svg" height="18" alt="Full Pipeline"> **End-to-end research & review pipeline from Carbon** _(Antigravity ⇄ Codex + ×N Antigravity)_ — Drive a full plan → gate → bulk experiment → final audit → fix pass loop across **Astra**, **Hydrogen ×N**, and **Sol**:

  > _"Have `astra` review my spec, fan out `hydrogen` across all experiment configs, audit with `sol`, and send `sol`'s fixes back to `hydrogen` for one final pass."_

  ![Carbon (host) plans with Astra, fans out Hydrogen ×N, audits via Sol, and passes fixes to Hydrogen](assets/cuj-research-pipeline.svg)

## Install

Requires **Node.js `>= 20`** plus whichever coding agent CLIs you want to connect (`agy`, `claude`, `codex`, `dsh`, `grok`).

> [!TIP]
> <img src="assets/icons/cospan-pixel.svg" width="16" height="16" alt=""> **Recommended — For agents:** Paste this into any coding agent to let it detect your environment, install Cospan, and verify CLI contracts automatically:
>
> ```text
> Read the raw text of https://raw.githubusercontent.com/keli-wen/cospan/master/docs/INSTALL_FOR_AGENTS.md
> (curl it — do not work from a summary) and follow it to install and verify Cospan for the harness you are running in.
> Respond in the user's language.
> ```

### Manual install

**Antigravity (`agy`)**

```bash
git clone https://github.com/keli-wen/cospan.git ~/.cospan/repo
node ~/.cospan/repo/bin/cospan.mjs install --host agy
```

**Claude Code (`claude`)**

```bash
claude plugin marketplace add keli-wen/cospan
claude plugin install cospan@cospan
```

**OpenAI Codex (`codex`)**

```bash
codex plugin marketplace add https://github.com/keli-wen/cospan
codex plugin add cospan@cospan
```

**DeepSeek Harness (`dsh`)**

```bash
dsh plugin --profile desktop add github:keli-wen/cospan
```

_(Or in the DeepSeek Harness desktop app: **Plugins** → install from `github:keli-wen/cospan`.)_

Restart Claude Code or Codex afterwards so the plugin loads (`/cospan-…` in Antigravity and DeepSeek Harness, `/cospan:…` in Claude Code, `$cospan:…` in Codex—or describe what you want in plain language).

<details>
<summary>Upgrading & diagnostics</summary>

- **Antigravity (`agy`)**: `git -C ~/.cospan/repo pull --ff-only && node ~/.cospan/repo/bin/cospan.mjs install --host agy`
- **Claude Code (`claude`)**: `claude plugin marketplace update cospan && claude plugin update cospan@cospan`
- **OpenAI Codex (`codex`)**: `codex plugin marketplace upgrade && codex plugin add cospan@cospan`
- **DeepSeek Harness (`dsh`)**: `dsh plugin --profile desktop add 'github:keli-wen/cospan#<tag-or-commit>'`

Claude Code and Codex cache plugins by version and require a restart after upgrading. Run `node <cospan-repo>/bin/cospan.mjs doctor --check` (zero tokens) at any time to verify installed CLI binaries and flag contracts; see [docs/INSTALL_FOR_AGENTS.md](docs/INSTALL_FOR_AGENTS.md) for cache-refresh and Windows notes.

</details>

## Harnesses

| Harness                      | Ecosystem                   | Built-in model shortcuts                                         |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------- |
| **Antigravity** (`agy`)      | Google · Gemini & Claude    | `flash`, `neon`, `carbon`, `argon`, `hydrogen`, `opus`, `sonnet` |
| **Codex** (`codex`)          | OpenAI · GPT                | `sol`, `terra`, `astra`, `luna`                                  |
| **Claude Code** (`claude`)   | Anthropic · Claude          | `sonnet`, `opus`, `haiku`, `fable`                               |
| **DeepSeek Harness** (`dsh`) | DeepSeek & custom providers | `v4.1-flash` / `flash`, `v4-pro` / `pro`, `<provider>/<model>`   |
| **Grok Build** (`grok`)      | xAI · Grok                  | `build`, `fast`                                                  |

_More harnesses are on the way—Cospan's driver layer is designed to plug in additional coding agent CLIs cleanly._

## Roadmap

- [ ] **Cross-machine peer delegation over SSH** — Fire-and-collect async task handoff across machines (LAN / Tailscale) via short-lived SSH, keeping remote credentials and execution isolated without long-lived connections.

## References and License

- **[`agy-staff`](https://github.com/keli-wen/agy-staff)** — Hire Google's Antigravity CLI (`agy`) as a fast worker and second brain across Claude Code, Codex, DeepSeek Harness, Pi, and OpenCode. Cospan generalizes the async `jobs` protocol and progressive disclosure architecture first pioneered and benchmarked in `agy-staff` ([Bench v1 Tech Report](https://lastwhisper.dev/en/zen-of-harness-engineering/agy-staff-bench-v1/)).
- **Community** — [LINUX DO](https://linux.do/) (_Where possible begins_, a developer & AI community).
- **License** — [MIT](LICENSE) © 2026 Keli Wen · Release notes in [`docs/releases/`](docs/releases/) · Architecture & contributor guide in [`AGENTS.md`](AGENTS.md).
