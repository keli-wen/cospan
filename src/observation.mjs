import { StringDecoder } from 'node:string_decoder';

const SNAPSHOT_MAX_BYTES = 8192;

export const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

export function excerpt(value, limit, tail = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (bytes(text) <= limit) return { text, truncated: false };
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const n = Math.ceil((lo + hi) / 2);
    const part = tail ? chars.slice(-n).join('') : chars.slice(0, n).join('');
    if (bytes(part) <= limit) lo = n;
    else hi = n - 1;
  }
  const slice = tail ? chars.slice(-lo) : chars.slice(0, lo);
  return { text: lo ? slice.join('') : '', truncated: true };
}

function trimValueDeep(value, limit) {
  if (typeof value === 'string') return excerpt(value, limit).text;
  if (Array.isArray(value)) return value.map((item) => trimValueDeep(item, limit));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimValueDeep(item, limit)])
    );
  }
  return value;
}

function truncateTopLevelStrings(out) {
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string') out[key] = excerpt(out[key], 256).text;
  }
  for (const key of Object.keys(out.details || {})) {
    if (typeof out.details[key] === 'string')
      out.details[key] = excerpt(out.details[key], 512).text;
  }
  out.truncated = true;
  out.details_truncated = true;
}

function fallbackMinimalSnapshot(out) {
  for (const limit of [256, 128, 64]) {
    const compact = trimValueDeep(out, limit);
    if (bytes(compact) + 1 <= SNAPSHOT_MAX_BYTES) return compact;
  }
  return {
    job_id: excerpt(out.job_id || '', 256).text,
    target: excerpt(out.target || '', 64).text,
    status: out.status,
    result_file: excerpt(out.result_file || out.details?.result || '', 512).text,
    truncated: true,
    details_truncated: true,
  };
}

export function boundSnapshot(snapshot) {
  const out = structuredClone(snapshot);
  while (bytes(out) + 1 > SNAPSHOT_MAX_BYTES && out.recent_activities?.length) {
    out.recent_activities.shift();
    out.truncated = true;
  }
  if (bytes(out) + 1 > SNAPSHOT_MAX_BYTES) {
    out.latest_text = null;
    out.truncated = true;
  }
  if (bytes(out) + 1 > SNAPSHOT_MAX_BYTES) {
    truncateTopLevelStrings(out);
  }
  if (bytes(out) + 1 > SNAPSHOT_MAX_BYTES) {
    out.truncated = true;
    out.details_truncated = true;
    return fallbackMinimalSnapshot(out);
  }
  return out;
}

const VERIFICATION_CMD_RE =
  /\b(tests?|lint|build|type-?check|check|verify|validate|pytest|jest|vitest|tsc|eslint|ruff)\b/i;

function inferPhaseFromTool(toolName, inputPreview) {
  const t = String(toolName || '').toLowerCase();
  if (
    /file_change|write_file|edit_file|patch|multiedit|notebookedit/.test(t) ||
    /search_replace|hashline_edit|strreplace|^(write|edit|delete)$/.test(t)
  ) {
    return 'editing';
  }
  if (
    /command|run_terminal_cmd|bash|shell/.test(t) &&
    VERIFICATION_CMD_RE.test(String(inputPreview || ''))
  ) {
    return 'verifying';
  }
  return 'investigating';
}

function isStaleActivityStep(activities, stepIndex) {
  return (
    stepIndex !== null &&
    activities.length === 5 &&
    Number.isInteger(activities[0].step_index) &&
    stepIndex < activities[0].step_index
  );
}

function populateActivityItem(item, { tool, status, input, output, now }) {
  const toolEx = excerpt(tool || item.tool || 'unknown', 100);
  item.tool = toolEx.text;
  item.tool_truncated = toolEx.truncated || !!item.tool_truncated;
  item.updated_at = now;
  item.status = status || item.status || 'running';
  if (input !== undefined) {
    const inp = excerpt(input, 240);
    item.input_preview = inp.text;
    item.input_truncated = inp.truncated;
  }
  if (output !== undefined) {
    const out = excerpt(output, 240);
    item.output_preview = out.text;
    item.output_truncated = out.truncated;
  }
  item.truncated = !!(item.input_truncated || item.output_truncated || item.tool_truncated);
  const publicItem = { ...item };
  delete publicItem.key;
  if (bytes(publicItem) > 1024) {
    item.input_preview = '';
    item.output_preview = '';
    item.truncated = true;
  }
}

