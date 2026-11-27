import { cliCommandPrefix } from './installer-templates.mjs';

function renderAgyDispatchBlock(cospanBin) {
  const cmd = cliCommandPrefix(cospanBin);
  return (
    `## 1. Dispatch & Zero-Polling Wait (Antigravity Host)\n\n` +
    `- **Read-only by default for research**: Pass \`--readonly\` whenever verifying docs, ` +
    `issues, releases, or live web/X state without modifying workspace files.\n` +
    `- **Model & effort**: Omit \`--model\` (\`inherit\`) or pass \`--model fast\` verbatim ` +
    `(never hardcode versioned model IDs); pass \`--effort low\` for quick lookups or ` +
    `\`high\` for deeper synthesis.\n` +
    `- **Launch & collect without polling**:\n` +
    `  \`\`\`bash\n` +
    `  # 1) Launch detached job (WaitMsBeforeAsync: 5000)\n` +
    `  ${cmd} send --to grok --readonly --effort low --timeout 10m \\\n` +
    `    --prompt 'Search the live web and X for <topic>. Cite exact URLs and quotes.'\n\n` +
    `  # 2) Background wait immediately (WaitMsBeforeAsync: 500), then end turn\n` +
    `  ${cmd} wait <job-id> --timeout 10m\n` +
    `  \`\`\`\n` +
    `- **Multi-turn follow-up in the same research thread (\`continue\`)**:\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} continue --id <job-id> --effort low --timeout 10m \\\n` +
    `    --prompt 'Verify <claim> against primary source URLs and quote exact dates.'\n` +
    `  \`\`\`\n\n`
  );
}

function renderMcpDispatchBlock(cospanBin) {
  const cmd = cliCommandPrefix(cospanBin);
  return (
    `## 1. Dispatch & Collection (MCP Hosts: Claude Code / DeepSeek Harness)\n\n` +
    `- **Read-only by default for research**: Set \`readonly: true\` whenever verifying docs, ` +
    `issues, releases, or live web/X state without modifying workspace files.\n` +
    `- **Model & effort**: Omit \`model\` (\`inherit\`) or pass \`model: "fast"\` verbatim ` +
    `(never hardcode versioned model IDs); pass \`effort: "low"\` for quick lookups or ` +
    `\`"high"\` for deeper synthesis.\n` +
    `- **Dispatch via \`cospan_send\` + \`cospan_wait\`**:\n` +
    `  1. Call \`cospan_send\` with \`{ "cwd": "<workspace>", "to": "grok", ` +
    `"readonly": true, "effort": "low", "timeout": "10m", "prompt": "Search the live web and X ` +
    `for <topic>. Cite exact URLs, dates, and quotes." }\`.\n` +
    `  2. Call \`cospan_wait\` with \`{ "cwd": "<workspace>", "id": "<job_id>", ` +
    `"timeout": "10m" }\`.\n` +
    `- **Multi-turn follow-up in the same research thread (\`cospan_continue\`)**:\n` +
    `  Call \`cospan_continue\` (\`id: "<job_id>"\`, \`effort: "low"\`, delta \`prompt\`), then ` +
    `call \`cospan_wait\` on the new job ID.\n` +
    `- **CLI fallback (only if \`cospan\` MCP is unavailable)**:\n` +
    `  \`\`\`bash\n` +
    `  ${cmd} send --to grok --readonly --effort low --timeout 10m --prompt '<topic>'\n` +
    `  ${cmd} wait <job-id> --timeout 10m\n` +
    `  \`\`\`\n\n`
  );
}

export function renderGrokSearchReference({ hostMode = 'agy', cospanBin } = {}) {
  const dispatchSection =
    hostMode === 'agy' ? renderAgyDispatchBlock(cospanBin) : renderMcpDispatchBlock(cospanBin);

  return (
    `# Real-Time Web & X Research via Grok Build\n\n` +
    `Delegate live web verification and real-time X research to xAI Grok Build CLI's built-in ` +
    `search tools.\n\n` +
    `## 0. Scope & Capability Boundaries\n\n` +
    `- **Native web & page tools**: \`web_search\`, \`web_fetch\`, \`open_page\`, and ` +
    `\`open_page_with_find\`.\n` +
    `- **Native live X (Twitter) tools**: \`x_keyword_search\`, \`x_semantic_search\`, ` +
    `\`x_user_search\`, and \`x_thread_fetch\`.\n` +
    `- **Prefer \`--readonly\` / \`readonly: true\`**: Keep workspace writes disabled whenever ` +
    `gathering external facts, release notes, issues, or documentation checks.\n` +
    `- **Prerequisites & auth boundary**: Requires a signed-in \`grok\` CLI (\`grok login\`) ` +
    `and network access. Do not pass \`--disable-web-search\`, and never run interactive ` +
    `\`grok login\` from an agent turn.\n` +
    `- **Built-in media tools (explicit opt-in only)**: Grok Build also exposes ` +
    `\`image_gen\`, \`image_to_video\`, and \`reference_to_video\`. Use these ONLY when the ` +
    `user explicitly asks to generate media via Grok / \`cospan-grok\` (omit \`--readonly\` ` +
    `when saving files to workspace paths), and never hijack generic image requests meant for ` +
    `the host's default image tools or \`cospan-codex\`'s \`$imagegen\`.\n\n` +
    dispatchSection +
    `## 2. Citation & Evidence Discipline\n\n` +
    `- **Primary links & timestamps**: Require exact URLs, post/thread links, publication ` +
    `dates/timestamps, and verbatim quotes from sources.\n` +
    `- **Source separation**: Keep verified external facts (URL + date) distinct from local ` +
    `repository observations (\`file:line\`) and inferences.\n` +
    `- **No silent fallbacks**: Never mask a failed or offline lookup with guesswork; report ` +
    `missing, blocked, or unverified items explicitly.\n`
  );
}
