---
name: claude
description: Point-to-point headless delegation to Anthropic Claude Code (`claude`) via cospan ($cospan:claude). Delegate code review, architectural analysis, repository debugging, or scoped implementation tasks to Anthropic Claude Code CLI. Model shortcuts include `sonnet`, `opus`, `haiku`, `fable`.
---

# $cospan:claude — Delegate to Anthropic Claude Code (`claude`)

`$cospan:claude` is a **persona-free** point-to-point delegation primitive. State the concrete task directly in `prompt`, and select `readonly: true` (research/review/verification) vs `readonly: false` (default writable workspace edits). Runs `unrestricted` by default unless `restricted: true` or `config.json` opts into OS sandboxing.

## 1. Preferred Path: Bundled `cospan` MCP Tools

Always prefer the bundled `cospan` MCP tools over raw shell command calls—they run outside host command sandboxing and block cleanly inside a single tool call without polling overhead:

1. **Dispatch (`cospan_send`):**
   Call MCP tool `cospan_send` with:
   - `cwd`: **required** absolute path of your current repository/workspace
   - `to`: `"claude"`
   - `prompt`: your task instructions
   - `readonly`: `true` for read-only inspection/review, `false` (default) when file edits are allowed
   - `restricted` *(optional)*: `true` to opt into strict OS sandboxing (defaults to `unrestricted`)
   - `model` *(optional)* / `effort` *(optional)* / `raw` *(optional)* / `timeout` *(optional, e.g. `"60m"`)*
   - **Models & effort (verbatim shortcut contract)**: pass user model shortcuts **verbatim** to `model` / `--model` (`sonnet`, `opus`, `haiku`, `fable`), pass explicit full model IDs or `<provider>/<model>` verbatim when specified, or omit `model` / `--model` when unspecified so `cospan` uses effective target defaults (`~/.cospan/config.json` and `<workspace>/.cospan/config.json` defaults; pass `inherit` to use Claude Code settings default). **Never guess or expand version numbers (such as `gpt-6.0-*`) or append effort suffixes (such as `-medium`) on the host side**—always pass reasoning effort separately via `effort` / `--effort` (supported `--effort`: `low`, `medium`, `high`, `xhigh`, `max`) and let `cospan` resolve shortcuts deterministically at runtime.

2. **Collect (`cospan_wait`):**
   Call MCP tool `cospan_wait` with `{ "cwd": "<workspace>", "id": "<job_id>", "timeout": "20m" }` (or `{ "cwd": "<workspace>", "ids": ["<id1>", "<id2>"], "timeout": "20m" }` for batch WaitAll).
   - `cospan_wait` blocks quietly until the detached worker(s) finish and returns `status` + full deliverable outputs in one shot.
   - **Batch vs. separate `cospan_wait`:** pass `ids: [id1, id2, ...]` when the next step needs all parallel outputs together (e.g., merging multi-module reviews or validating parallel subtasks together)—wakes the host only once. Issue separate `cospan_wait` calls when parallel jobs are independent with uneven runtimes (e.g., 2 min vs. 15 min) and you want to act on whichever finishes first.
   - If `exit_code === 2` (`status === "running"`), call `cospan_wait` again (batch timeout returns bounded <= 8 KiB JSON without duplicating completed bodies).
   - If `exit_code === 5` (`status === "attention"`), ask the user before calling `cospan_continue`.

3. **Follow-up / Peek / Fast Q&A:**
   - Multi-turn continuation in the same claude session: `cospan_continue` (`cwd`, `id` or `last: true`, `prompt` with only the delta instruction) -> then `cospan_wait` on the new job ID.
   - Mid-flight bounded snapshot (<= 8 KiB JSON with `phase` and `touched_files`): `cospan_observe` (`cwd`, `id`).
   - Fast zero-tool foreground Q&A: `cospan_ask` (`cwd`, `to: "claude"`, `prompt`).
   - Cancel: `cospan_cancel` (`cwd`, `id`).

4. **Result Handling & Evidence Boundaries:**
   - Preserve claude's `file:line` citations, observed facts vs inferences, and severity ordering verbatim.
   - Never mask a failed or incomplete delegation with a silent host-side substitute—surface the delegation failure first.
   - When `readonly: true` was used for a review, present the findings before auto-applying controversial edits if the user only asked for a review.

## 2. CLI Fallback (only if `cospan` MCP server is unavailable)

Run unsandboxed in your workspace directory:
```bash
node "<skill-dir>/../../bin/cospan.mjs" send --to claude [--readonly] --prompt "<task>"
node "<skill-dir>/../../bin/cospan.mjs" wait <job-id...> --timeout 10m
```