function buildUpdatedLatestText(current, { key, stepIndex, text, delta, status, now }) {
  const prev = current?.key === key ? current : null;
  if (typeof text === 'string' && text.length > 0) {
    const combined = delta ? (prev?.text || '') + text : text;
    const bounded = excerpt(combined, 1700, true);
    return {
      key,
      ...(stepIndex !== null ? { step_index: stepIndex } : {}),
      text: bounded.text,
      truncated: !!(prev?.truncated || bounded.truncated),
      updated_at: now,
      incomplete: status !== 'done',
      status,
    };
  }
  if (prev) {
    prev.incomplete = status !== 'done';
    prev.status = status;
    prev.updated_at = now;
  }
  return current;
}

/** Shared bounded activity/text tracker used by target drivers (`agy`, `codex`, etc.). */
export function createActivityTracker() {
  const data = {
    phase: 'starting',
    last_event_at: null,
    recent_activities: [],
    touched_files: [],
    latest_text: null,
    warnings: [],
  };

  const touch = () => {
    data.last_event_at = new Date().toISOString();
    return data.last_event_at;
  };

  const warn = (message) => {
    if (!data.warnings.includes(message) && data.warnings.length < 5) data.warnings.push(message);
  };

  const recordTouchedFile = (filePath) => {
    if (!filePath || typeof filePath !== 'string') return;
    const bounded = excerpt(filePath, 200).text;
    if (!data.touched_files.includes(bounded) && data.touched_files.length < 25) {
      data.touched_files.push(bounded);
    }
  };

  const upsertActivity = ({
    key,
    stepIndex = null,
    tool,
    status,
    input,
    output,
    touchedFiles = [],
  }) => {
    const now = touch();
    for (const f of touchedFiles) recordTouchedFile(f);
    let item = data.recent_activities.find((a) => a.key === key);
    if (!item) {
      if (isStaleActivityStep(data.recent_activities, stepIndex)) return;
      item = { key, ...(stepIndex !== null ? { step_index: stepIndex } : {}), started_at: now };
      data.recent_activities.push(item);
      if (data.recent_activities.length > 5) data.recent_activities.shift();
    }
    populateActivityItem(item, { tool, status, input, output, now });
    data.phase = inferPhaseFromTool(item.tool, item.input_preview);
    if (item.status === 'error') warn('Tool reported an explicit error; see raw output.');
  };

  const updateText = ({ key, stepIndex = null, text, delta = false, status = 'running' }) => {
    const now = touch();
    data.phase = 'responding';
    const prevStep = data.latest_text?.step_index;
    if (stepIndex !== null && prevStep !== undefined && stepIndex < prevStep) return;
    data.latest_text = buildUpdatedLatestText(data.latest_text, {
      key,
      stepIndex,
      text,
      delta,
      status,
      now,
    });
  };

  const snapshot = () => {
    const out = structuredClone(data);
    out.recent_activities.forEach((item) => delete item.key);
    if (out.latest_text) delete out.latest_text.key;
    return out;
  };

  return { touch, warn, recordTouchedFile, upsertActivity, updateText, snapshot };
}

/** Stream NDJSON line parser with bounded record memory. */
export function createParser(onEvent, onWarning, maxRecord = 8 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pendingBytes = 0;
  let dropping = false;
  const consume = (text) => {
    for (const fragment of text.split(/(?<=\n)/)) {
      const end = fragment.endsWith('\n');
      if (!dropping) {
        const fragmentBytes = Buffer.byteLength(fragment);
        if (pendingBytes + fragmentBytes > maxRecord) {
          pending = '';
          pendingBytes = 0;
          dropping = true;
          onWarning('Oversized record omitted from projection; see raw output.');
        } else {
          pending += fragment;
          pendingBytes += fragmentBytes;
        }
      }
      if (end) {
        if (!dropping && pending.trim()) {
          let event;
          try {
            event = JSON.parse(pending);
          } catch {
            onWarning('Malformed record retained in raw output.');
          }
          if (event && typeof event === 'object') onEvent(event);
        }
        pending = '';
        pendingBytes = 0;
        dropping = false;
      }
    }
  };
  return {
    write: (chunk) => consume(decoder.write(chunk)),
    end: () => consume(decoder.end() + '\n'),
  };
}
