import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_MODEL_SHORTCUTS } from './config.mjs';
import {
  renderAgyTargetExtraSection,
  renderCodexTargetExtraSection,
  TARGET_DOCS,
} from './installer-target-docs.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(SELF_DIR, '..');
export const COSPAN_BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cospan.mjs');
export const SIDECAR_SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'sidecar', 'server.mjs');

function shellQuote(p) {
  return `"${String(p).replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
}

export function cliCommandPrefix(cospanBin = COSPAN_BIN_PATH) {
  return `node ${shellQuote(cospanBin)}`;
}

export const MOUNTABLE_TARGET_IDS = ['agy', 'codex', 'claude', 'dsh', 'grok'];

function formatTargetModelShortcuts(targetId) {
  return (TARGET_MODEL_SHORTCUTS[targetId] || []).map((s) => `\`${s}\``).join(', ');
}

function formatModelsContractNote(targetId, doc) {
  const shortcuts = formatTargetModelShortcuts(targetId);
  return (
    `**Models & effort (verbatim shortcut contract)**: pass user model shortcuts ` +
    `**verbatim** to \`model\` / \`--model\` (${shortcuts}), pass explicit full model IDs ` +
    `or \`<provider>/<model>\` verbatim when specified, or omit \`model\` / \`--model\` ` +
    `when unspecified so \`cospan\` uses effective target defaults (${doc.defaultNote}). ` +
    `**Never guess or expand version numbers (such as \`gpt-6.0-*\`) or append effort ` +
    `suffixes (such as \`-medium\`) on the host side**—always pass reasoning effort ` +
    `separately via \`effort\` / \`--effort\` (${doc.effortsNote}) and let \`cospan\` ` +
    `resolve shortcuts deterministically at runtime.`
  );
}

function renderAgyLaunchAndWaitSections(targetId, cmd, doc) {
  return (
    `## 1. Launch (\`send\` vs \`ask\`)\n\n` +
    `- **Background session (\`send\`, default for any real task or tool-using work):**\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} send --to ${targetId} [--readonly] [--restricted] [--raw] \\\n` +
    `    [--model <id>] [--effort <low|medium|high|xhigh>] [--timeout 60m] --prompt "<task>"\n` +
    `  \`\`\`\n` +
    `  - **Permissions**: Runs \`unrestricted\` by default so cross-directory reads, builds, ` +
    `and tool caches never stall on OS sandbox prompts. Pass \`--restricted\` (or set ` +
    `\`"permissions": "restricted"\` in \`config.json\`) only when OS sandboxing is explicitly ` +
    `desired.\n` +
    `  - Add \`--readonly\` for research, review, or verification where ${targetId} must NOT ` +
    `modify workspace files.\n` +
    `  - Omit \`--readonly\` when ${targetId} should edit files in the current workspace ` +
    `(pre-existing dirty paths are automatically listed in the envelope, and post-run file ` +
    `deltas are appended to the result).\n` +
    `  - Add \`--raw\` only when passing a pre-framed machine protocol prompt with zero ` +
    `envelope wrapping.\n` +
    `  - For multi-paragraph prompts, write to a scratch file and pass \`--prompt-file <path>\` ` +
    `(or pipe via \`--stdin\`).\n` +
    `  - ${formatModelsContractNote(targetId, doc)}\n\n` +
    `- **Fast zero-tool foreground check (\`ask\`, seconds-long factual Q&A only):**\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} ask --to ${targetId} --prompt "<short question>"\n` +
    `  \`\`\`\n\n` +
    `## 2. Antigravity (\`agy\`) Zero-Polling Wait Recipe\n\n` +
    `After \`send\` prints \`Job <id> started\`, collect it using Antigravity's native ` +
    `background task wakeup—**never poll in a loop**:\n\n` +
    `1. Run \`send\` with \`run_command\` (\`WaitMsBeforeAsync: 5000\`) ` +
    `to capture \`<job-id>\`.\n` +
    `2. Immediately launch \`wait\` with \`WaitMsBeforeAsync: 500\` so Antigravity backgrounds ` +
    `the wait task:\n` +
    `   \`\`\`bash\n` +
    `   ${cmd} wait <job-id> --timeout 30m\n` +
    `   # Or batch WaitAll across multiple parallel jobs (allSettled barrier):\n` +
    `   ${cmd} wait <id1> <id2> --timeout 30m\n` +
    `   \`\`\`\n` +
    `   - **Batch vs. separate \`wait\`:**\n` +
    `     - **Batch (\`wait id1 id2 ...\`):** use when the next step needs all parallel ` +
    `outputs together (e.g., merging multi-module reviews or validating parallel subtasks ` +
    `together)—wakes the host only once.\n` +
    `     - **Separate (\`wait id1\` & \`wait id2\`):** use when parallel jobs are independent ` +
    `with uneven runtimes (e.g., 2 min vs. 15 min) and you want to act on whichever finishes ` +
    `first.\n` +
    `3. **End your turn (call no more tools)** unless you have genuinely independent local ` +
    `work to do first. Antigravity will automatically wake you as soon as \`wait\` exits with ` +
    `the deliverable output!\n` +
    `4. Exit codes of \`wait\`: \`0\` = done (stdout has the full report), \`2\` = still running ` +
    `(launch \`wait\` again; batch timeout emits bounded <= 8 KiB status JSON without ` +
    `duplicating completed bodies), \`3\` = error, \`4\` = canceled, \`5\` = timed out with a ` +
    `resumable session (ask the user before continuing).\n\n`
  );
}

