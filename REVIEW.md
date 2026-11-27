# Code Review Guide (`REVIEW.md`)

> `REVIEW.md` answers one question: **can this change merge, and what evidence supports that decision?**
> For setup, verification commands, labels, and releases, see [`CONTRIBUTING.md`](CONTRIBUTING.md). For reducing complexity and architectural cleanup, see [`SIMPLIFY.md`](SIMPLIFY.md).

## 1. Start With Observable Impact

Before reading line-by-line, state **who sees what change** (reusing the PR's `Before → After` example):

1. Does this change actually solve the reported problem?
2. Which caller—human user or outer coding agent—could now receive a wrong, truncated, or silent result?

For an agent-facing CLI/MCP tool, silently reporting `done` on a failure is a product defect just like rendering broken output in a UI.

## 2. Match Review Depth to Risk

Choose the actions the change warrants—**no tier numbers or extra labels required**. Actions stack naturally, and [`CONTRIBUTING.md`](CONTRIBUTING.md)'s Verification Matrix always applies:

- **Standard self-check + review**: Behavior, permissions, and external contracts are unchanged and the blast radius is obvious from the diff.
- **Independent fresh-context review (counterexample pass)**: Trigger whenever a change can misreport job outcomes, orphan child processes, break existing callers, alter UI/host synchronization, or cross local auth/workspace boundaries. Have a reviewer who did not write the code (human, fresh-context agent, or another model to break shared blind spots) inspect the original problem, diff, and tests, and actively try to construct counterexamples.
- **Pre-code boundary alignment (design check)**: Trigger when adding a new control surface (HTTP route, MCP tool, CLI command/flag), changing persisted state ownership, or adding a new target CLI / host plugin. Align on boundaries and failure modes with a maintainer before coding. _(If an external PR already arrives with an implementation, first confirm whether the maintainer accepts the surface—do not demand a retroactive RFC.)_
- **First-time external PRs**: Always approve and run GitHub Actions CI before merge, especially when the author verified on only one OS.

### Threat Model & Non-Goals

- **Scope & trust boundaries**: Cospan is a local developer CLI / MCP orchestration tool. Trust boundaries are local HTTP sidecar / DSH auth, origin, and CSRF checks, strict `sessionId → workspace` scoping, and same-workspace-family job cancellation.
- **Non-Goals**: Cospan runs in a trusted local developer environment—do not engineer against OS-level `SIGKILL` (`kill -9`) or synthetic sub-millisecond races between internal helpers.

## 3. Four Review Lenses

Expand only the lenses the diff actually touches. Cite the test, observation, or contract behind each judgment:

1. **Caller & Agent-Loop Contract (incl. Core UX Risk)** — _Can a human or outer agent tell what happened and take the right next step?_
   - Upstream terminal/error events, CLI exit codes (`0/2/3/4/5`), and persisted job status agree (never convert an error into empty `done`).
   - MCP `stdout` remains valid JSON-RPC; `observe` stays `<= 8 KiB`; host sidebars do not spam chat transcripts or stall silently.
2. **Cross-Platform & Multi-Harness Reality** — _Does this still hold across supported OSes and harnesses?_
   - Check Windows `.cmd` unwrapping (`buildSpawnCommand()`), `windowsHide: true`, CRLF handling, temp-dir/handle release before `rmSync`, and descendant process-tree teardown.
   - Verify first-run vs. `resume` flag asymmetries against real upstream `--help` (`doctor --check`).
3. **Permissions, Auth & Workspace Isolation** — _Who can read, mutate, or cancel which job?_
   - Verify sidecar token vs. DSH native HTTP auth/origin/CSRF checks, strict `sessionId → workspace` resolution (zero silent fallback to default directories), and same-workspace-family cancellation bounds.
   - Confirm offline tests isolate `COSPAN_HOME` / `COSPAN_CONFIG_DIR` and diffs remain clean-room (no personal paths, real transcripts, or secrets).
4. **Runtime Resource & Performance Cost** — _What does this cost while running, idle, hidden, and exiting?_
   - Check wait latency, polling requests while a sidebar/window is hidden or collapsed (must be `0`), duplicate child processes, and leaked handles, timers, or listeners.
   - Verify `npm test` burns zero live tokens and host bundle outputs (`dsh/client.js`, `skills/*`) stay synced without polluting other hosts' defaults.

## 4. Findings Format, Scope & Convergence

Classify findings clearly:

- **`Blocker`** — Correctness bug, silent failure, security/isolation breach, broken public contract, or missing evidence for a high-risk path. Must cite `file:line`, trigger condition, visible consequence, and concrete fix or missing check. **Proportionality Gate**: A finding is only a `Blocker` if it is triggerable on realistic human/agent usage paths or crosses a real trust boundary; theoretical timing races or `SIGKILL` injection must be logged as `Note / Follow-up` (documenting the known boundary), never used to block merge.
- **`Should Fix`** — Real edge-case gap, missing test for changed logic, or doc/bundle drift (`dsh/client.js`, `skills/*`, help/MCP schema).
- **`Note / Follow-up`** — Non-blocking polish or pre-existing debt outside this PR's scope.

Convergence rules:

1. **Judge within the PR's scope**: Never block a PR on pre-existing issues or unrelated refactors—log those as `Note / Follow-up`.
2. **Converge across rounds**: Flag the full _class_ of a defect on Round 1. On re-review, verify prior blockers and check for new regressions; do not peel deeper layers of secondary nits across rounds.
3. **Boundary with [`SIMPLIFY.md`](SIMPLIFY.md)**: If a reviewer asks for simplification _inside_ the current PR, they must name which behavior of this change is hard to guarantee or verify under the current structure. Otherwise record it as a follow-up cleanup rather than blocking merge.
4. **No Defensive Escalation**: If fixing a review finding would require introducing a new long-lived watchdog process, a separate lock file, a custom IPC handshake protocol, or high-frequency OS process-table polling, stop and re-evaluate whether the finding falls outside Cospan's threat model before adding machinery.
5. **Post-Review Simplify Check**: After multi-round review fixes that add new files, locks, processes, or polling loops, run a final [`SIMPLIFY.md`](SIMPLIFY.md) pass before merging.
