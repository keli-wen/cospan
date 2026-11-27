# Real-Time Web & X Research via Grok Build

Delegate live web verification and real-time X research to xAI Grok Build CLI's built-in search tools.

## 0. Scope & Capability Boundaries

- **Native web & page tools**: `web_search`, `web_fetch`, `open_page`, and `open_page_with_find`.
- **Native live X (Twitter) tools**: `x_keyword_search`, `x_semantic_search`, `x_user_search`, and `x_thread_fetch`.
- **Prefer `--readonly` / `readonly: true`**: Keep workspace writes disabled whenever gathering external facts, release notes, issues, or documentation checks.
- **Prerequisites & auth boundary**: Requires a signed-in `grok` CLI (`grok login`) and network access. Do not pass `--disable-web-search`, and never run interactive `grok login` from an agent turn.
- **Built-in media tools (explicit opt-in only)**: Grok Build also exposes `image_gen`, `image_to_video`, and `reference_to_video`. Use these ONLY when the user explicitly asks to generate media via Grok / `cospan-grok` (omit `--readonly` when saving files to workspace paths), and never hijack generic image requests meant for the host's default image tools or `cospan-codex`'s `$imagegen`.

## 1. Dispatch & Collection (MCP Hosts: Claude Code / DeepSeek Harness)

- **Read-only by default for research**: Set `readonly: true` whenever verifying docs, issues, releases, or live web/X state without modifying workspace files.
- **Model & effort**: Omit `model` (`inherit`) or pass `model: "fast"` verbatim (never hardcode versioned model IDs); pass `effort: "low"` for quick lookups or `"high"` for deeper synthesis.
- **Dispatch via `cospan_send` + `cospan_wait`**:
  1. Call `cospan_send` with `{ "cwd": "<workspace>", "to": "grok", "readonly": true, "effort": "low", "timeout": "10m", "prompt": "Search the live web and X for <topic>. Cite exact URLs, dates, and quotes." }`.
  2. Call `cospan_wait` with `{ "cwd": "<workspace>", "id": "<job_id>", "timeout": "10m" }`.
- **Multi-turn follow-up in the same research thread (`cospan_continue`)**:
  Call `cospan_continue` (`id: "<job_id>"`, `effort: "low"`, delta `prompt`), then call `cospan_wait` on the new job ID.
- **CLI fallback (only if `cospan` MCP is unavailable)**:
  ```bash
  node "<skill-dir>/../../bin/cospan.mjs" send --to grok --readonly --effort low --timeout 10m --prompt '<topic>'
  node "<skill-dir>/../../bin/cospan.mjs" wait <job-id> --timeout 10m
  ```

## 2. Citation & Evidence Discipline

- **Primary links & timestamps**: Require exact URLs, post/thread links, publication dates/timestamps, and verbatim quotes from sources.
- **Source separation**: Keep verified external facts (URL + date) distinct from local repository observations (`file:line`) and inferences.
- **No silent fallbacks**: Never mask a failed or offline lookup with guesswork; report missing, blocked, or unverified items explicitly.
