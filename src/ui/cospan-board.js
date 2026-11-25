/* global document, navigator, localStorage, setTimeout, clearTimeout, setInterval, clearInterval */
const CospanBoard = (function () {
  const RUNNING_POLL_MS = 2000;
  const IDLE_POLL_MS = 8000;
  const TICK_MS = 1000;
  const LANG_STORAGE_KEY = 'cospan-board-lang';
  const CAP_STORAGE_KEY = 'cospan-board-cap-open';

  const I18N = {
    zh: {
      capSub: '跨宿主异步编排',
      capHintCopy: '点击任意工具复制指令',
      capHintInsert: '点击任意工具填入下方输入框',
      tasksTitle: '委派任务',
      scopeSession: '本会话',
      scopeWorkspace: '工作区',
      emptySessionTitle: '当前会话暂无委派任务',
      emptySessionSub: '同工作区其他会话仍有委派记录。',
      emptyWorkspaceTitle: '当前工作区暂无委派任务',
      emptyWorkspaceSub: '通过 cospan 向 agy / codex / claude / dsh 派发的任务会实时显示在这里。',
      waitingSessionTitle: '等待打开会话',
      showWorkspaceBtn: (n) => `查看工作区全部 (${n})`,
      queryLabel: '提问',
      replyLabel: '回复',
      expandText: '展开阅读',
      collapseText: '收起',
      copyText: '复制',
      copiedInline: '已复制',
      insertedInline: '已填入',
      loadingDetail: '正在读取记录…',
      noReplyYet: '正在等待目标助手输出…',
      liveWaiting: '等待首个工具调用…',
      continueCopy: '复制续接命令',
      continueInsert: '继续追问 · 填入输入框',
      cancelBtn: '停止任务',
      cancelingBtn: '正在停止…',
      readOnly: '只读',
      thisSession: '本会话',
      justNow: '刚刚',
      minsAgo: (m) => `${m} 分钟前`,
      todayAt: (hm) => `今天 ${hm}`,
      yesterdayAt: (hm) => `昨天 ${hm}`,
      refreshTip: '刷新当前工作区委派记录',
    },
    en: {
      capSub: 'Cross-harness delegation',
      capHintCopy: 'Click any target to copy its command',
      capHintInsert: 'Click any target to insert into input',
      tasksTitle: 'Tasks',
      scopeSession: 'Session',
      scopeWorkspace: 'Workspace',
      emptySessionTitle: 'No tasks in this session',
      emptySessionSub: 'Tasks delegated from other sessions exist in this workspace.',
      emptyWorkspaceTitle: 'No delegated tasks yet',
      emptyWorkspaceSub: 'Tasks dispatched via cospan to agy, codex, claude, and dsh appear here.',
      waitingSessionTitle: 'Waiting for active session',
      showWorkspaceBtn: (n) => `Show workspace (${n})`,
      queryLabel: 'Query',
      replyLabel: 'Reply',
      expandText: 'Expand',
      collapseText: 'Collapse',
      copyText: 'Copy',
      copiedInline: 'Copied',
      insertedInline: 'Inserted',
      loadingDetail: 'Loading record…',
      noReplyYet: 'Waiting for target output…',
      liveWaiting: 'Waiting for first tool call…',
      continueCopy: 'Copy continue',
      continueInsert: 'Continue in input',
      cancelBtn: 'Cancel',
      cancelingBtn: 'Canceling…',
      readOnly: 'read-only',
      thisSession: 'this session',
      justNow: 'Just now',
      minsAgo: (m) => `${m}m ago`,
      todayAt: (hm) => `Today ${hm}`,
      yesterdayAt: (hm) => `Yesterday ${hm}`,
      refreshTip: 'Refresh workspace delegations',
    },
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgNode(markup) {
    const wrap = document.createElement('span');
    wrap.innerHTML = markup;
    return wrap.firstChild;
  }

  function pixelRowsSvg(rows, width, height, viewBox) {
    const rects = [];
    for (let y = 0; y < rows.length; y += 1) {
      const row = rows[y];
      let x = 0;
      while (x < row.length) {
        if (row[x] !== 'X') {
          x += 1;
          continue;
        }
        let end = x;
        while (end < row.length && row[end] === 'X') end += 1;
        rects.push(`<rect x="${x * 2}" y="${y * 2}" width="${(end - x) * 2}" height="2"/>`);
        x = end;
      }
    }
    return (
      `<svg width="${width}" height="${height}" viewBox="${viewBox}" shape-rendering="crispEdges" ` +
      `fill="currentColor" aria-hidden="true" style="flex:none;display:block">${rects.join('')}</svg>`
    );
  }

  const PIXEL_COSPAN_SVG =
    '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" shape-rendering="crispEdges" aria-hidden="true">' +
    '<g fill="#3B35B5"><rect x="3" y="1" width="14" height="1"/><rect x="2" y="2" width="16" height="1"/>' +
    '<rect x="0" y="3" width="20" height="4"/><rect x="5" y="7" width="10" height="1"/>' +
    '<rect x="7" y="8" width="6" height="1"/><rect x="8" y="9" width="4" height="1"/>' +
    '<rect x="9" y="10" width="2" height="1"/><rect x="0" y="13" width="2" height="1"/>' +
    '<rect x="18" y="13" width="2" height="1"/><rect x="0" y="14" width="4" height="1"/>' +
    '<rect x="16" y="14" width="4" height="1"/><rect x="0" y="15" width="5" height="1"/>' +
    '<rect x="15" y="15" width="5" height="1"/><rect x="0" y="16" width="6" height="1"/>' +
    '<rect x="14" y="16" width="6" height="1"/><rect x="1" y="17" width="5" height="1"/>' +
    '<rect x="14" y="17" width="5" height="1"/><rect x="2" y="18" width="5" height="1"/>' +
    '<rect x="13" y="18" width="5" height="1"/><rect x="3" y="19" width="4" height="1"/>' +
    '<rect x="13" y="19" width="4" height="1"/></g>' +
    '<g fill="#4C46CC"><rect x="3" y="0" width="14" height="1"/><rect x="2" y="1" width="1" height="1"/>' +
    '<rect x="17" y="1" width="1" height="1"/><rect x="1" y="2" width="1" height="1"/>' +
    '<rect x="18" y="2" width="1" height="1"/></g>' +
    '<g fill="#00C48C"><rect x="0" y="7" width="5" height="1"/><rect x="0" y="8" width="7" height="1"/>' +
    '<rect x="0" y="9" width="8" height="1"/><rect x="0" y="10" width="9" height="1"/>' +
    '<rect x="0" y="11" width="10" height="1"/><rect x="0" y="12" width="9" height="1"/>' +
    '<rect x="2" y="13" width="6" height="1"/><rect x="4" y="14" width="4" height="1"/>' +
    '<rect x="5" y="15" width="3" height="1"/><rect x="6" y="16" width="1" height="2"/></g>' +
    '<g fill="#00B4FF"><rect x="15" y="7" width="5" height="1"/><rect x="13" y="8" width="7" height="1"/>' +
    '<rect x="12" y="9" width="8" height="1"/><rect x="11" y="10" width="9" height="1"/>' +
    '<rect x="10" y="11" width="10" height="1"/><rect x="11" y="12" width="9" height="1"/>' +
    '<rect x="12" y="13" width="6" height="1"/><rect x="12" y="14" width="4" height="1"/>' +
    '<rect x="12" y="15" width="3" height="1"/><rect x="13" y="16" width="1" height="2"/></g>' +
    '<g fill="#FFE03D"><rect x="9" y="12" width="2" height="1"/><rect x="8" y="13" width="4" height="3"/>' +
    '<rect x="7" y="16" width="6" height="4"/></g></svg>';

  const TARGET_PIXEL_SVGS = {
    agy:
      '<svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
      '<g fill="#3D85FC"><rect x="9" y="8" width="1" height="1"/><rect x="10" y="9" width="1" height="1"/>' +
      '<rect x="10" y="10" width="2" height="1"/><rect x="11" y="11" width="2" height="1"/>' +
      '<rect x="12" y="12" width="2" height="1"/></g>' +
      '<g fill="#64B6F5"><rect x="6" y="8" width="1" height="1"/><rect x="4" y="10" width="2" height="1"/>' +
      '<rect x="4" y="11" width="1" height="1"/><rect x="2" y="12" width="2" height="1"/></g>' +
      '<g fill="#85C64E"><rect x="5" y="4" width="1" height="1"/><rect x="5" y="5" width="2" height="1"/>' +
      '<rect x="4" y="6" width="2" height="1"/><rect x="4" y="7" width="1" height="1"/><rect x="4" y="8" width="1" height="1"/></g>' +
      '<g fill="#F6912E"><rect x="7" y="2" width="2" height="1"/><rect x="7" y="3" width="2" height="1"/>' +
      '<rect x="7" y="4" width="2" height="1"/><rect x="8" y="5" width="1" height="1"/></g>' +
      '<g fill="#955FA5"><rect x="9" y="6" width="3" height="1"/><rect x="11" y="7" width="1" height="1"/>' +
      '<rect x="11" y="8" width="1" height="1"/></g>' +
      '<g fill="#EF5441"><rect x="9" y="3" width="1" height="1"/><rect x="9" y="4" width="2" height="1"/>' +
      '<rect x="9" y="5" width="2" height="1"/></g>' +
      '<g fill="#6C73D8"><rect x="9" y="7" width="2" height="1"/><rect x="10" y="8" width="1" height="1"/>' +
      '<rect x="11" y="9" width="1" height="1"/><rect x="12" y="10" width="1" height="1"/></g>' +
      '<g fill="#D9B031"><rect x="6" y="3" width="1" height="1"/><rect x="6" y="4" width="1" height="1"/>' +
      '<rect x="7" y="5" width="1" height="1"/></g>' +
      '<g fill="#43AEAA"><rect x="6" y="6" width="1" height="1"/><rect x="5" y="7" width="2" height="1"/>' +
      '<rect x="5" y="8" width="1" height="1"/><rect x="4" y="9" width="2" height="1"/>' +
      '<rect x="3" y="10" width="1" height="1"/><rect x="3" y="11" width="1" height="1"/></g></svg>',
    codex:
      '<svg width="16" height="16" viewBox="0 0 20 20" shape-rendering="crispEdges" aria-hidden="true">' +
      '<g fill="#B1A7FF"><rect x="6" y="1" width="4" height="1"/><rect x="5" y="2" width="6" height="1"/>' +
      '<rect x="5" y="3" width="10" height="1"/></g>' +
      '<g fill="#8FA2FF"><rect x="4" y="4" width="12" height="1"/><rect x="2" y="5" width="15" height="1"/>' +
      '<rect x="1" y="6" width="16" height="1"/><rect x="1" y="7" width="16" height="1"/></g>' +
      '<g fill="#6E89FF"><rect x="1" y="8" width="5" height="1"/><rect x="8" y="8" width="9" height="1"/>' +
      '<rect x="1" y="9" width="6" height="1"/><rect x="9" y="9" width="9" height="1"/>' +
      '<rect x="2" y="10" width="6" height="1"/><rect x="10" y="10" width="9" height="1"/>' +
      '<rect x="3" y="11" width="4" height="1"/><rect x="9" y="11" width="10" height="1"/></g>' +
      '<g fill="#5064FF"><rect x="3" y="12" width="3" height="1"/><rect x="8" y="12" width="3" height="1"/>' +
      '<rect x="15" y="12" width="4" height="1"/><rect x="3" y="13" width="16" height="1"/>' +
      '<rect x="3" y="14" width="15" height="1"/><rect x="4" y="15" width="12" height="1"/></g>' +
      '<g fill="#3941FF"><rect x="5" y="16" width="10" height="1"/><rect x="9" y="17" width="6" height="1"/>' +
      '<rect x="10" y="18" width="4" height="1"/></g>' +
      '<g fill="#FFFFFF"><rect x="6" y="8" width="2" height="1"/><rect x="7" y="9" width="2" height="1"/>' +
      '<rect x="8" y="10" width="2" height="1"/><rect x="7" y="11" width="2" height="1"/>' +
      '<rect x="6" y="12" width="2" height="1"/><rect x="11" y="12" width="4" height="1"/></g></svg>',
    claude:
      '<svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
      '<g fill="#D97757"><rect x="2" y="3" width="12" height="1"/><rect x="2" y="4" width="12" height="1"/>' +
      '<rect x="2" y="5" width="2" height="1"/><rect x="5" y="5" width="6" height="1"/>' +
      '<rect x="12" y="5" width="2" height="1"/><rect x="2" y="6" width="2" height="1"/>' +
      '<rect x="5" y="6" width="6" height="1"/><rect x="12" y="6" width="2" height="1"/>' +
      '<rect x="0" y="7" width="16" height="1"/><rect x="0" y="8" width="16" height="1"/>' +
      '<rect x="2" y="9" width="12" height="1"/><rect x="2" y="10" width="12" height="1"/>' +
      '<rect x="3" y="11" width="1" height="1"/><rect x="5" y="11" width="1" height="1"/>' +
      '<rect x="10" y="11" width="1" height="1"/><rect x="12" y="11" width="1" height="1"/>' +
      '<rect x="3" y="12" width="1" height="1"/><rect x="5" y="12" width="1" height="1"/>' +
      '<rect x="10" y="12" width="1" height="1"/><rect x="12" y="12" width="1" height="1"/></g></svg>',
    dsh:
      '<svg width="17" height="15" viewBox="0 0 22 20" shape-rendering="crispEdges" aria-hidden="true">' +
      '<g fill="#5B6E8C"><rect x="10" y="2" width="2" height="1"/><rect x="15" y="2" width="1" height="1"/>' +
      '<rect x="4" y="3" width="7" height="1"/><rect x="15" y="3" width="2" height="1"/>' +
      '<rect x="20" y="3" width="2" height="1"/><rect x="2" y="4" width="5" height="1"/>' +
      '<rect x="15" y="4" width="1" height="1"/><rect x="19" y="4" width="2" height="1"/>' +
      '<rect x="1" y="5" width="3" height="1"/><rect x="1" y="6" width="2" height="1"/></g>' +
      '<g fill="#4285F4"><rect x="7" y="4" width="5" height="1"/><rect x="16" y="4" width="2" height="1"/>' +
      '<rect x="21" y="4" width="1" height="1"/><rect x="4" y="5" width="9" height="1"/>' +
      '<rect x="16" y="5" width="5" height="1"/><rect x="3" y="6" width="11" height="1"/>' +
      '<rect x="16" y="6" width="4" height="1"/><rect x="0" y="7" width="15" height="1"/>' +
      '<rect x="16" y="7" width="3" height="1"/><rect x="0" y="8" width="2" height="1"/>' +
      '<rect x="5" y="8" width="7" height="1"/><rect x="14" y="8" width="4" height="1"/>' +
      '<rect x="0" y="9" width="2" height="1"/><rect x="7" y="9" width="6" height="1"/>' +
      '<rect x="15" y="9" width="3" height="1"/><rect x="0" y="10" width="2" height="1"/>' +
      '<rect x="8" y="10" width="3" height="1"/><rect x="12" y="10" width="2" height="1"/>' +
      '<rect x="15" y="10" width="3" height="1"/><rect x="9" y="11" width="5" height="1"/>' +
      '<rect x="10" y="12" width="3" height="1"/></g>' +
      '<g fill="#2554A8"><rect x="0" y="11" width="2" height="1"/><rect x="14" y="11" width="3" height="1"/>' +
      '<rect x="1" y="12" width="2" height="1"/><rect x="13" y="12" width="3" height="1"/>' +
      '<rect x="1" y="13" width="2" height="1"/><rect x="11" y="13" width="4" height="1"/>' +
      '<rect x="2" y="14" width="2" height="1"/><rect x="7" y="14" width="2" height="1"/>' +
      '<rect x="12" y="14" width="4" height="1"/><rect x="3" y="15" width="14" height="1"/>' +
      '<rect x="4" y="16" width="9" height="1"/><rect x="6" y="17" width="6" height="1"/></g>' +
      '<g fill="#FFFFFF"><rect x="2" y="8" width="3" height="1"/><rect x="12" y="8" width="2" height="1"/>' +
      '<rect x="2" y="9" width="5" height="1"/><rect x="13" y="9" width="2" height="1"/>' +
      '<rect x="2" y="10" width="6" height="1"/><rect x="11" y="10" width="1" height="1"/>' +
      '<rect x="14" y="10" width="1" height="1"/><rect x="2" y="11" width="7" height="1"/>' +
      '<rect x="3" y="12" width="7" height="1"/><rect x="3" y="13" width="8" height="1"/>' +
      '<rect x="4" y="14" width="3" height="1"/><rect x="9" y="14" width="3" height="1"/></g></svg>',
  };

  const QUERY_GLYPH_SVG = pixelRowsSvg(
    ['.XXXXX.', 'XXXXXXX', 'XX.X.XX', 'XXXXXXX', '.XXXXX.', '.XX....', '.X.....'],
    14,
    14,
    '0 0 14 14'
  );
  const REPLY_GLYPH_SVG = pixelRowsSvg(
    ['XXXX..', 'XXXXX.', 'XXXXXX', 'X....X', 'XXXXXX', 'X...XX', 'XXXXXX'],
    14,
    14,
    '-1 0 14 14'
  );
  const TASKS_GLYPH_SVG = pixelRowsSvg(
    ['XX.XXXX', '.......', 'XX.XXXX', '.......', 'XX.XXX.'],
    14,
    14,
    '0 -2 14 14'
  );
  const REFRESH_GLYPH_SVG = pixelRowsSvg(
    ['.XXXX.X', 'X....XX', '....XXX', '.......', 'XXX....', 'XX....X', 'X.XXXX.'],
    14,
    14,
    '0 0 14 14'
  );

  const PIXEL_ZH_SVG = pixelRowsSvg(
    ['...X...', 'XXXXXXX', 'X..X..X', 'X..X..X', 'XXXXXXX', '...X...', '...X...', '...X...'],
    10.5,
    12,
    '0 0 14 16'
  );
  const PIXEL_SLASH_SVG = pixelRowsSvg(
    ['....', '...X', '..X.', '..X.', '.X..', '.X..', 'X...', '....'],
    6,
    12,
    '0 0 8 16'
  );
  const PIXEL_EN_SVG = pixelRowsSvg(
    [
      '...........',
      'XXXXX.X...X',
      'X.....XX..X',
      'XXXX..X.X.X',
      'X.....X..XX',
      'X.....X...X',
      'XXXXX.X...X',
      '...........',
    ],
    16.5,
    12,
    '0 0 22 16'
  );

  const CHECK_INLINE_SVG =
    '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
    '<path d="M2.5 7.4L5.6 10.5L11.5 3.8" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function createDisclosureEl(open, size) {
    const px = size === 'sm' ? 14 : 16;
    const span = el('span', 'cospan-disclosure');
    span.dataset.open = String(Boolean(open));
    span.dataset.size = size || 'md';
    span.setAttribute('aria-hidden', 'true');
    const main = open ? '#F6912E' : 'var(--cospan-muted)';
    const dot = open ? '#F6912E' : 'var(--cospan-border-strong)';
    span.appendChild(
      svgNode(
        `<svg width="${px}" height="${px}" viewBox="0 0 16 16" shape-rendering="crispEdges">` +
          `<rect x="2" y="7" width="2" height="2" fill="${dot}"/>` +
          `<g fill="${main}">` +
          '<rect x="6" y="3" width="2" height="10"/><rect x="8" y="5" width="2" height="6"/>' +
          '<rect x="10" y="6" width="2" height="4"/><rect x="12" y="7" width="2" height="2"/>' +
          '</g></svg>'
      )
    );
    return span;
  }

  function createPixelStatusIcon(status) {
    const s = String(status || 'done').toLowerCase();
    const wrap = el('span', 'cospan-status-icon-wrap');
    if (s === 'running' || s === 'queued') {
      wrap.classList.add('cospan-pixel-hourglass');
      wrap.title = 'Running';
      wrap.appendChild(
        svgNode(
          '<svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
            '<g fill="var(--cospan-secondary)">' +
            '<rect x="2" y="1" width="12" height="2"/><rect x="2" y="13" width="12" height="2"/>' +
            '<rect x="3" y="3" width="2" height="3"/><rect x="11" y="3" width="2" height="3"/>' +
            '<rect x="5" y="6" width="2" height="2"/><rect x="9" y="6" width="2" height="2"/>' +
            '<rect x="5" y="8" width="2" height="2"/><rect x="9" y="8" width="2" height="2"/>' +
            '<rect x="3" y="10" width="2" height="3"/><rect x="11" y="10" width="2" height="3"/></g>' +
            '<g fill="#FBBC04"><rect x="7" y="5" width="2" height="2"/>' +
            '<rect x="7" y="8" width="2" height="2"/><rect x="5" y="10" width="6" height="3"/></g></svg>'
        )
      );
      return wrap;
    }
    const palette =
      s === 'error' || s === 'crashed'
        ? {
            color: '#C8553D',
            title: 'Failed',
            glyph:
              '<rect x="5" y="5" width="2" height="2"/><rect x="9" y="5" width="2" height="2"/><rect x="7" y="7" width="2" height="2"/><rect x="5" y="9" width="2" height="2"/><rect x="9" y="9" width="2" height="2"/>',
          }
        : s === 'canceled' || s === 'cancelled'
          ? {
              color: '#6E7781',
              title: 'Canceled',
              glyph: '<rect x="5" y="7" width="6" height="2"/>',
            }
          : s === 'attention'
            ? {
                color: '#E3B04B',
                title: 'Attention',
                glyph:
                  '<rect x="7" y="4" width="2" height="5"/><rect x="7" y="10" width="2" height="2"/>',
              }
            : {
                color: '#34A853',
                title: 'Completed',
                glyph:
                  '<rect x="4" y="8" width="2" height="2"/><rect x="6" y="10" width="2" height="2"/>' +
                  '<rect x="8" y="7" width="2" height="3"/><rect x="10" y="5" width="2" height="2"/>',
              };
    wrap.title = palette.title;
    wrap.appendChild(
      svgNode(
        `<svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">` +
          `<rect x="4" y="2" width="8" height="12" fill="${palette.color}" fill-opacity="0.14"/>` +
          `<rect x="2" y="4" width="12" height="8" fill="${palette.color}" fill-opacity="0.14"/>` +
          `<g fill="${palette.color}" fill-opacity="0.85">` +
          '<rect x="4" y="1" width="8" height="1"/><rect x="4" y="14" width="8" height="1"/>' +
          '<rect x="1" y="4" width="1" height="8"/><rect x="14" y="4" width="1" height="8"/>' +
          '<rect x="2" y="2" width="2" height="2"/><rect x="12" y="2" width="2" height="2"/>' +
          '<rect x="2" y="12" width="2" height="2"/><rect x="12" y="12" width="2" height="2"/>' +
          `</g><g fill="${palette.color}">${palette.glyph}</g></svg>`
      )
    );
    return wrap;
  }

  function readSavedLang() {
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch {
      /* ignore */
    }
    if (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')) return 'zh';
    return 'en';
  }

  function readSavedCapOpen() {
    try {
      const saved = localStorage.getItem(CAP_STORAGE_KEY);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
    } catch {
      /* ignore */
    }
    return false;
  }

  function formatClockDuration(ms) {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  function formatTimeTag(isoStr, t) {
    if (!isoStr) return '';
    const ms = Date.parse(isoStr);
    if (!Number.isFinite(ms)) return '';
    const now = new Date();
    const d = new Date(ms);
    const diffSec = Math.floor((now.getTime() - ms) / 1000);
    if (diffSec >= 0 && diffSec < 60) return t.justNow;
    if (diffSec >= 60 && diffSec < 3600) return t.minsAgo(Math.floor(diffSec / 60));
    const pad = (n) => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return t.todayAt(hm);
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const isYest =
      d.getFullYear() === yest.getFullYear() &&
      d.getMonth() === yest.getMonth() &&
      d.getDate() === yest.getDate();
    if (isYest) return t.yesterdayAt(hm);
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function shortModelLabel(model, effort) {
    const base = String(model || '').trim();
    if (!base) return effort ? `default · ${effort}` : 'default';
    const compact = base
      .replace(/^gemini-/, '')
      .replace(/^deepseek-/, '')
      .replace(/^claude-/, '')
      .replace(/^gpt-/, '');
    if (effort && !compact.endsWith(`-${effort}`)) return `${compact} · ${effort}`;
    return compact;
  }

  function formatWorkspaceLabel(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'Active workspace';
    const parts = s.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length <= 2) return s;
    return `…/${parts.slice(-2).join('/')}`;
  }

  function formatActivityItem(act) {
    if (!act) return '';
    if (typeof act === 'string') return act.trim();
    const tool = String(act.tool || act.kind || act.label || 'step').trim();
    let detail = '';
    const rawPreview = act.input_preview || act.detail || '';
    if (typeof rawPreview === 'string' && rawPreview.trim()) {
      const trimmed = rawPreview.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          const candidate =
            parsed.Path ||
            parsed.path ||
            parsed.filePath ||
            parsed.CommandLine ||
            parsed.command ||
            parsed.query ||
            '';
          if (typeof candidate === 'string' && candidate.trim()) {
            const parts = candidate.trim().split(/[/\\]/);
            detail = parts[parts.length - 1] || candidate.trim();
          }
        } catch {
          /* ignore */
        }
      }
      if (!detail) detail = trimmed.slice(0, 36);
    }
    return detail ? `${tool}: ${detail.slice(0, 36)}` : tool;
  }

  function collapseActivities(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const act of list) {
      const label = formatActivityItem(act);
      if (!label) continue;
      const prev = out[out.length - 1];
      if (prev && prev.label === label) prev.count += 1;
      else out.push({ label, count: 1 });
    }
    return out.reverse();
  }

  function appendInlineRichNodes(parent, line) {
    const parts = String(line).split(/(`[^`]+`|\*\*[^*]+\*\*)/gu);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        parent.appendChild(el('code', 'cospan-md-code-inline', part.slice(1, -1)));
      } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        parent.appendChild(el('strong', '', part.slice(2, -2)));
      } else if (part) {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function renderFormattedMarkdown(rawText) {
    const text = String(rawText || '').trim();
    const root = el('div', 'cospan-md');
    if (!text) return root;
    const lines = text.split(/\r?\n/u);
    let listEl = null;
    let inCode = false;
    let codeLines = [];

    const flushList = () => {
      if (listEl) {
        root.appendChild(listEl);
        listEl = null;
      }
    };

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        flushList();
        if (inCode) {
          root.appendChild(el('pre', 'cospan-md-pre', codeLines.join('\n')));
          codeLines = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        flushList();
        continue;
      }
      const hMatch = /^(#{1,4})\s+(.+)$/u.exec(trimmed);
      if (hMatch) {
        flushList();
        const hEl = el('div', 'cospan-md-h');
        appendInlineRichNodes(hEl, hMatch[2]);
        root.appendChild(hEl);
        continue;
      }
      const bMatch = /^(?:[-*]|\d+\.)\s+(.+)$/u.exec(trimmed);
      if (bMatch) {
        if (!listEl) listEl = el('ul', 'cospan-md-list');
        const li = el('li');
        appendInlineRichNodes(li, bMatch[1]);
        listEl.appendChild(li);
        continue;
      }
      flushList();
      const pEl = el('p', 'cospan-md-p');
      appendInlineRichNodes(pEl, trimmed);
      root.appendChild(pEl);
    }
    flushList();
    if (codeLines.length > 0) root.appendChild(el('pre', 'cospan-md-pre', codeLines.join('\n')));
    return root;
  }

  async function copyTextSafe(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* ignore */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  function isLongBlock(text, maxLines, maxChars) {
    if (!text) return false;
    return text.split(/\r?\n/u).length > maxLines || text.length > maxChars;
  }

  function mount(container, adapter) {
    if (!container) throw new Error('CospanBoard.mount requires a container element');
    const host = adapter && adapter.host === 'dsh' ? 'dsh' : 'agy';
    const initial = (adapter && adapter.getInitialState && adapter.getInitialState()) || {};
    const runningPollMs =
      adapter && Number.isFinite(adapter.runningPollMs) && adapter.runningPollMs > 0
        ? adapter.runningPollMs
        : RUNNING_POLL_MS;
    const idlePollMs =
      adapter && Number.isFinite(adapter.idlePollMs) && adapter.idlePollMs > 0
        ? adapter.idlePollMs
        : IDLE_POLL_MS;

    const state = {
      destroyed: false,
      hostVisible: initial.visible !== false,
      lang: readSavedLang(),
      capExpanded: readSavedCapOpen(),
      scope: 'workspace',
      userPinnedScope: false,
      lastAutoSessionId: initial.sessionId || null,
      workspace: initial.workspaceLabel || '',
      callerSessionId: initial.sessionId || null,
      jobs: [],
      notice: '',
      error: '',
      manualRefreshing: false,
      inFlight: false,
      queuedRefresh: false,
      needsRefreshOnVisible: false,
      refreshEpoch: 0,
      sessionEpoch: 0,
      expanded: new Set(),
      expandedBlocks: new Set(),
      details: new Map(),
      detailLoading: new Set(),
      canceling: new Set(),
      copiedKeys: new Set(),
      pollTimer: null,
      tickTimer: null,
    };

    const t = () => I18N[state.lang] || I18N.en;

    container.textContent = '';
    const root = el('div', 'cospan-board');
    root.dataset.cospanHost = host;
    const scrollEl = el('div', 'cospan-scroll');
    root.appendChild(scrollEl);
    container.appendChild(root);

    // CUJ 1: Collapsible Quick Dispatch Card
    const capCard = el('div', 'cospan-cap-card');
    const capHeader = el('div', 'cospan-cap-header');
    const capToggle = el('button', 'cospan-cap-toggle');
    capToggle.type = 'button';
    let capChevron = createDisclosureEl(state.capExpanded, 'md');
    const capLogo = svgNode(PIXEL_COSPAN_SVG);
    const capTitle = el('span', 'cospan-cap-title', 'cospan');
    const capSub = el('span', 'cospan-cap-subtitle');
    capToggle.append(capChevron, capLogo, capTitle, capSub);

    const langBtn = el('button', 'cospan-lang-btn cospan-mono');
    langBtn.type = 'button';
    langBtn.title = '切换中英文 (中 / EN)';
    const zhOpt = el('span', 'cospan-lang-opt');
    zhOpt.appendChild(svgNode(PIXEL_ZH_SVG));
    const slashOpt = el('span', 'cospan-lang-sep');
    slashOpt.appendChild(svgNode(PIXEL_SLASH_SVG));
    const enOpt = el('span', 'cospan-lang-opt');
    enOpt.appendChild(svgNode(PIXEL_EN_SVG));
    langBtn.append(zhOpt, slashOpt, enOpt);
    const capActions = el('div', 'cospan-cap-header-actions');
    capActions.appendChild(langBtn);
    capHeader.append(capToggle, capActions);

    const capBody = el('div', 'cospan-cap-body');
    const capGrid = el('div', 'cospan-cap-grid');
    const capHintRow = el('div', 'cospan-cap-hint');
    capBody.append(capGrid, capHintRow);
    capCard.append(capHeader, capBody);

    // CUJ 2: Delegated Tasks Section
    const section = el('div', 'cospan-section');
    const sectionBar = el('div', 'cospan-section-bar');
    const sectionTitle = el('span', 'cospan-section-title');
    const sectionGlyph = el('span', 'cospan-section-glyph');
    sectionGlyph.appendChild(svgNode(TASKS_GLYPH_SVG));
    const sectionTitleText = el('span');
    sectionTitle.append(sectionGlyph, sectionTitleText);

    const sectionControls = el('div', 'cospan-section-controls');
    const segmented = el('div', 'cospan-segmented');
    segmented.setAttribute('role', 'tablist');

    const sessionBtn = el('button', 'cospan-seg-btn');
    sessionBtn.type = 'button';
    const sessionBtnText = el('span');
    const sessionCountEl = el('span', 'cospan-seg-count cospan-mono', '0');
    sessionBtn.append(sessionBtnText, sessionCountEl);

    const workspaceBtn = el('button', 'cospan-seg-btn');
    workspaceBtn.type = 'button';
    const workspaceBtnText = el('span');
    const workspaceCountEl = el('span', 'cospan-seg-count cospan-mono', '0');
    workspaceBtn.append(workspaceBtnText, workspaceCountEl);
    segmented.append(sessionBtn, workspaceBtn);

    const refreshBtn = el('button', 'cospan-icon-btn cospan-mono');
    refreshBtn.type = 'button';
    const refreshGlyph = el('span', 'cospan-refresh-glyph');
    refreshGlyph.appendChild(svgNode(REFRESH_GLYPH_SVG));
    refreshBtn.appendChild(refreshGlyph);

    sectionControls.append(segmented, refreshBtn);
    sectionBar.append(sectionTitle, sectionControls);

    const workspaceStrip = el('div', 'cospan-workspace-strip cospan-mono');
    const errorBanner = el('div', 'cospan-error-banner');
    errorBanner.hidden = true;
    const listEl = el('div', 'cospan-task-list');
    section.append(sectionBar, workspaceStrip, errorBanner, listEl);
    scrollEl.append(capCard, section);

    const cardRecords = new Map();

    function markCopied(key) {
      state.copiedKeys.add(key);
      renderAll();
      setTimeout(() => {
        if (state.destroyed) return;
        state.copiedKeys.delete(key);
        renderAll();
      }, 1500);
    }

    async function triggerDraftOrCopy(text, copyKey) {
      if (adapter && typeof adapter.prefillInput === 'function') {
        try {
          await adapter.prefillInput(text);
        } catch {
          /* ignore */
        }
      }
      await copyTextSafe(text);
      markCopied(copyKey);
    }

    function applyScopeSelection(nextScope, pinned) {
      state.scope = nextScope === 'session' ? 'session' : 'workspace';
      if (pinned) state.userPinnedScope = true;
      renderAll();
    }

    capToggle.addEventListener('click', () => {
      state.capExpanded = !state.capExpanded;
      try {
        localStorage.setItem(CAP_STORAGE_KEY, String(state.capExpanded));
      } catch {
        /* ignore */
      }
      renderHeaderAndCaps();
    });

    langBtn.addEventListener('click', () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      try {
        localStorage.setItem(LANG_STORAGE_KEY, state.lang);
      } catch {
        /* ignore */
      }
      renderAll();
    });

    sessionBtn.addEventListener('click', () => applyScopeSelection('session', true));
    workspaceBtn.addEventListener('click', () => applyScopeSelection('workspace', true));
    refreshBtn.addEventListener('click', () => {
      void handleManualRefresh();
    });

    async function loadDetail(jobId, force) {
      if (state.destroyed || !adapter || !adapter.fetchDetail) return;
      if (state.detailLoading.has(jobId) && !force) return;
      const reqSessionEpoch = state.sessionEpoch;
      state.detailLoading.add(jobId);
      try {
        const detail = await adapter.fetchDetail(jobId);
        if (
          !state.destroyed &&
          reqSessionEpoch === state.sessionEpoch &&
          detail &&
          detail.ok !== false
        ) {
          state.details.set(jobId, detail);
          renderCardById(jobId);
        }
      } catch {
        /* ignore */
      }
      if (reqSessionEpoch === state.sessionEpoch) {
        state.detailLoading.delete(jobId);
      }
    }

    async function handleCancel(jobId) {
      if (state.destroyed || !adapter || !adapter.cancelJob || state.canceling.has(jobId)) return;
      const reqSessionEpoch = state.sessionEpoch;
      state.canceling.add(jobId);
      renderCardById(jobId);
      try {
        const res = await adapter.cancelJob(jobId);
        if (
          !state.destroyed &&
          reqSessionEpoch === state.sessionEpoch &&
          res &&
          res.ok === false &&
          res.message
        ) {
          state.error = res.message;
        }
      } catch (err) {
        if (!state.destroyed && reqSessionEpoch === state.sessionEpoch) {
          state.error = (err && err.message) || 'Failed to cancel task.';
        }
      } finally {
        if (reqSessionEpoch === state.sessionEpoch) {
          state.canceling.delete(jobId);
          if (isEffectivelyVisible()) {
            await refresh();
          }
        }
      }
    }

    function buildLiveStrip(job, detail) {
      const acts =
        (detail && detail.progress && detail.progress.recent_activities) ||
        job.recent_activities ||
        [];
      const steps = collapseActivities(acts);
      const strip = el('div', 'cospan-live-strip');
      if (steps.length === 0) {
        const ph = el('span', 'cospan-step-pill is-current is-placeholder');
        ph.appendChild(el('span', 'cospan-step-pill-label', t().liveWaiting));
        strip.appendChild(ph);
        return strip;
      }
      steps.forEach((step, idx) => {
        const pill = el('span', idx === 0 ? 'cospan-step-pill is-current' : 'cospan-step-pill');
        pill.title = step.label;
        pill.appendChild(el('span', 'cospan-step-pill-label', step.label));
        if (step.count > 1) {
          pill.appendChild(el('span', 'cospan-step-pill-count cospan-mono', `×${step.count}`));
        }
        strip.appendChild(pill);
      });
      return strip;
    }

    function buildQaCard(kind, text, blockKey, isReply) {
      const tr = t();
      const card = el('div', 'cospan-qa-card');
      card.dataset.kind = kind;

      const head = el('div', 'cospan-qa-head');
      const badge = el('span', 'cospan-qa-badge');
      const glyph = el('span', 'cospan-qa-glyph');
      glyph.dataset.kind = kind;
      glyph.appendChild(svgNode(isReply ? REPLY_GLYPH_SVG : QUERY_GLYPH_SVG));
      badge.append(glyph, el('span', '', isReply ? tr.replyLabel : tr.queryLabel));

      const long = isReply ? isLongBlock(text, 6, 280) : isLongBlock(text, 3, 150);
      const isExp = state.expandedBlocks.has(blockKey);
      const actions = el('div', 'cospan-qa-actions');

      const toggleBlock = (ev) => {
        ev.stopPropagation();
        if (state.expandedBlocks.has(blockKey)) state.expandedBlocks.delete(blockKey);
        else state.expandedBlocks.add(blockKey);
        const jobId = blockKey.split(':')[0];
        renderCardById(jobId);
      };

      if (long) {
        const expHead = el(
          'button',
          'cospan-link-btn',
          isExp ? `${tr.collapseText} ▴` : `${tr.expandText} ▾`
        );
        expHead.type = 'button';
        expHead.addEventListener('click', toggleBlock);
        actions.appendChild(expHead);
      }

      const copyKey = `copy:${blockKey}`;
      const copied = state.copiedKeys.has(copyKey);
      const copyBtn = el('button', 'cospan-link-btn');
      copyBtn.type = 'button';
      copyBtn.dataset.copied = String(copied);
      if (copied) {
        copyBtn.append(svgNode(CHECK_INLINE_SVG), el('span', '', tr.copiedInline));
      } else {
        copyBtn.appendChild(el('span', '', tr.copyText));
      }
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void copyTextSafe(text).then((ok) => {
          if (ok && !state.destroyed) markCopied(copyKey);
        });
      });
      actions.appendChild(copyBtn);
      head.append(badge, actions);

      const viewport = el('div', 'cospan-qa-viewport');
      viewport.dataset.kind = kind;
      viewport.dataset.state = !long ? 'short' : isExp ? 'expanded' : 'collapsed';
      if (isReply) {
        viewport.appendChild(renderFormattedMarkdown(text));
      } else {
        viewport.textContent = text;
      }

      card.append(head, viewport);
      if (long) {
        const expBar = el(
          'button',
          'cospan-expand-bar',
          isExp ? `${tr.collapseText} ▴` : `${tr.expandText} ▾`
        );
        expBar.type = 'button';
        expBar.addEventListener('click', toggleBlock);
        card.appendChild(expBar);
      }
      return card;
    }

    function buildDetailDrawer(job) {
      const tr = t();
      const detail = state.details.get(job.id);
      const wrap = el('div', 'cospan-task-detail');
      const isRunning = job.status === 'running';

      const acts =
        (detail && detail.progress && detail.progress.recent_activities) ||
        job.recent_activities ||
        [];
      if (isRunning || acts.length > 0) {
        wrap.appendChild(buildLiveStrip(job, detail));
      }

      const qText = (detail && detail.prompt) || job.prompt_preview || job.id;
      const rText = isRunning
        ? (detail && detail.progress && detail.progress.latest_text) ||
          job.latest_text ||
          tr.noReplyYet
        : (detail && detail.result_text) ||
          (detail && detail.progress && detail.progress.latest_text) ||
          job.latest_text ||
          (detail && detail.log_tail) ||
          (state.detailLoading.has(job.id) ? tr.loadingDetail : tr.noReplyYet);

      const qaStack = el('div', 'cospan-qa-stack');
      qaStack.append(
        buildQaCard('query', qText, `${job.id}:q`, false),
        buildQaCard('reply', rText, `${job.id}:r`, true)
      );
      wrap.appendChild(qaStack);

      const files =
        (detail && detail.progress && detail.progress.touched_files) || job.touched_files || [];
      if (files.length > 0) {
        const filesList = el('div', 'cospan-files-list');
        for (const f of files.slice(0, 8)) {
          filesList.appendChild(el('span', 'cospan-file-pill cospan-mono', f));
        }
        wrap.appendChild(filesList);
      }

      const footer = el('div', 'cospan-continue-bar');
      const meta = el('div', 'cospan-footer-meta');
      meta.appendChild(el('span', 'cospan-meta-chip cospan-mono', job.id));
      if (job.conversation_id) {
        const convChip = el('span', 'cospan-meta-chip cospan-mono', job.conversation_id);
        convChip.title = `Session: ${job.conversation_id}`;
        meta.appendChild(convChip);
      }

      const footerActions = el('div', 'cospan-footer-actions');
      if (isRunning) {
        const isCanceling = state.canceling.has(job.id);
        const cancelBtn = el(
          'button',
          'cospan-cancel-btn',
          isCanceling ? tr.cancelingBtn : tr.cancelBtn
        );
        cancelBtn.type = 'button';
        cancelBtn.disabled = isCanceling;
        cancelBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void handleCancel(job.id);
        });
        footerActions.appendChild(cancelBtn);
      }

      const canInsert = Boolean(adapter && typeof adapter.prefillInput === 'function');
      const contKey = `cont:${job.id}`;
      const contCopied = state.copiedKeys.has(contKey);
      const contDraft = canInsert
        ? `/cospan-${job.target || 'agy'} Continue task ${job.id}: `
        : `cospan continue --id ${job.id} --prompt "..."`;
      const contBtn = el('button', 'cospan-continue-btn');
      contBtn.type = 'button';
      contBtn.dataset.copied = String(contCopied);
      contBtn.title = contDraft;
      if (contCopied) {
        contBtn.append(
          svgNode(CHECK_INLINE_SVG),
          el('span', '', canInsert ? tr.insertedInline : tr.copiedInline)
        );
      } else {
        contBtn.appendChild(el('span', '', `${canInsert ? tr.continueInsert : tr.continueCopy} ↗`));
      }
      contBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void triggerDraftOrCopy(contDraft, contKey);
      });
      footerActions.appendChild(contBtn);

      footer.append(meta, footerActions);
      wrap.appendChild(footer);
      return wrap;
    }

    function createCardRecord(jobId) {
      const card = el('article', 'cospan-task-card');
      const summary = el('button', 'cospan-task-summary');
      summary.type = 'button';

      let chevEl = createDisclosureEl(false, 'sm');
      const iconBox = el('div', 'cospan-task-icon');
      const main = el('div', 'cospan-task-main');
      const top = el('div', 'cospan-task-top');
      const roleEl = el('span', 'cospan-task-role cospan-mono');
      const pillsWrap = el('span', '');
      pillsWrap.style.display = 'inline-flex';
      pillsWrap.style.gap = '4px';
      top.append(roleEl, pillsWrap);

      const preview = el('div', 'cospan-task-query-preview');
      main.append(top, preview);

      const right = el('div', 'cospan-task-right');
      const timeEl = el('span', 'cospan-time-tag');
      let statusIcon = createPixelStatusIcon('done');
      right.append(timeEl, statusIcon);

      summary.append(chevEl, iconBox, main, right);
      card.appendChild(summary);

      summary.addEventListener('click', () => {
        if (state.expanded.has(jobId)) state.expanded.delete(jobId);
        else {
          state.expanded.add(jobId);
          void loadDetail(jobId, false);
        }
        renderCardById(jobId);
      });

      return {
        card,
        summary,
        getChev: () => chevEl,
        setChev: (next) => {
          chevEl.replaceWith(next);
          chevEl = next;
        },
        iconBox,
        roleEl,
        pillsWrap,
        preview,
        timeEl,
        getStatusIcon: () => statusIcon,
        setStatusIcon: (next) => {
          statusIcon.replaceWith(next);
          statusIcon = next;
        },
        iconTarget: '',
        statusSig: '',
        detailEl: null,
        detailSig: '',
      };
    }

    function updateCardRecord(rec, job) {
      const tr = t();
      const isRunning = job.status === 'running';
      const isExpanded = state.expanded.has(job.id);
      rec.card.dataset.running = String(isRunning);
      rec.summary.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

      if (rec.getChev().dataset.open !== String(isExpanded)) {
        rec.setChev(createDisclosureEl(isExpanded, 'sm'));
      }

      const targetId = job.target || 'agy';
      if (rec.iconTarget !== targetId) {
        rec.iconBox.textContent = '';
        rec.iconBox.appendChild(svgNode(TARGET_PIXEL_SVGS[targetId] || TARGET_PIXEL_SVGS.agy));
        rec.iconTarget = targetId;
      }

      rec.roleEl.textContent = `${targetId} · ${shortModelLabel(job.model, job.effort)}`;
      rec.pillsWrap.textContent = '';
      if (job.caller_match) {
        rec.pillsWrap.appendChild(el('span', 'cospan-pill is-session', tr.thisSession));
      }
      if (job.worktree_name) {
        const wtPill = el('span', 'cospan-pill is-worktree cospan-mono', `wt:${job.worktree_name}`);
        wtPill.title = job.workspace_root || job.worktree_name;
        rec.pillsWrap.appendChild(wtPill);
      }
      if (job.readonly) {
        rec.pillsWrap.appendChild(el('span', 'cospan-pill', tr.readOnly));
      }

      rec.preview.textContent = job.prompt_preview || job.id;

      if (isRunning && job.started_at) {
        rec.timeEl.className = 'cospan-running-timer cospan-mono';
        rec.timeEl.dataset.runningStart = job.started_at;
        rec.timeEl.textContent = formatClockDuration(Date.now() - Date.parse(job.started_at));
      } else {
        rec.timeEl.className = 'cospan-time-tag';
        delete rec.timeEl.dataset.runningStart;
        const tag = formatTimeTag(job.finished_at || job.started_at, tr);
        const dur = formatClockDuration(job.elapsed_ms);
        rec.timeEl.textContent = tag || dur;
        rec.timeEl.title = tag ? `${tag} · ${dur}` : dur;
      }

      if (rec.statusSig !== job.status) {
        rec.setStatusIcon(createPixelStatusIcon(job.status));
        rec.statusSig = job.status;
      }

      if (!isExpanded) {
        if (rec.detailEl) {
          rec.detailEl.remove();
          rec.detailEl = null;
          rec.detailSig = '';
        }
        return;
      }

      const detail = state.details.get(job.id);
      const sig = JSON.stringify([
        state.lang,
        job.status,
        job.phase,
        job.latest_text,
        job.recent_activities,
        job.touched_files,
        job.conversation_id,
        state.canceling.has(job.id),
        state.detailLoading.has(job.id),
        [...state.expandedBlocks].filter((k) => k.startsWith(`${job.id}:`)),
        [...state.copiedKeys].filter((k) => k.includes(job.id)),
        detail ? detail.prompt : '',
        detail ? detail.result_text : '',
        detail && detail.progress ? detail.progress.latest_text : '',
        detail && detail.progress ? detail.progress.recent_activities : null,
      ]);
      if (rec.detailEl && rec.detailSig === sig) return;
      const nextDetail = buildDetailDrawer(job);
      if (rec.detailEl) rec.detailEl.replaceWith(nextDetail);
      else rec.card.appendChild(nextDetail);
      rec.detailEl = nextDetail;
      rec.detailSig = sig;
    }

    function renderCardById(jobId) {
      const rec = cardRecords.get(jobId);
      const job = state.jobs.find((j) => j.id === jobId);
      if (rec && job) updateCardRecord(rec, job);
    }

    function renderHeaderAndCaps() {
      const tr = t();
      const canInsert = Boolean(adapter && typeof adapter.prefillInput === 'function');
      const nextChev = createDisclosureEl(state.capExpanded, 'md');
      capChevron.replaceWith(nextChev);
      capChevron = nextChev;
      capToggle.setAttribute('aria-expanded', String(state.capExpanded));
      capSub.textContent = tr.capSub;
      zhOpt.dataset.active = String(state.lang === 'zh');
      enOpt.dataset.active = String(state.lang === 'en');
      capBody.hidden = !state.capExpanded;

      if (state.capExpanded) {
        capGrid.textContent = '';
        const caps = [
          { id: 'agy', cmd: '/cospan-agy' },
          { id: 'codex', cmd: '/cospan-codex' },
          { id: 'claude', cmd: '/cospan-claude' },
          { id: 'dsh', cmd: '/cospan-dsh' },
        ];
        for (const cap of caps) {
          const copyKey = `cap:${cap.id}`;
          const copied = state.copiedKeys.has(copyKey);
          const item = el('button', 'cospan-cap-item');
          item.type = 'button';
          item.dataset.copied = String(copied);
          const icon = el('div', 'cospan-cap-icon');
          icon.appendChild(svgNode(TARGET_PIXEL_SVGS[cap.id]));
          const cmdRow = el('div', 'cospan-cap-cmd cospan-mono');
          cmdRow.appendChild(el('span', '', cap.cmd));
          if (copied) {
            const doneTag = el('span', 'cospan-cap-copied');
            doneTag.append(
              svgNode(CHECK_INLINE_SVG),
              el('span', '', canInsert ? tr.insertedInline : tr.copiedInline)
            );
            cmdRow.appendChild(doneTag);
          }
          item.append(icon, cmdRow);
          item.addEventListener('click', () => void triggerDraftOrCopy(`${cap.cmd} `, copyKey));
          capGrid.appendChild(item);
        }
        capHintRow.textContent = canInsert ? tr.capHintInsert : tr.capHintCopy;
      }

      sectionTitleText.textContent = tr.tasksTitle;
      const sessionMatches = state.jobs.filter((j) => j.caller_match).length;
      sessionBtnText.textContent = tr.scopeSession;
      workspaceBtnText.textContent = tr.scopeWorkspace;
      sessionCountEl.textContent = String(sessionMatches);
      workspaceCountEl.textContent = String(state.jobs.length);
      sessionBtn.dataset.active = String(state.scope === 'session');
      workspaceBtn.dataset.active = String(state.scope === 'workspace');
      sessionBtn.setAttribute('aria-selected', String(state.scope === 'session'));
      workspaceBtn.setAttribute('aria-selected', String(state.scope === 'workspace'));

      refreshBtn.dataset.refreshing = String(state.manualRefreshing);
      refreshBtn.title = tr.refreshTip;

      workspaceStrip.textContent = formatWorkspaceLabel(state.workspace);
      workspaceStrip.title = state.workspace || '';
      errorBanner.hidden = !state.error;
      errorBanner.textContent = state.error || '';
    }

    function renderEmptyState(visibleJobs) {
      if (visibleJobs.length > 0) return false;
      const tr = t();
      cardRecords.clear();
      listEl.textContent = '';
      const box = el('div', 'cospan-empty-state');
      if (state.notice) {
        box.append(
          el('div', 'cospan-empty-title', tr.waitingSessionTitle),
          el('div', 'cospan-empty-sub', state.notice)
        );
      } else if (state.scope === 'session' && state.jobs.length > 0) {
        box.append(
          el('div', 'cospan-empty-title', tr.emptySessionTitle),
          el('div', 'cospan-empty-sub', tr.emptySessionSub)
        );
        const btn = el('button', 'cospan-action-btn', tr.showWorkspaceBtn(state.jobs.length));
        btn.type = 'button';
        btn.addEventListener('click', () => applyScopeSelection('workspace', true));
        box.appendChild(btn);
      } else {
        box.append(
          el('div', 'cospan-empty-title', tr.emptyWorkspaceTitle),
          el('div', 'cospan-empty-sub', tr.emptyWorkspaceSub)
        );
      }
      listEl.appendChild(box);
      return true;
    }

    function renderAll() {
      renderHeaderAndCaps();
      const visibleJobs =
        state.scope === 'session' ? state.jobs.filter((j) => j.caller_match) : state.jobs;
      if (renderEmptyState(visibleJobs)) return;

      const emptyNode = listEl.querySelector('.cospan-empty-state');
      if (emptyNode) emptyNode.remove();

      const visibleIds = new Set(visibleJobs.map((j) => j.id));
      for (const [id, rec] of cardRecords.entries()) {
        if (!visibleIds.has(id)) {
          rec.card.remove();
          cardRecords.delete(id);
        }
      }

      let cursor = listEl.firstElementChild;
      for (const job of visibleJobs) {
        let rec = cardRecords.get(job.id);
        if (!rec) {
          rec = createCardRecord(job.id);
          cardRecords.set(job.id, rec);
        }
        updateCardRecord(rec, job);
        if (rec.card !== cursor) {
          listEl.insertBefore(rec.card, cursor);
        } else {
          cursor = cursor.nextElementSibling;
        }
      }
    }

    function isEffectivelyVisible() {
      if (state.destroyed || !state.hostVisible) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;
      return true;
    }

    function stopTimers() {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      if (state.tickTimer) {
        clearInterval(state.tickTimer);
        state.tickTimer = null;
      }
    }

    function resetSessionViewState() {
      state.sessionEpoch += 1;
      state.refreshEpoch += 1;
      state.expanded.clear();
      state.expandedBlocks.clear();
      state.details.clear();
      state.detailLoading.clear();
      state.canceling.clear();
      state.jobs = [];
      state.workspace = '';
      state.notice = '';
      state.error = '';
    }

    function scheduleNextPoll() {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      if (!isEffectivelyVisible()) {
        stopTimers();
        return;
      }
      const hasRunning = state.jobs.some((j) => j.status === 'running');
      state.pollTimer = setTimeout(
        () => {
          state.pollTimer = null;
          void refresh();
        },
        hasRunning ? runningPollMs : idlePollMs
      );

      if (hasRunning && !state.tickTimer) {
        state.tickTimer = setInterval(() => {
          const nodes = listEl.querySelectorAll('[data-running-start]');
          for (const node of nodes) {
            const started = Date.parse(node.dataset.runningStart || '');
            if (Number.isFinite(started)) {
              node.textContent = formatClockDuration(Date.now() - started);
            }
          }
        }, TICK_MS);
      } else if (!hasRunning && state.tickTimer) {
        clearInterval(state.tickTimer);
        state.tickTimer = null;
      }
    }

    async function refresh(options) {
      const force = Boolean(options && options.force);
      if (state.destroyed || !adapter || !adapter.fetchBoard) return;
      if (!force && !isEffectivelyVisible()) {
        state.needsRefreshOnVisible = true;
        stopTimers();
        return;
      }
      if (state.inFlight) {
        state.queuedRefresh = true;
        return;
      }
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      state.inFlight = true;
      state.needsRefreshOnVisible = false;
      const reqEpoch = ++state.refreshEpoch;
      const reqSessionEpoch = state.sessionEpoch;
      try {
        const board = await adapter.fetchBoard({ scope: state.scope });
        if (
          state.destroyed ||
          reqEpoch !== state.refreshEpoch ||
          reqSessionEpoch !== state.sessionEpoch
        ) {
          return;
        }
        const prevStatuses = new Map(state.jobs.map((j) => [j.id, j.status]));
        state.jobs = Array.isArray(board && board.jobs) ? board.jobs : [];
        state.workspace = (board && board.workspace) || state.workspace;
        state.callerSessionId = (board && board.caller_session_id) || state.callerSessionId || null;
        state.notice = (board && board.notice) || '';
        state.error = '';

        if (state.lastAutoSessionId !== null && state.callerSessionId !== state.lastAutoSessionId) {
          state.userPinnedScope = false;
        }
        if (state.callerSessionId) state.lastAutoSessionId = state.callerSessionId;
        if (!state.userPinnedScope) {
          const hasMatch = Boolean(state.callerSessionId) && state.jobs.some((j) => j.caller_match);
          state.scope = hasMatch ? 'session' : 'workspace';
        }

        renderAll();

        if (isEffectivelyVisible()) {
          for (const id of state.expanded) {
            const job = state.jobs.find((j) => j.id === id);
            if (!job) continue;
            const prev = prevStatuses.get(id);
            if (!state.details.has(id) || job.status === 'running' || prev !== job.status) {
              void loadDetail(id, true);
            }
          }
        }
      } catch (err) {
        if (
          !state.destroyed &&
          reqEpoch === state.refreshEpoch &&
          reqSessionEpoch === state.sessionEpoch &&
          !(err && err.name === 'AbortError')
        ) {
          state.error = (err && err.message) || 'Unable to load workspace tasks.';
          renderHeaderAndCaps();
        }
      } finally {
        if (reqEpoch === state.refreshEpoch) {
          state.inFlight = false;
          if (state.destroyed) {
            stopTimers();
          } else if (!isEffectivelyVisible()) {
            state.queuedRefresh = false;
            state.needsRefreshOnVisible = true;
            stopTimers();
          } else if (state.queuedRefresh) {
            state.queuedRefresh = false;
            void refresh();
          } else {
            renderHeaderAndCaps();
            scheduleNextPoll();
          }
        }
      }
    }

    async function handleManualRefresh() {
      if (state.destroyed || state.manualRefreshing) return;
      state.manualRefreshing = true;
      renderHeaderAndCaps();
      const minSpin = new Promise((resolve) => setTimeout(resolve, 560));
      try {
        await Promise.all([refresh({ force: true }), minSpin]);
      } finally {
        if (!state.destroyed) {
          state.manualRefreshing = false;
          renderHeaderAndCaps();
        }
      }
    }

    let lastEffectiveVisible = isEffectivelyVisible();
    function handleVisibilityTransition() {
      const nowVisible = isEffectivelyVisible();
      if (nowVisible === lastEffectiveVisible) return;
      lastEffectiveVisible = nowVisible;
      if (!nowVisible) {
        state.refreshEpoch += 1;
        state.inFlight = false;
        state.queuedRefresh = false;
        state.needsRefreshOnVisible = true;
        stopTimers();
        return;
      }
      void refresh();
    }

    const onDocumentVisibilityChange = () => {
      if (state.destroyed) return;
      handleVisibilityTransition();
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onDocumentVisibilityChange);
    }

    const unsubscribe =
      adapter && adapter.subscribe
        ? adapter.subscribe((update) => {
            if (state.destroyed) return;
            let dataChanged = false;
            if (
              update &&
              update.sessionId !== undefined &&
              update.sessionId !== state.callerSessionId
            ) {
              state.callerSessionId = update.sessionId || null;
              state.userPinnedScope = false;
              resetSessionViewState();
              dataChanged = true;
            }
            if (update && update.workspaceLabel !== undefined) {
              const nextWs = update.workspaceLabel || '';
              if (nextWs !== state.workspace) {
                state.workspace = nextWs;
                dataChanged = true;
              }
            }
            if (update && update.visible !== undefined) {
              state.hostVisible = Boolean(update.visible);
            }
            if (dataChanged) renderAll();
            const prevVisible = lastEffectiveVisible;
            handleVisibilityTransition();
            if (dataChanged && prevVisible && isEffectivelyVisible()) {
              if (state.inFlight) {
                state.inFlight = false;
                state.queuedRefresh = false;
              }
              void refresh();
            } else if (dataChanged && !isEffectivelyVisible()) {
              state.needsRefreshOnVisible = true;
              stopTimers();
            }
          })
        : null;

    renderAll();
    if (isEffectivelyVisible()) {
      void refresh();
    } else {
      state.needsRefreshOnVisible = true;
    }

    return {
      refresh,
      setScope(nextScope) {
        applyScopeSelection(nextScope, true);
      },
      setVisible(nextVisible) {
        if (state.destroyed) return;
        state.hostVisible = Boolean(nextVisible);
        handleVisibilityTransition();
      },
      destroy() {
        state.destroyed = true;
        state.queuedRefresh = false;
        stopTimers();
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
        }
        if (typeof unsubscribe === 'function') unsubscribe();
        container.textContent = '';
      },
    };
  }

  return { mount };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.CospanBoard = CospanBoard;
}
