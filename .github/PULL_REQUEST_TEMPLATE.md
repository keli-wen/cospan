## TL;DR

<!--
  WRITING RULES (for humans & coding agents):
  - The PR body is for a human reviewer scanning in 10 seconds — agents and code reviewers read the git diff for implementation details.
  - NEVER narrate the diff (no file-by-file recaps, no listing internal function/helper names). If a sentence only repeats what the diff already shows, delete it.
  - Explain in 2–4 plain sentences: what problem or limitation exists today, and what behaves differently for the user/caller after this PR.
-->

### Example (Before → After)

<!--
  Show the smallest concrete CUJ, CLI command, MCP call, or input → output snippet that makes the change obvious at a glance.
  (Delete this subsection only for pure internal chores with zero user-visible or workflow-visible delta.)
-->

```text
# Before:
...

# After:
...
```

## Trade-offs & Boundaries (Optional)

<!--
  Include ONLY non-obvious context that the diff alone cannot show:
  - Why this approach over an alternative
  - Intentional non-goals, edge-case boundaries, or compatibility caveats
  Delete this section if there is nothing non-obvious to flag.
-->

## Linked Issues

<!-- Use `Fixes #123`, `Closes #123`, or `Relates to #123` (or `N/A` for standalone chores). -->

- Relates to #

## Verification

<!-- Paste actual observed results (exit status, pass/skip counts). Never check a box without running it. See CONTRIBUTING.md for the full change-surface verification matrix. -->

- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test` _(pass/skip counts: `...`)_
- [ ] `node bin/cospan.mjs install` _(required if `src/installer*`, `skills/`, `src/mcp/`, or `src/ui/` changed)_
- [ ] `node bin/cospan.mjs doctor --check` _(zero-token CLI contract check, required if drivers/targets changed)_
- [ ] Gated Windows CI (`test-windows` on `windows-latest`) requested _(required if process spawning, locking, or OS paths changed)_

**Observed notes / manual checks:**

-

## Contract & Scope Checklist

- [ ] Pure ESM `.mjs`, zero runtime `dependencies`, and `package.json` `"files"` clean
- [ ] Preserves existing CLI flags, job exit codes (`0/2/3/4/5`), `<= 8 KiB` `observe` bound, and public exports
- [ ] New or changed behavior is covered by offline tests (`tests/fakes/*`; zero live token burn in `npm test`)
- [ ] Updated docs / help text / MCP schemas if user-facing behavior changed
