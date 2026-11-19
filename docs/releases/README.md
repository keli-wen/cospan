# Cospan Release Notes

Versioned release notes and visual release overviews live here.

## Releases

- **[v0.1.1](v0.1.1.md)** — Gemini 4 Neon is in: first-class `neon` shortcut and `low`/`medium`/`high`/`xhigh` effort resolution for Antigravity (`agy`).
- **[v0.1.0](v0.1.0.md)** — Initial public release: unified 4-harness async orchestration across Antigravity (`agy`), OpenAI Codex (`codex`), Claude Code (`claude`), and DeepSeek Harness (`dsh`).

## Release Header Image Convention

Cospan release headers use the **Pixel Blueprint** style (`3:2` landscape, `#F8F9FA` drafting dot-grid, stepped-pixel chamfered cards, `#3B35B5` / `#00C48C` / `#00B4FF` / `#D97757` palette) and are generated via **`cospan-codex`** (`codex` built-in `image_gen`), with prompts and style references tracked in [`../../releases/assets/prompt.json`](../../releases/assets/prompt.json).

**Layout follows the release, not a fixed 2×2 grid**: Pixel Blueprint locks the visual language (grid, pixel-chamfer frames, palette, typography), while each release picks the layout that fits its actual scope—`1×1` hero schematic for a single flagship capability, `1×2` split for two pillars or before/after, `1×3` / `1+2` bento for three highlights, or `2×2` when a release genuinely has four equal pillars.

Every release doc includes an attribution line directly beneath its header image:

```markdown
_Header illustration generated via [`cospan-codex`](../../skills/codex/SKILL.md)._
```