export function renderAgyHostTargetSkill({ targetId, cospanBin }) {
  const doc = TARGET_DOCS[targetId];
  const cmd = cliCommandPrefix(cospanBin);
  const selfNote =
    targetId === 'agy'
      ? ' Use when you need explicit `--model` or `--effort` selection not exposed by ' +
        'built-in subagents, or a detached cospan session.'
      : '';
  const desc =
    `Point-to-point headless delegation to ${doc.title} via cospan. ` +
    `${doc.strengths} Model shortcuts include ${formatTargetModelShortcuts(targetId)}.${selfNote}`;
  const extraSection = renderAgyTargetExtraSection(targetId);
  return (
    `---\nname: cospan-${targetId}\ndescription: ${desc}\n---\n\n` +
    `# cospan-${targetId} — Delegate to ${doc.title}\n\n` +
    `\`cospan-${targetId}\` is a **persona-free** point-to-point delegation primitive. Do not ` +
    `rely on hidden role personas—state what you want inspected, reviewed, or changed directly ` +
    `in \`--prompt\`, and choose workspace write intent explicitly (\`--readonly\` vs default ` +
    `writable).\n\n` +
    renderAgyLaunchAndWaitSections(targetId, cmd, doc) +
    `## 3. Multi-Turn Continuation & Result Discipline\n\n` +
    `- **Follow up in the exact same ${targetId} session:**\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} continue --id <job-id> --prompt "<delta follow-up instructions>"\n` +
    `  # or resume the latest finished ${targetId} job in this workspace:\n` +
    `  ${cmd} continue --last --to ${targetId} --prompt "<delta follow-up instructions>"\n` +
    `  \`\`\`\n` +
    `  (Send only the delta instruction rather than restating the whole prior prompt; ` +
    `collect the new linked job ID with \`wait\`.)\n` +
    `- **Bounded progress peek (<= 8 KiB JSON with \`phase\` & \`touched_files\`, ` +
    `only if the user asks mid-flight):**\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} observe <job-id>\n` +
    `  \`\`\`\n` +
    `- **Cancel a running job:** \`${cmd} cancel <job-id>\`\n` +
    `- **Result handling & evidence boundaries:**\n` +
    `  - Preserve ${targetId}'s \`file:line\` citations, observed facts vs hypotheses, ` +
    `and severity ordering accurately.\n` +
    `  - Never mask a failed or timed-out delegation with a silent host-side substitute—report ` +
    `the delegation failure first.\n` +
    `  - When \`--readonly\` was used for a review, present the findings to the user before ` +
    `auto-applying controversial edits if they only asked for a review.\n` +
    extraSection
  );
}

