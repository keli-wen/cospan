import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');

function createFakeDom() {
  const docListeners = new Map();
  const makeEl = (tag) => {
    const node = {
      tagName: tag,
      className: '',
      textContent: '',
      hidden: false,
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        if (!child) return child;
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      append(...items) {
        for (const it of items) node.appendChild(it);
      },
      insertBefore(child, ref) {
        const idx = node.children.indexOf(ref);
        child.parentNode = node;
        if (idx === -1) node.children.push(child);
        else node.children.splice(idx, 0, child);
        return child;
      },
      replaceWith(next) {
        if (!node.parentNode) return;
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) {
          next.parentNode = node.parentNode;
          node.parentNode.children[idx] = next;
        }
      },
      remove() {
        if (!node.parentNode) return;
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) node.parentNode.children.splice(idx, 1);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      classList: { add() {} },
      set innerHTML(_v) {
        node.firstChild = makeEl('svg');
      },
      firstChild: null,
    };
    return node;
  };
  const doc = {
    hidden: false,
    createElement: makeEl,
    createTextNode: (t) => ({ textContent: String(t) }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of docListeners.get(type) || []) fn();
    },
  };
  return { doc, container: makeEl('div') };
}

async function withFakeBoardEnv(fn) {
  const { doc, container } = createFakeDom();
  const timeouts = new Map();
  let nextTimerId = 1;
  const saved = {
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    CospanBoard: globalThis.CospanBoard,
  };
  globalThis.document = doc;
  globalThis.setTimeout = (cb, ms) => {
    const id = nextTimerId++;
    timeouts.set(id, { cb, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => timeouts.delete(id);
  globalThis.setInterval = (cb, ms) => {
    const id = nextTimerId++;
    timeouts.set(id, { cb, ms, interval: true });
    return id;
  };
  globalThis.clearInterval = (id) => timeouts.delete(id);

  const boardSrc = fs.readFileSync(path.join(ROOT_DIR, 'src', 'ui', 'cospan-board.js'), 'utf8');
  new Function(boardSrc)();
  try {
    await fn({ CospanBoard: globalThis.CospanBoard, doc, container, timeouts });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('CospanBoard preserves default intervals for agy and honors DSH overrides', async () => {
  await withFakeBoardEnv(async ({ CospanBoard, container, timeouts }) => {
    let agyJobs = [];
    const agyBoard = CospanBoard.mount(container, {
      host: 'agy',
      getInitialState: () => ({ workspaceLabel: '/repo', sessionId: 'c1' }),
      fetchBoard: async () => ({ workspace: '/repo', caller_session_id: 'c1', jobs: agyJobs }),
    });
    await new Promise((r) => process.nextTick(r));
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 8000);
    agyJobs = [
      { id: 'j1', target: 'codex', status: 'running', started_at: '2026-01-01T00:00:00Z' },
    ];
    await agyBoard.refresh();
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 2000);
    agyBoard.destroy();
    assert.equal(timeouts.size, 0);
  });
});

test('CospanBoard pauses polling on hide and discards stale session responses', async () => {
  await withFakeBoardEnv(async ({ CospanBoard, doc, container, timeouts }) => {
    let notify;
    const pendingResolvers = [];
    let fetchCount = 0;
    const dshBoard = CospanBoard.mount(container, {
      host: 'dsh',
      idlePollMs: 30000,
      getInitialState: () => ({ workspaceLabel: '', sessionId: 's1', visible: true }),
      subscribe: (cb) => {
        notify = cb;
        return () => {};
      },
      fetchBoard: () => {
        fetchCount += 1;
        return new Promise((resolve) => pendingResolvers.push(resolve));
      },
    });
    assert.equal(fetchCount, 1);

    // Hide while fetch #1 is still in-flight: resolving #1 must NOT restart polling
    notify({ visible: false });
    pendingResolvers.shift()({ workspace: '/w1', caller_session_id: 's1', jobs: [] });
    await new Promise((r) => process.nextTick(r));
    assert.equal(timeouts.size, 0);

    // Re-show triggers fetch #2; switching session triggers #3 and supersedes #2
    notify({ visible: true });
    assert.equal(fetchCount, 2);
    notify({ sessionId: 's2' });
    assert.equal(fetchCount, 3);
    const resolveStaleS1 = pendingResolvers.shift();
    const resolveFreshS2 = pendingResolvers.shift();

    resolveFreshS2({ workspace: '/w2', caller_session_id: 's2', jobs: [] });
    await new Promise((r) => process.nextTick(r));
    assert.equal([...timeouts.values()].filter((t) => !t.interval).length, 1);
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 30000);

    // Late response from s1 must be discarded without duplicating or resetting timers
    resolveStaleS1({
      workspace: '/w1',
      caller_session_id: 's1',
      jobs: [{ id: 'stale', target: 'codex', status: 'running' }],
    });
    await new Promise((r) => process.nextTick(r));
    assert.equal([...timeouts.values()].filter((t) => !t.interval).length, 1);
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 30000);

    // Hiding the host window pauses polling immediately
    doc.hidden = true;
    doc.emit('visibilitychange');
    assert.equal(timeouts.size, 0);

    dshBoard.destroy();
    assert.equal(timeouts.size, 0);
  });
});
