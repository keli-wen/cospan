export const TARGET_DOCS = {
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
  grok: {
    title: 'xAI Grok Build (`grok`)',
    defaultNote:
      'defaults to `inherit` so `grok -p` uses your configured ' +
      'Grok Build model without overriding `~/.grok`',
    effortsNote: 'supported `--effort`: `low`, `medium`, `high`, `xhigh`, `max`',
    strengths:
      'Delegate repository research, fast code review, real-time web/X research and ' +
      'verification, second-opinion debugging, or scoped implementation tasks to Grok Build CLI.',
  },
};

export function renderAgyTargetExtraSection(targetId) {
  if (targetId === 'codex') {
    return (
      `\n## 4. Raster Image Generation & Editing (Explicit Opt-In)\n\n` +
      `- **Only when the user explicitly asks to generate or edit an image via Codex / ` +
      `\`cospan-codex\`** (never hijack generic image requests meant for the host's default ` +
      `image tools): read \`references/draw.md\` (in this skill's directory) before ` +
      `dispatching.\n` +
      `- Covers built-in \`$imagegen\` (\`image_gen\` on ChatGPT subscription, no ` +
      `\`OPENAI_API_KEY\`), \`--effort low\` writable dispatch, transparent alpha output, ` +
      `and multi-turn visual edits via \`continue\`.\n`
    );
  }
  if (targetId === 'grok') {
    return (
      `\n## 4. Real-Time Web & X Research (Native Capability)\n\n` +
      `- Read \`references/live-search.md\` (in this skill's directory) before dispatching ` +
      `live web/X research (\`web_search\`, \`web_fetch\`, \`open_page\`, ` +
      `\`x_keyword_search\`, \`x_semantic_search\`, \`x_user_search\`, \`x_thread_fetch\`).\n` +
      `- **Built-in media tools (explicit opt-in only)**: use \`image_gen\`, ` +
      `\`image_to_video\`, or \`reference_to_video\` only when the user explicitly requests ` +
      `Grok media generation—never hijack generic image requests meant for the host's ` +
      `default image tools or \`cospan-codex\`.\n`
    );
  }
  return '';
}

export function renderCodexTargetExtraSection(targetId) {
  if (targetId === 'codex') {
    return (
      `\n## 3. Raster Image Generation & Editing (Non-Codex Hosts, Explicit Opt-In)\n\n` +
      `- **Only when running in a non-Codex host (such as Claude Code or DeepSeek Harness) ` +
      `and the user explicitly asks to generate or edit an image via Codex**: read ` +
      `\`<skill-dir>/references/draw.md\` (\`references/draw.md\` in this skill's directory) ` +
      `before dispatching. Inside Codex itself, use \`$imagegen\` directly instead of ` +
      `delegating.\n`
    );
  }
  if (targetId === 'grok') {
    return (
      `\n## 3. Real-Time Web & X Research (Native Capability)\n\n` +
      `- Read \`<skill-dir>/references/live-search.md\` (\`references/live-search.md\` in this ` +
      `skill's directory) before dispatching live web/X research or (only when explicitly ` +
      `requested via Grok) built-in media tools.\n`
    );
  }
  return '';
}