export function renderAgyHostJobsSkill({ cospanBin }) {
  const cmd = cliCommandPrefix(cospanBin);
  const desc =
    'Internal job collection and lifecycle protocol for cospan background jobs in Antigravity.';
  return (
    `---\nname: cospan-jobs\ndescription: ${desc}\nuser-invocable: false\n---\n\n` +
    `# cospan-jobs (Antigravity Host Protocol)\n\n` +
    `Manage detached \`cospan\` jobs and trajectories recorded for the current workspace ` +
    `(stored out-of-tree under \`~/.cospan/trajectories/\`):\n\n` +
    `- \`${cmd} wait <id...> --timeout 30m\` — run via \`run_command\` with ` +
    `\`WaitMsBeforeAsync: 500\` and stop calling tools so Antigravity wakes you on completion ` +
    `(pass multiple IDs for a pure WaitAll barrier when all parallel outputs are needed ` +
    `together; use separate \`wait\` calls when runtimes are uneven and you want to act on ` +
    `whichever finishes first).\n` +
    `- \`${cmd} observe <id>\` — immediate <= 8 KiB JSON activity snapshot with \`phase\` and ` +
    `\`touched_files\` (never consumes \`result\`).\n` +
    `- \`${cmd} result <id>\` — print stored deliverable of a completed job.\n` +
    `- \`${cmd} continue (--id <id> | --last [--to <target>]) --prompt "..."\` — resume the ` +
    `recorded target session in a linked job.\n` +
    `- \`${cmd} cancel <id>\` — terminate a running worker and its descendant process group ` +
    `safely.\n` +
    `- \`${cmd} status [id]\` — list recent jobs or inspect one job record.\n` +
    `- \`${cmd} config\` — inspect effective config & model mappings (\`~/.cospan/config.json\` ` +
    `+ \`<workspace>/.cospan/config.json\`).\n`
  );
}

export function renderAgySidecarManifest({ sidecarServerPath = SIDECAR_SERVER_PATH } = {}) {
  return {
    command: process.execPath,
    args: [sidecarServerPath],
    restart_policy: 'always',
    display_name: 'Cospan',
    description:
      'Live workspace delegation board for Cospan tasks across Antigravity, Codex, ' +
      'Claude Code, DeepSeek Harness, and Grok Build.',
    has_web_ui: true,
    agent_permissions: {
      allows_user_interactions: false,
    },
    ui_config: {
      display_name: 'Cospan',
      views: [
        {
          path: '/',
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
          title: 'Cospan',
        },
        {
          path: '/',
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_SIDEBAR',
          title: 'Cospan',
        },
      ],
    },
  };
}

function renderCodexMcpDetails(targetId, doc) {
  return (
    `## 1. Preferred Path: Bundled \`cospan\` MCP Tools\n\n` +
    `Always prefer the bundled \`cospan\` MCP tools over raw shell command calls—they run ` +
    `outside host command sandboxing and block cleanly inside a single tool call without polling ` +
    `overhead:\n\n` +
    `1. **Dispatch (\`cospan_send\`):**\n` +
    `   Call MCP tool \`cospan_send\` with:\n` +
    `   - \`cwd\`: **required** absolute path of your current repository/workspace\n` +
    `   - \`to\`: \`"${targetId}"\`\n` +
    `   - \`prompt\`: your task instructions\n` +
    `   - \`readonly\`: \`true\` for read-only inspection/review, \`false\` (default) when file ` +
    `edits are allowed\n` +
    `   - \`restricted\` *(optional)*: \`true\` to opt into strict OS sandboxing (defaults to ` +
    `\`unrestricted\`)\n` +
    `   - \`model\` *(optional)* / \`effort\` *(optional)* / \`raw\` *(optional)* / ` +
    `\`timeout\` *(optional, e.g. \`"60m"\`)*\n` +
    `   - ${formatModelsContractNote(targetId, doc)}\n\n` +
    `2. **Collect (\`cospan_wait\`):**\n` +
    `   Call MCP tool \`cospan_wait\` with ` +
    `\`{ "cwd": "<workspace>", "id": "<job_id>", "timeout": "20m" }\` (or ` +
    `\`{ "cwd": "<workspace>", "ids": ["<id1>", "<id2>"], "timeout": "20m" }\` for batch ` +
    `WaitAll).\n` +
    `   - \`cospan_wait\` blocks quietly until the detached worker(s) finish and returns ` +
    `\`status\` + full deliverable outputs in one shot.\n` +
    `   - **Batch vs. separate \`cospan_wait\`:** pass \`ids: [id1, id2, ...]\` when the next ` +
    `step needs all parallel outputs together (e.g., merging multi-module reviews or validating ` +
    `parallel subtasks together)—wakes the host only once. Issue separate \`cospan_wait\` calls ` +
    `when parallel jobs are independent with uneven runtimes (e.g., 2 min vs. 15 min) and you ` +
    `want to act on whichever finishes first.\n` +
    `   - If \`exit_code === 2\` (\`status === "running"\`), call \`cospan_wait\` again ` +
    `(batch timeout returns bounded <= 8 KiB JSON without duplicating completed bodies).\n` +
    `   - If \`exit_code === 5\` (\`status === "attention"\`), ask the user before calling ` +
    `\`cospan_continue\`.\n\n` +
    `3. **Follow-up / Peek / Fast Q&A:**\n` +
    `   - Multi-turn continuation in the same ${targetId} session: \`cospan_continue\` ` +
    `(\`cwd\`, \`id\` or \`last: true\`, \`prompt\` with only the delta instruction) -> ` +
    `then \`cospan_wait\` on the new job ID.\n` +
    `   - Mid-flight bounded snapshot (<= 8 KiB JSON with \`phase\` and \`touched_files\`): ` +
    `\`cospan_observe\` (\`cwd\`, \`id\`).\n` +
    `   - Fast zero-tool foreground Q&A: \`cospan_ask\` (\`cwd\`, \`to: "${targetId}"\`, ` +
    `\`prompt\`).\n` +
    `   - Cancel: \`cospan_cancel\` (\`cwd\`, \`id\`).\n\n`
  );
}

