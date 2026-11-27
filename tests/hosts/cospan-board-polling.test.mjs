import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../helpers/paths.mjs';

function createFakeDom() {
  const docListeners = new Map();
  const makeEl = (tag) => {
    const node = {
      tagName: tag,
      className: '',
      textContent: '',
      hidden: false,
      isConnected: true,
      rects: [{ width: 320, height: 600 }],
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      getClientRects() {
        return node.rects;
      },
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
    listenerCount(type) {
      return docListeners.get(type)?.size || 0;
    },
  };
  return { doc, container: makeEl('div') };
}

async function withFakeBoardEnv(fn) {
  const { doc, container } = createFakeDom();
  const timeouts = new Map();
  const observers = [];
  let nextTimerId = 1;
  const saved = {
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    CospanBoard: globalThis.CospanBoard,
  };
  globalThis.document = doc;
  globalThis.IntersectionObserver = class FakeIntersectionObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
      this.observed = [];
      observers.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger(isIntersecting) {
      if (!this.disconnected) this.cb([{ isIntersecting }]);
    }
  };
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
    await fn({ CospanBoard: globalThis.CospanBoard, doc, container, timeouts, observers });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('CospanBoard pauses when hidden/collapsed and resumes via visibility & observer', async () => {
  await withFakeBoardEnv(async ({ CospanBoard, doc, container, timeouts, observers }) => {
    let notify;
    const pending = [];
    let fetchCount = 0;
    const board = CospanBoard.mount(container, {
      host: 'dsh',
      getInitialState: () => ({ workspaceLabel: '', sessionId: 's1' }),
      subscribe: (cb) => {
        notify = cb;
        return () => {};
      },
      fetchBoard: () => {
        fetchCount += 1;
        return new Promise((resolve) => pending.push(resolve));
      },
    });
    assert.equal(fetchCount, 1);
    assert.equal(observers.length, 1);

    // Hide document while fetch #1 is in flight and switch session: must NOT stall inFlight
    doc.hidden = true;
    doc.emit('visibilitychange');
    notify({ sessionId: 's2' });
    pending.shift()({ workspace: '/w1', caller_session_id: 's1', jobs: [] });
    await new Promise((r) => process.nextTick(r));
    assert.equal(timeouts.size, 0);
    assert.equal(fetchCount, 1);

    // Showing document resumes immediately with fetch #2 and schedules 8s idle poll
    doc.hidden = false;
    doc.emit('visibilitychange');
    assert.equal(fetchCount, 2);
    pending.shift()({ workspace: '/w2', caller_session_id: 's2', jobs: [] });
    await new Promise((r) => process.nextTick(r));
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 8000);

    // Collapsing sidebar (empty rects + observer not intersecting) pauses polling
    container.rects = [];
    observers[0].trigger(false);
    assert.equal(timeouts.size, 0);

    // Expanding sidebar resumes immediately via IntersectionObserver and uses 2s running poll
    container.rects = [{ width: 320, height: 600 }];
    observers[0].trigger(true);
    assert.equal(fetchCount, 3);
    pending.shift()({
      workspace: '/w2',
      caller_session_id: 's2',
      jobs: [{ id: 'j1', target: 'codex', status: 'running', started_at: '2026-01-01T00:00:00Z' }],
    });
    await new Promise((r) => process.nextTick(r));
    assert.equal([...timeouts.values()].find((t) => !t.interval)?.ms, 2000);

    // Disconnecting container also prevents polling
    container.isConnected = false;
    observers[0].trigger(false);
    assert.equal(timeouts.size, 0);

    board.destroy();
    assert.equal(timeouts.size, 0);
    assert.equal(observers[0].disconnected, true);
    assert.equal(doc.listenerCount('visibilitychange'), 0);
  });
});
