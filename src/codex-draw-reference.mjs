import { cliCommandPrefix } from './installer-templates.mjs';

function renderAgyDispatchBlock() {
  return (
    `## 1. Dispatch & Zero-Polling Wait (Antigravity Host)\n\n` +
    `- **Writable access required**: Omit \`--readonly\` so Codex can copy the generated PNG ` +
    `from \`$CODEX_HOME/generated_images/<thread_id>/\` to your destination path.\n` +
    `- **Reasoning effort**: Pass \`--effort low\` (or \`medium\` at most)—image generation ` +
    `does not benefit from \`high\`/\`xhigh\` reasoning overhead.\n` +
    `- **Launch and collect** using the combined command in section 2 of the parent skill. ` +
    `Set the timeout to 10m and add \`--effort low\` to the submission. Prefix the prompt with ` +
    `\`$imagegen\` in single quotes (or pass \`--prompt-file\`) so the shell keeps \`$imagegen\` ` +
    `literal, and specify the absolute destination for the final PNG.\n` +
    `- **Refine in the same visual thread** using \`continue --json --id <job-id>\` in the ` +
    `combined command. Specify what to preserve, the change, and the new output path.\n\n`
  );
}

function renderMcpDispatchBlock(cospanBin) {
  const cmd = cliCommandPrefix(cospanBin);
  return (
    `## 1. Dispatch & Collection (MCP Hosts: Claude Code / DeepSeek Harness)\n\n` +
    `- **Writable access required**: Set \`readonly: false\` (default) so Codex can copy the ` +
    `generated PNG from \`$CODEX_HOME/generated_images/<thread_id>/\` to your destination path.\n` +
    `- **Reasoning effort**: Pass \`effort: "low"\` (or \`"medium"\` at most)—image generation ` +
    `does not benefit from \`high\`/\`xhigh\` reasoning overhead.\n` +
    `- **Dispatch via \`cospan_send\` + \`cospan_wait\`**:\n` +
    `  1. Call \`cospan_send\` with \`{ "cwd": "<workspace>", "to": "codex", ` +
    `"readonly": false, "effort": "low", "timeout": "10m", "prompt": "$imagegen <spec>. ` +
    `Use built-in image_gen without asking for confirmation, copy the final PNG to ` +
    `\\"<abs-output-path>\\", and report the saved path." }\`.\n` +
    `  2. Call \`cospan_wait\` with \`{ "cwd": "<workspace>", "id": "<job_id>", ` +
    `"timeout": "10m" }\`.\n` +
    `- **Multi-turn refinement in the same visual thread (\`cospan_continue\`)**:\n` +
    `  Codex's built-in \`image_gen\` edit mode operates on images already in the thread. ` +
    `Call \`cospan_continue\` (\`id: "<job_id>"\`, \`effort: "low"\`, delta \`prompt\` ` +
    `listing invariants + new \`<abs-v2-path>\`), then \`cospan_wait\`.\n` +
    `- **CLI fallback (only if \`cospan\` MCP is unavailable)**:\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} send --to codex --effort low --timeout 10m --prompt '$imagegen <spec>...'\n` +
    `  ${cmd} wait <job-id> --timeout 10m\n` +
    `  \`\`\`\n\n`
  );
}

export function renderCodexDrawReference({ hostMode = 'agy', cospanBin } = {}) {
  const dispatchSection =
    hostMode === 'agy' ? renderAgyDispatchBlock() : renderMcpDispatchBlock(cospanBin);

  return (
    `# Raster Image Generation & Editing via Codex (\`$imagegen\`)\n\n` +
    `Delegate bitmap image generation and iterative editing to OpenAI Codex CLI's built-in ` +
    `\`image_gen\` tool (uses the user's ChatGPT subscription quota; no \`OPENAI_API_KEY\` ` +
    `required).\n\n` +
    `## 0. Scope & Opt-In Boundaries\n\n` +
    `- **Explicit opt-in only**: Use this path ONLY when the user explicitly asks to generate ` +
    `or edit an image via Codex / \`cospan-codex\`. Do not intercept generic image requests ` +
    `meant for the host's own image tools, and inside Codex itself invoke \`$imagegen\` ` +
    `directly instead of delegating through \`cospan\`.\n` +
    `- **Bitmap assets only**: Use for raster outputs (icons, logo explorations, illustrations, ` +
    `textures, product/UI mockups, diagrams, cutouts). Do NOT use when editing existing ` +
    `repo-native \`SVG\`/vector systems or building deterministic \`HTML/CSS/Canvas\` visuals.\n` +
    `- **Prerequisites & auth boundary**: Requires \`codex\` CLI signed in with ChatGPT ` +
    `(\`codex login status\`). Never run interactive \`codex login\` yourself, and never ` +
    `silently switch to API-key fallback scripts unless the user explicitly asks.\n\n` +
    dispatchSection +
    `## 2. File Paths, Dimensions, Transparency & Local Inputs\n\n` +
    `- **Explicit save path & non-destructive edits**: Built-in \`image_gen\` writes raw files ` +
    `under \`$CODEX_HOME/generated_images/<thread_id>/\`. Always give Codex an explicit ` +
    `absolute destination path to copy the final PNG to. Never overwrite an existing asset ` +
    `unless requested—save iterations to sibling paths such as \`asset-v2.png\`.\n` +
    `- **Aspect orientation vs exact pixel size**: Built-in \`image_gen\` natively renders ` +
    `aspect orientations (square, landscape, portrait) rather than arbitrary exact pixel ` +
    `dimensions. Ask for orientation by default; ask Codex to resample/resize afterwards only ` +
    `when an exact pixel dimension (e.g. \`1024x1024\` or \`512x512\`) is required.\n` +
    `- **Transparent backgrounds**: Ask built-in \`image_gen\` directly for a genuinely ` +
    `transparent background and preserved alpha channel. If a solid background is returned ` +
    `when alpha is required, refine via \`continue\` or prompt a flat uniform chroma/white ` +
    `backdrop and key it out locally.\n` +
    `- **Local reference or edit-target images**: Pass absolute file paths in the prompt and ` +
    `label each file's role (\`edit target\` vs \`style/composition reference\`). Instruct ` +
    `Codex to load local edit targets with \`view_image\` first so they enter thread context ` +
    `before calling \`image_gen\`.\n` +
    `- **Host verification**: Always inspect the saved PNG locally after \`wait\` completes ` +
    `before presenting it to the user.\n\n` +
    `## 3. Structured Prompting Checklist\n\n` +
    `Prefix the task with \`$imagegen\` and state concrete visual constraints without ` +
    `unrequested creative invention:\n\n` +
    `- **Asset type & intended use**: e.g. app icon, flat logo mark, landing hero, UI mockup.\n` +
    `- **Subject & framing**: focal metaphor/subject, centering, camera angle, negative space.\n` +
    `- **Style / medium**: e.g. minimalist flat vector-style mark, line icon, studio photo.\n` +
    `- **Palette & backdrop**: 1-3 specific colors/hex codes; solid backdrop vs transparent.\n` +
    `- **Text & negative constraints**: quote exact text verbatim, or state ` +
    `\`no text, no lettering, no watermark\`.\n` +
    `- **Edit invariants (for edits)**: \`change only <X>; keep <Y> unchanged\`.\n`
  );
}