export function renderCodexHostTargetSkill({ targetId, cospanBin }) {
  const doc = TARGET_DOCS[targetId];
  const cmd = cliCommandPrefix(cospanBin);
  const selfNote =
    targetId === 'codex'
      ? ' Use when you need explicit model/effort selection or an isolated detached ' +
        'cospan session.'
      : '';
  const desc =
    `Point-to-point headless delegation to ${doc.title} via cospan ($cospan:${targetId}). ` +
    `${doc.strengths} Model shortcuts include ${formatTargetModelShortcuts(targetId)}.${selfNote}`;
  const extraSection = renderCodexTargetExtraSection(targetId);
  return (
    `---\nname: ${targetId}\ndescription: ${desc}\n---\n\n` +
    `# $cospan:${targetId} — Delegate to ${doc.title}\n\n` +
    `\`$cospan:${targetId}\` is a **persona-free** point-to-point delegation primitive. State ` +
    `the concrete task directly in \`prompt\`, and select \`readonly: true\` ` +
    `(research/review/verification) vs \`readonly: false\` (default writable workspace edits). ` +
    `Runs \`unrestricted\` by default unless \`restricted: true\` or \`config.json\` opts into ` +
    `OS sandboxing.\n\n` +
    renderCodexMcpDetails(targetId, doc) +
    `4. **Result Handling & Evidence Boundaries:**\n` +
    `   - Preserve ${targetId}'s \`file:line\` citations, observed facts vs inferences, ` +
    `and severity ordering verbatim.\n` +
    `   - Never mask a failed or incomplete delegation with a silent host-side ` +
    `substitute—surface the delegation failure first.\n` +
    `   - When \`readonly: true\` was used for a review, present the findings before ` +
    `auto-applying controversial edits if the user only asked for a review.\n\n` +
    `## 2. CLI Fallback (only if \`cospan\` MCP server is unavailable)\n\n` +
    `Run unsandboxed in your workspace directory:\n` +
    `\`\`\`bash\n${cmd} send --to ${targetId} [--readonly] --prompt "<task>"\n` +
    `${cmd} wait <job-id...> --timeout 10m\n\`\`\`\n` +
    extraSection
  );
}

export function renderCodexHostJobsSkill() {
  return (
    `---\nname: jobs\ndescription: Internal lifecycle reference for cospan detached jobs ` +
    `inside Codex.\nuser-invocable: false\n---\n\n` +
    `# cospan:jobs (Codex Host Protocol)\n\n` +
    `Use the \`cospan\` MCP tools with \`cwd\` set to your active workspace root ` +
    `(state & trajectories live under \`~/.cospan/trajectories/\`):\n` +
    `- \`cospan_wait\` — block cleanly on a single \`id\` or batch WaitAll \`ids: [...]\` ` +
    `(batch when all parallel outputs are needed together; separate calls when runtimes are ` +
    `uneven and you want to act on whichever finishes first).\n` +
    `- \`cospan_observe\` — bounded <= 8 KiB JSON progress snapshot without reading the full ` +
    `result body.\n` +
    `- \`cospan_continue\` — continue a prior \`job_id\`'s native conversation thread ` +
    `(or \`last: true\`).\n` +
    `- \`cospan_result\` — read the stored output of a finished \`job_id\`.\n` +
    `- \`cospan_cancel\` — cancel a running \`job_id\`.\n` +
    `- \`cospan_status\` — list recorded jobs for \`cwd\`.\n`
  );
}
