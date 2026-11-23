## What & Why

<!-- Concise summary of what this PR changes and why (root cause or motivation). -->

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

**Observed verification notes / manual checks:**

-

## Contract & Scope Checklist

- [ ] Pure ESM `.mjs`, zero runtime `dependencies`, and `package.json` `"files"` clean
- [ ] Preserves existing CLI flags, job exit codes (`0/2/3/4/5`), `<= 8 KiB` `observe` bound, and public exports
- [ ] New or changed behavior is covered by offline tests (`tests/fakes/*`; zero live token burn in `npm test`)
- [ ] Updated docs / help text / MCP schemas if user-facing behavior changed
