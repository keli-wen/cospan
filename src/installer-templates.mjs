import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_MODEL_SHORTCUTS } from './config.mjs';

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

export const MOUNTABLE_TARGET_IDS = ['agy', 'codex', 'claude', 'dsh'];

const TARGET_DOCS = {
  codex: {
    title: 'OpenAI Codex (`codex`)',
    defaultNote:
      '`~/.cospan/config.json` and `<workspace>/.cospan/config.json` defaults; ' +
      'pass `inherit` to defer to Codex CLI settings',
    effortsNote: 'supported `--effort`: `low`, `medium`, `high`, `xhigh`',
    strengths:
      'Delegate code review, second-opinion debugging, repository research, ' +
      'scoped implementation tasks, or (only when explicitly requested via Codex) ' +
      'raster image generation/editing to OpenAI Codex CLI.',
  },
  agy: {
    title: 'Google Antigravity (`agy`)',
    defaultNote: '`~/.cospan/config.json` and `<workspace>/.cospan/config.json` defaults',
    effortsNote:
      'supported `--effort`: `low`, `medium`, `high`, `xhigh` (`xhigh` on `neon`, `hydrogen`)',
    strengths:
      'Delegate repository-wide research, multimodal/large-context analysis, code review, ' +
      'or implementation tasks to Google Antigravity CLI.',
  },
  claude: {
    title: 'Anthropic Claude Code (`claude`)',
    defaultNote:
      '`~/.cospan/config.json` and `<workspace>/.cospan/config.json` defaults; ' +
      'pass `inherit` to use Claude Code settings default',
    effortsNote: 'supported `--effort`: `low`, `medium`, `high`, `xhigh`, `max`',
    strengths:
      'Delegate code review, architectural analysis, repository debugging, ' +
      'or scoped implementation tasks to Anthropic Claude Code CLI.',
  },
  dsh: {
    title: 'DeepSeek Harness (`dsh`)',
    defaultNote:
      'defaults to `inherit` so `dsh --profile headless` uses your configured ' +
      'DeepSeek Harness provider/model without overriding `~/.dsh`',
    effortsNote: 'supported `--effort`: `off`, `low`, `high`, `max`',
    strengths:
      'Delegate repository research, verification, second-opinion debugging, ' +
      'or implementation tasks to DeepSeek Harness CLI.',
  },
};

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

function renderAgySubmitAndWait(targetId, cmd, platform = process.platform) {
  if (platform === 'win32') {
    return (
      `\`\`\`powershell\n` +
      `$jobTimeout = '60m'\n` +
      `$started = ${cmd} send --json --to ${targetId} --timeout $jobTimeout --prompt '<task>'\n` +
      `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n` +
      `$started\n` +
      `$jobId = ($started | ConvertFrom-Json -ErrorAction Stop).job_id\n` +
      `do {\n` +
      `  ${cmd} wait $jobId --timeout $jobTimeout\n` +
      `  $rc = $LASTEXITCODE\n` +
      `} while ($rc -eq 2)\n` +
      `exit $rc\n` +
      `\`\`\`\n\n`
    );
  }
  return (
    `\`\`\`bash\n` +
    `job_timeout=60m\n` +
    `started=$(${cmd} send --json --to ${targetId} --timeout "$job_timeout" ` +
    `--prompt '<task>') || exit $?\n` +
    `printf '%s\\n' "$started"\n` +
    `job_id=$(printf '%s\\n' "$started" | ` +
    `node -e 'const id = JSON.parse(require("node:fs").readFileSync(0, "utf8")).job_id; ` +
    `if (!id) process.exit(1); console.log(id);') || exit $?\n` +
    `while true; do\n` +
    `  rc=0\n` +
    `  ${cmd} wait "$job_id" --timeout "$job_timeout" || rc=$?\n` +
    `  [ "$rc" -ne 2 ] && exit "$rc"\n` +
    `done\n` +
    `\`\`\`\n\n`
  );
}

