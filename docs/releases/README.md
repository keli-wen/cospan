# Cospan Release Notes

Versioned release notes and visual release overviews live here.

## Releases

- **[v0.1.3](v0.1.3.md)** — Batch WaitAll, cross-worktree `<job-id>` lookup, and future `agy` model families: `cospan wait <id1> <id2> ...` & MCP `ids`, sibling git worktree resolution for explicit job IDs, generalized Gemini/Claude effort resolution, and agent-first contributor templates.
- **[v0.1.2](v0.1.2.md)** — First-class Windows runtime & gated CI: native `.cmd` shim unwrapping, `stdin` prompt transport for `agy`, detached worker & NTFS `state.lock` hardening, and 55/55 `windows-latest` CI.
- **[v0.1.1](v0.1.1.md)** — Gemini 4 Neon is in: first-class `neon` shortcut and `low`/`medium`/`high`/`xhigh` effort resolution for Antigravity (`agy`).
- **[v0.1.0](v0.1.0.md)** — Initial public release: unified 4-harness async orchestration across Antigravity (`agy`), OpenAI Codex (`codex`), Claude Code (`claude`), and DeepSeek Harness (`dsh`).

## Release Header Image Convention

Cospan release headers use the **Pixel Blueprint** style (`3:2` landscape, `#F8F9FA` drafting dot-grid, stepped-pixel chamfered cards, `#3B35B5` / `#00C48C` / `#00B4FF` / `#D97757` palette) and are generated via **`cospan-codex`** (`codex` built-in `image_gen`), with prompts and style references tracked in [`../../releases/assets/prompt.json`](../../releases/assets/prompt.json).

**Layout follows the release, not a fixed 2×2 grid**: Pixel Blueprint locks the visual language (grid, pixel-chamfer frames, palette, typography), while each release picks the layout that fits its actual scope—`1×1` hero schematic for a single flagship capability, `1×2` split for two pillars or before/after, `1×3` / `1+2` bento for three highlights, or `2×2` when a release genuinely has four equal pillars.

Every release doc includes an attribution line directly beneath its header image:

```markdown
_Header illustration generated via [`cospan-codex`](../../skills/codex/SKILL.md)._
```

## Release Upgrade Section Convention

Every release doc (and its corresponding GitHub Release body) ends with an agent-first `## Upgrade` section pointing coding agents at the raw [`docs/INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md) guide, followed by a collapsed `<details>` block with manual one-liners for all four hosts (`agy`, `claude`, `codex`, `dsh` pinned to `#<tag>`):

````markdown
## Upgrade

> [!TIP]
> **Recommended — For coding agents:** Paste this into any coding agent to upgrade Cospan to `<tag>` and verify CLI contracts for your current harness automatically:
>
> ```text
> Read the raw text of https://raw.githubusercontent.com/keli-wen/cospan/master/docs/INSTALL_FOR_AGENTS.md
> (curl it — do not work from a summary) and follow it to upgrade Cospan to <tag> and verify it for the harness you are running in.
> Respond in the user's language.
> ```

<details>
<summary>Manual upgrade commands (agy / claude / codex / dsh)</summary>

- **Antigravity (`agy`)**: `git -C ~/.cospan/repo pull --ff-only && node ~/.cospan/repo/bin/cospan.mjs install --host agy`
- **Claude Code (`claude`)**: `claude plugin marketplace update cospan && claude plugin update cospan@cospan`
- **OpenAI Codex (`codex`)**: `codex plugin marketplace upgrade && codex plugin add cospan@cospan`
- **DeepSeek Harness (`dsh`)**: `dsh plugin --profile desktop add 'github:keli-wen/cospan#<tag>'`

Restart Claude Code or Codex after upgrading, then run `node <cospan-root>/bin/cospan.mjs doctor --check` (zero tokens).

</details>
````
