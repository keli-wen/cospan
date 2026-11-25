import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callTool, TOOLS } from '../src/mcp/tools.mjs';
import { cancelBoardJob, listWorkspaceBoard, readBoardJobDetail } from '../src/sidebar-state.mjs';
import { registerCospanHttpApi } from './http-api.mjs';

const DSH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DSH_DIR, '..');
const COSPAN_BIN = path.join(REPO_ROOT, 'bin', 'cospan.mjs');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');
const PROVIDER_NAME = 'cospan';
const BUNDLED_SKILL_RANK = 600;

export const name = 'cospan';

function parseSkillMarkdown(raw, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    return { name: fallbackName, description: `Cospan skill (${fallbackName})`, body: raw };
  }
  const [, frontmatter, body] = match;
  const descMatch = /^description:\s*(.+)$/mu.exec(frontmatter);
  const userInvocable = !/^user-invocable:\s*false\s*$/mu.test(frontmatter);
  return {
    name: fallbackName,
    description: descMatch
      ? descMatch[1].trim().replace(/^["']|["']$/gu, '')
      : `Cospan skill (${fallbackName})`,
    userInvocable,
    body,
  };
}

function normalizeSkillPath(p) {
  return String(p || '').replaceAll('\\', '/');
}

function hydrateSkillBody(body, skillDir) {
  return body
    .replaceAll('<skill-dir>', normalizeSkillPath(skillDir))
    .replaceAll('<plugin-root>', normalizeSkillPath(REPO_ROOT));
}

function loadSkillCandidates() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const candidates = [];
  for (const entry of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_ROOT, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const exposedName = entry.name.startsWith('cospan-') ? entry.name : `cospan-${entry.name}`;
      const parsed = parseSkillMarkdown(raw, exposedName);
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        invocation: {
          modelInvocable: true,
          userInvocable: parsed.userInvocable !== false,
        },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: skillDir },
        rank: BUNDLED_SKILL_RANK,
        locator: pathToFileURL(skillFile),
        _skillFile: skillFile,
      });
    } catch {}
  }
  return candidates;
}

function resolveSessionCwd(ctx, agent) {
  const fromHeader = agent?.session?.header?.cwd;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader;
  const fromPolicy = ctx.get?.('sandboxPolicy')?.workspaceRoot;
  if (typeof fromPolicy === 'string' && fromPolicy.trim()) return fromPolicy;
  return null;
}

function resolveSessionId(agent) {
  const direct = agent?.session?.id || agent?.session?.header?.id || null;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

function buildDshToolParameters(inputSchema) {
  const required = (inputSchema.required || []).filter((key) => key !== 'cwd');
  return {
    type: 'object',
    additionalProperties: false,
    properties: inputSchema.properties || {},
    ...(required.length ? { required } : {}),
  };
}

function registerCospanTool(toolCtx, toolDef) {
  toolCtx.tools.register({
    name: toolDef.name,
    description: toolDef.description,
    parameters: buildDshToolParameters(toolDef.inputSchema),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          output: { type: 'string' },
        },
        required: ['ok', 'output'],
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    async execute(args, exec) {
      const cwd = args?.cwd || resolveSessionCwd(toolCtx, exec?.agent);
      if (!cwd) {
        return {
          ok: false,
          output: 'Error: Could not resolve workspace cwd from active DSH session.',
        };
      }
      const sessionId = resolveSessionId(exec?.agent);
      const env = {
        COSPAN_CALLER_HOST: 'dsh',
        ...(sessionId ? { COSPAN_CALLER_SESSION_ID: sessionId } : {}),
      };
      const res = await callTool(COSPAN_BIN, toolDef.name, { ...args, cwd }, { env });
      const text = res.content?.map((c) => c.text).join('\n') || '';
      return { ok: !res.isError, output: text };
    },
  });
}

function parseCtlInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return { ok: true, payload: { action: 'list' } };
  if (trimmed.startsWith('{')) {
    try {
      return { ok: true, payload: JSON.parse(trimmed) };
    } catch (err) {
      return { ok: false, error: `Invalid JSON payload for /cospan-ctl: ${err.message}` };
    }
  }
  const [action = 'list', ...rest] = trimmed.split(/\s+/u);
  return { ok: true, payload: { action, id: rest.join(' ') } };
}

function extractCtlJobId(payload) {
  return String(payload?.id || payload?.jobId || '').trim();
}

function ctlJsonResponse(kind, body) {
  return { kind, text: JSON.stringify(body) };
}

async function dispatchCtlAction(cwd, sessionId, payload) {
  const action = String(payload?.action || 'list').trim();
  if (action === 'list') {
    return ctlJsonResponse('success', {
      ok: true,
      ...listWorkspaceBoard(cwd, { callerSessionId: sessionId }),
    });
  }
  if (action === 'detail') {
    const id = extractCtlJobId(payload);
    if (!id) return ctlJsonResponse('error', { ok: false, error: 'Detail requires a job id.' });
    const detail = readBoardJobDetail(cwd, id);
    return ctlJsonResponse(detail.ok ? 'success' : 'error', detail);
  }
  if (action === 'cancel') {
    const id = extractCtlJobId(payload);
    if (!id) return ctlJsonResponse('error', { ok: false, error: 'Cancel requires a job id.' });
    const res = await cancelBoardJob(cwd, id);
    return ctlJsonResponse(res.ok ? 'success' : 'error', res);
  }
  return ctlJsonResponse('error', { ok: false, error: `Unknown /cospan-ctl action "${action}"` });
}

function registerCospanCtlCommand(cmdCtx) {
  cmdCtx.commands.register({
    name: 'cospan-ctl',
    description: 'Query or cancel Cospan workspace delegation jobs for the sidebar UI',
    input: {
      hint: '{"action":"list"}',
    },
    recordInput: false,
    async handler({ agent, rawInput }) {
      const cwd = resolveSessionCwd(cmdCtx, agent);
      if (!cwd) {
        return {
          kind: 'error',
          text: JSON.stringify({
            ok: false,
            error: 'Could not resolve workspace cwd from active DSH session.',
          }),
        };
      }
      const parsed = parseCtlInput(rawInput);
      if (!parsed.ok) {
        return {
          kind: 'error',
          text: JSON.stringify({ ok: false, error: parsed.error }),
        };
      }
      const sessionId = resolveSessionId(agent);
      return dispatchCtlAction(cwd, sessionId, parsed.payload);
    },
  });
}

export function apply(ctx) {
  ctx.inject(['skills'], (skillCtx) => {
    const provider = {
      name: PROVIDER_NAME,
      list: async () => loadSkillCandidates(),
      async get(candidate) {
        const skillFile = candidate._skillFile;
        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = parseSkillMarkdown(raw, candidate.name);
        const skillDir = candidate.resourceBase?.path || path.dirname(skillFile);
        return {
          name: parsed.name,
          description: parsed.description,
          invocation: candidate.invocation,
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: candidate.resourceBase,
          content: hydrateSkillBody(parsed.body, skillDir),
        };
      },
    };
    skillCtx.effect(
      () => skillCtx.skills.registerProvider(() => provider),
      'cospan: skills provider'
    );
  });

  ctx.inject(['tools'], (toolCtx) => {
    for (const toolDef of TOOLS) {
      registerCospanTool(toolCtx, toolDef);
    }
  });

  ctx.inject(['commands'], (cmdCtx) => {
    registerCospanCtlCommand(cmdCtx);
  });

  ctx.inject(['webServer'], (webCtx) => {
    registerCospanHttpApi(webCtx);
  });
}

export default { name, apply };