function renderAgyLaunchAndWaitSections(targetId, cmd, doc, platform = process.platform) {
  return (
    `## 1. Launch (\`send\` vs \`ask\`)\n\n` +
    `- **Background session (\`send\`, default for tool-using or long-running work)** ` +
    `uses the combined command below.\n` +
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
    `## 2. Submit and wait in one Antigravity command\n\n` +
    `Run the entire block in one workspace \`run_command\` call with \`WaitMsBeforeAsync: 500\`. ` +
    `This keeps the worker and \`wait\` in the same execution context. Set the timeout once ` +
    `and pass the requested model, effort, access and permissions on the submission line.\n\n` +
    renderAgySubmitAndWait(targetId, cmd, platform) +
    `For parallel work, submit all jobs in the same call, collect their JSON job IDs and ` +
    `pass them to one \`wait <id1> <id2>\`. For independent jobs, use a complete ` +
    `submit-and-wait call per job.\n\n` +
    `The loop re-waits automatically while \`wait\` returns \`2\` (still running) so a worker ` +
    `finishing cleanup right at its timeout still records its final status, and exits as soon ` +
    `as \`wait\` returns \`0\` (done), \`3\` (failure), \`4\` (canceled), or \`5\` (timeout with ` +
    `a resumable session). Antigravity wakes the session when the command exits. Use a timeout ` +
    `that covers the job budget.\n\n`
  );
}

export function renderAgyHostTargetSkill({ targetId, cospanBin, platform = process.platform }) {
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
  const drawSection =
    targetId === 'codex'
      ? `\n## 4. Raster Image Generation & Editing (Explicit Opt-In)\n\n` +
        `- **Only when the user explicitly asks to generate or edit an image via Codex / ` +
        `\`cospan-codex\`** (never hijack generic image requests meant for the host's default ` +
        `image tools): read \`references/draw.md\` (in this skill's directory) before ` +
        `dispatching.\n` +
        `- Covers built-in \`$imagegen\` (\`image_gen\` on ChatGPT subscription, no ` +
        `\`OPENAI_API_KEY\`), \`--effort low\` writable dispatch, transparent alpha output, ` +
        `and multi-turn visual edits via \`continue\`.\n`
      : '';
  return (
    `---\nname: cospan-${targetId}\ndescription: ${desc}\n---\n\n` +
    `# cospan-${targetId} — Delegate to ${doc.title}\n\n` +
    `\`cospan-${targetId}\` is a **persona-free** point-to-point delegation primitive. Do not ` +
    `rely on hidden role personas—state what you want inspected, reviewed, or changed directly ` +
    `in \`--prompt\`, and choose workspace write intent explicitly (\`--readonly\` vs default ` +
    `writable).\n\n` +
    renderAgyLaunchAndWaitSections(targetId, cmd, doc, platform) +
    `## 3. Multi-Turn Continuation & Result Discipline\n\n` +
    `- **Follow up in the same ${targetId} session** using the combined command above. Replace ` +
    `the submission with \`continue --json --id <job-id> --prompt "<delta>"\` (or use ` +
    `\`--last --to ${targetId}\` in place of \`--id <job-id>\`). ` +
    `Wait for the new ID in the same call.\n` +
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
    drawSection
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
    `- For new tasks and continuations, use the target skill’s combined submit-and-wait ` +
    `command. Run \`${cmd} wait <id...> --timeout 30m\` from the execution context that ` +
    `started the workers.\n` +
    `- \`${cmd} observe <id>\` — immediate <= 8 KiB JSON activity snapshot with \`phase\` and ` +
    `\`touched_files\` (never consumes \`result\`).\n` +
    `- \`${cmd} result <id>\` — print stored deliverable of a completed job.\n` +
    `- To resume a recorded session, use \`continue --json\` as the submission step in the ` +
    `target skill’s combined command.\n` +
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
      'Claude Code, and DeepSeek Harness.',
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
  const drawSection =
    targetId === 'codex'
      ? `\n## 3. Raster Image Generation & Editing (Non-Codex Hosts, Explicit Opt-In)\n\n` +
        `- **Only when running in a non-Codex host (such as Claude Code or DeepSeek Harness) ` +
        `and the user explicitly asks to generate or edit an image via Codex**: read ` +
        `\`<skill-dir>/references/draw.md\` (\`references/draw.md\` in this skill's directory) ` +
        `before dispatching. Inside Codex itself, use \`$imagegen\` directly instead of ` +
        `delegating.\n`
      : '';
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
    drawSection
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
