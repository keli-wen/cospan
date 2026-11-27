# Simplification & Anti-Bloat Guide (`SIMPLIFY.md`)

> **The best code is the code you never wrote.**
> `SIMPLIFY.md` answers one question: **which layer of complexity can be removed, and where should we stop?**
> Be **lazy about the solution, never about reading**—trace the real call path and existing modules first, then choose the smallest design that holds.
> ESLint ([`eslint.config.mjs`](eslint.config.mjs)) enforces relaxed mechanical caps (`<= 600` lines, `<= 120` lines/fn, `<= 20` complexity, zero cycles) to catch true God files without forcing artificial forwarding slices. This guide targets the **semantic and architectural bloat** linters cannot catch.

## 1. The Simplicity Ladder

Before writing custom code—or while trimming a diff—walk this ladder from top to bottom and **stop at the first rung that solves the problem**:

1. **Skip (YAGNI)** — Does this need to exist at all? Drop speculative options, future-proofing layers, and unrequested compatibility paths.
2. **Reuse in-repo** — Does an existing canonical module (`observation.mjs`, `sidebar-state.mjs`, `repo-family.mjs`, `targets.mjs`, `state-lock.mjs`, `src/config.mjs`, `sync:ui`) already own this?
3. **Use `node:` stdlib** — Can Node `>=20` built-ins (`URL`, `AbortController`, `node:fs`, `node:http`, `node:crypto`, `node:util`) handle it directly? _(Cospan has zero runtime `dependencies`—never add a package.)_
4. **Use native host/platform features** — Can the host do it natively (e.g., `document.visibilitychange`, DSH native `webServer` routes, native CSS/DOM) instead of a custom bridge or polling loop?
5. **Inline / one-liner** — Can a single-use helper be expressed cleanly inline without obscuring control flow or hiding a test seam?
6. **Minimum custom code** — Only as a last resort, write the smallest explicit implementation that satisfies the exact requirement.

### Architectural Principles

- **The Bitter Lesson (Prefer Agent Runtime Capability Over Host Middleware)**: When a coding agent can inspect live ground truth directly via native tools (e.g., running `git status` / `git diff <baseHead>` or managing temporary `git worktree`s), pass minimal anchors (`cwd`, `baseHead`, concise pointers) rather than building heavy host-side file-hashing, diff-truncation, or regex transpilation middleware.
- **Process & Lock Budget**: Long-lived helper/watchdog processes, cross-process IPC handshakes, extra lock files, and periodic `ps`/PowerShell polling carry the highest runtime and cross-platform maintenance tax. Require a concrete real-world failure (not a theoretical adversarial race) before adding any of them.

## 2. Never Simplify Away (Safety Guardrails)

Restraint is not shortcutting. **Never** simplify away:

- **Trust-boundary validation & isolation**: Auth, origin/CSRF checks, body-size caps, and strict `sessionId → workspace` scoping (`dsh/*`, `src/sidecar/*`, CLI/MCP entrypoints).
- **Honest failure propagation**: Surfacing real errors and exact exit codes (`0/2/3/4/5`)—never replace error handling with silent `catch {}` or empty `done`.
- **Cross-platform process & lock safety**: `windowsHide: true`, `.cmd` unwrapping (`buildSpawnCommand()`), lock retries, and descendant process-tree teardown.
- **Public contracts & explicit requirements**: Documented CLI flags, MCP schemas, public exports, or behavior explicitly requested by the spec.

## 3. PR-Scoped Simplification (Author Pass Before Review)

Run once the behavior works and passes tests, before requesting review. Never mix new features or contract changes into a simplify pass.

Audit your diff for:

1. **Write-only state & dead branches**: State written but never read, unreachable fallbacks, or unused fields forwarded across layers.
2. **Repeated internal validation**: Validate untrusted input once at the boundary; strip redundant null guards and defensive re-checks deeper inside trusted call chains.
3. **Single-use wrappers & speculative compatibility**: Remove pass-through helpers and guesses about hypothetical future hosts.
4. **Duplicated sources of truth**: Consolidate back into the canonical module or generator instead of maintaining parallel copies.

**Deliberate simplicity note**: When you intentionally choose a simpler mechanism with a known ceiling (e.g., clearing a bounded `Map` cache at 500 entries instead of implementing LRU), leave a short one-line comment stating **the chosen shortcut and the concrete condition to revisit it**—do not build the complex version prematurely, and do not leave future readers guessing.

**Stop condition**: Keep only edits that make the _same change_ easier to verify. Stop immediately if an edit would require migrating unrelated callers, widening public exports, or changing another host's behavior.

## 4. Repo-Wide Architectural Simplification (Maintainer-Initiated Pass)

Run as its own focused PR—never piggybacked onto a bugfix or external contribution.

1. **Name the recurring maintenance tax first**: Cite concrete friction (e.g., "every job-status fix requires parallel edits in three entrypoints" or "two modules maintain divergent workspace resolution").
2. **Separate shared invariants from legitimate host/harness differences**: Superficial code similarity across `agy`/`codex`/`claude`/`dsh` drivers or host adapters is **not** enough to justify a shared abstraction. Keep divergent upstream protocols explicit when unifying them would trade clarity for branching conditionals.
3. **Ship one reversible step**: Propose the smallest structural collapse that can be tested and reverted independently. **"Keep as-is" is a valid conclusion** when an abstraction adds more indirection than it removes.

## 5. Proving a Simplification Paid Off

Every simplification PR or pass should state:

- **What disappeared**: Which duplicate state, branch, abstraction layer, or cross-file sync obligation was removed.
- **Equivalence proof**: Which tests or checks confirm external behavior and public contracts are unchanged.

Slicing a long function into forwarding helpers or moving code across files without deleting state, branching, or coupling may pass ESLint, but it is churn—not simplification.
