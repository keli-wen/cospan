/* global window, document, fetch, URL, URLSearchParams, AbortController */
window.__ModuleLoader__.load({
  id: 'cospan-dsh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const TAB_ID = 'cospan-dsh';
    const TAB_KIND = 'cospan';
    const STYLE_TAG_ID = 'cospan-dsh/board.css';
    const DSH_IDLE_POLL_MS = 30000;
    const COSPAN_API_PREFIX = 'cospan';
    const COSPAN_REQUEST_HEADER = 'X-Cospan-Request';

    const COSPAN_BOARD_CSS = '__COSPAN_BOARD_CSS_PLACEHOLDER__';

    /* __COSPAN_JS_START__ */
    const CospanBoard = globalThis.CospanBoard;
    /* __COSPAN_JS_END__ */

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      let styleEl = document.getElementById(STYLE_TAG_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_TAG_ID;
        document.head.appendChild(styleEl);
      }
      if (styleEl.textContent !== COSPAN_BOARD_CSS) {
        styleEl.textContent = COSPAN_BOARD_CSS;
      }
    }

    function CospanEmblem(props) {
      const size = (props && props.size) || 15;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          shapeRendering: 'crispEdges',
          'aria-hidden': 'true',
          style: { flexShrink: 0, display: 'block' },
        },
        h(
          'g',
          { fill: '#3B35B5' },
          h('rect', { x: 3, y: 1, width: 14, height: 1 }),
          h('rect', { x: 2, y: 2, width: 16, height: 1 }),
          h('rect', { x: 0, y: 3, width: 20, height: 4 }),
          h('rect', { x: 5, y: 7, width: 10, height: 1 }),
          h('rect', { x: 7, y: 8, width: 6, height: 1 }),
          h('rect', { x: 8, y: 9, width: 4, height: 1 }),
          h('rect', { x: 9, y: 10, width: 2, height: 1 }),
          h('rect', { x: 0, y: 13, width: 2, height: 1 }),
          h('rect', { x: 18, y: 13, width: 2, height: 1 }),
          h('rect', { x: 0, y: 14, width: 4, height: 1 }),
          h('rect', { x: 16, y: 14, width: 4, height: 1 }),
          h('rect', { x: 0, y: 15, width: 5, height: 1 }),
          h('rect', { x: 15, y: 15, width: 5, height: 1 }),
          h('rect', { x: 0, y: 16, width: 6, height: 1 }),
          h('rect', { x: 14, y: 16, width: 6, height: 1 }),
          h('rect', { x: 1, y: 17, width: 5, height: 1 }),
          h('rect', { x: 14, y: 17, width: 5, height: 1 }),
          h('rect', { x: 2, y: 18, width: 5, height: 1 }),
          h('rect', { x: 13, y: 18, width: 5, height: 1 }),
          h('rect', { x: 3, y: 19, width: 4, height: 1 }),
          h('rect', { x: 13, y: 19, width: 4, height: 1 })
        ),
        h(
          'g',
          { fill: '#4C46CC' },
          h('rect', { x: 3, y: 0, width: 14, height: 1 }),
          h('rect', { x: 2, y: 1, width: 1, height: 1 }),
          h('rect', { x: 17, y: 1, width: 1, height: 1 }),
          h('rect', { x: 1, y: 2, width: 1, height: 1 }),
          h('rect', { x: 18, y: 2, width: 1, height: 1 })
        ),
        h(
          'g',
          { fill: '#00C48C' },
          h('rect', { x: 0, y: 7, width: 5, height: 1 }),
          h('rect', { x: 0, y: 8, width: 7, height: 1 }),
          h('rect', { x: 0, y: 9, width: 8, height: 1 }),
          h('rect', { x: 0, y: 10, width: 9, height: 1 }),
          h('rect', { x: 0, y: 11, width: 10, height: 1 }),
          h('rect', { x: 0, y: 12, width: 9, height: 1 }),
          h('rect', { x: 2, y: 13, width: 6, height: 1 }),
          h('rect', { x: 4, y: 14, width: 4, height: 1 }),
          h('rect', { x: 5, y: 15, width: 3, height: 1 }),
          h('rect', { x: 6, y: 16, width: 1, height: 2 })
        ),
        h(
          'g',
          { fill: '#00B4FF' },
          h('rect', { x: 15, y: 7, width: 5, height: 1 }),
          h('rect', { x: 13, y: 8, width: 7, height: 1 }),
          h('rect', { x: 12, y: 9, width: 8, height: 1 }),
          h('rect', { x: 11, y: 10, width: 9, height: 1 }),
          h('rect', { x: 10, y: 11, width: 10, height: 1 }),
          h('rect', { x: 11, y: 12, width: 9, height: 1 }),
          h('rect', { x: 12, y: 13, width: 6, height: 1 }),
          h('rect', { x: 12, y: 14, width: 4, height: 1 }),
          h('rect', { x: 12, y: 15, width: 3, height: 1 }),
          h('rect', { x: 13, y: 16, width: 1, height: 2 })
        ),
        h(
          'g',
          { fill: '#FFE03D' },
          h('rect', { x: 9, y: 12, width: 2, height: 1 }),
          h('rect', { x: 8, y: 13, width: 4, height: 3 }),
          h('rect', { x: 7, y: 16, width: 6, height: 4 })
        )
      );
    }

    function CospanTabTitle(props) {
      const info = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      const label = (info && info.tab && info.tab.title) || 'cospan';
      return h(
        React.Fragment,
        null,
        h(
          'span',
          { style: { display: 'inline-flex', marginRight: 6, alignItems: 'center' } },
          h(CospanEmblem, { size: 15 })
        ),
        label
      );
    }

    function createHeaderAction(ctx) {
      return function CospanHeaderAction() {
        const onClick = React.useCallback(() => {
          try {
            const target =
              ctx.sidebarRight && typeof ctx.sidebarRight.commandTarget === 'function'
                ? ctx.sidebarRight.commandTarget(null)
                : undefined;
            if (target !== undefined && ctx.sidebarRight.openTabFromTarget) {
              ctx.sidebarRight.openTabFromTarget(TAB_KIND, target);
              return;
            }
            if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
              ctx.sidebarRight.openTab(TAB_KIND);
            }
          } catch {
            /* ignore host navigation errors */
          }
        }, []);

        return h(
          'button',
          {
            type: 'button',
            className: 'cospan-dsh-header-btn cospan-mono',
            onClick,
            title: 'Cospan · Cross-harness task delegation (agy, codex, claude, dsh)',
          },
          h(CospanEmblem, { size: 15 }),
          h('span', null, 'cospan')
        );
      };
    }

    class CospanErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'cospan-board', style: { padding: '16px', gap: '8px' } },
            h(
              'div',
              { style: { fontWeight: 600, color: 'var(--cospan-error-ink)' } },
              'Cospan sidebar error'
            ),
            h(
              'div',
              { className: 'cospan-mono', style: { fontSize: '11px' } },
              String((this.state.error && this.state.error.message) || this.state.error)
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cospan-action-btn',
                onClick: () => this.setState({ error: null }),
              },
              'Retry'
            )
          );
        }
        return this.props.children;
      }
    }

    function resolveHostRouteUrl(route, query) {
      const baseRaw =
        typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI
          ? document.baseURI
          : typeof window !== 'undefined' && window.location && window.location.href
            ? window.location.href
            : 'http://127.0.0.1/';
      const base = new URL(baseRaw);
      base.search = '';
      base.hash = '';
      if (!base.pathname.endsWith('/')) {
        base.pathname = `${base.pathname}/`;
      }
      const cleanRoute = String(route || '').replace(/^\/+/, '');
      const url = new URL(`${COSPAN_API_PREFIX}/${cleanRoute}`, base);
      if (query) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null && value !== '') {
            params.set(key, String(value));
          }
        }
        const qs = params.toString();
        if (qs) url.search = `?${qs}`;
      }
      return url.toString();
    }

    async function requestCospanApi(route, options) {
      const opts = options || {};
      const method = opts.method || 'GET';
      const url = resolveHostRouteUrl(route, opts.query);
      const headers = { [COSPAN_REQUEST_HEADER]: '1' };
      const init = {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
      };
      if (opts.signal) init.signal = opts.signal;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      const res = await fetch(url, init);
      let parsed = null;
      try {
        parsed = await res.json();
      } catch {
        /* ignore non-JSON error responses */
      }
      if (!res.ok) {
        const msg =
          (parsed && (parsed.error || parsed.message)) ||
          `Cospan API request failed (HTTP ${res.status})`;
        throw new Error(msg);
      }
      return parsed || { ok: true };
    }

    function createSidebarBody() {
      function CospanSidebarMount(props) {
        const sessionId = (props && props.sessionId) || null;
        const inputActions = (props && props.inputActions) || null;
        const tabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
        const tabVisible =
          tabInfo && tabInfo.tab && typeof tabInfo.tab.visible === 'boolean'
            ? tabInfo.tab.visible
            : true;

        const containerRef = React.useRef(null);
        const sessionRef = React.useRef(sessionId);
        const visibleRef = React.useRef(tabVisible);
        const inputActionsRef = React.useRef(inputActions);
        inputActionsRef.current = inputActions;
        const listenersRef = React.useRef(new Set());
        const boardAbortRef = React.useRef(null);

        function abortInFlightBoard() {
          if (boardAbortRef.current) {
            try {
              boardAbortRef.current.abort();
            } catch {
              /* ignore */
            }
            boardAbortRef.current = null;
          }
        }

        React.useEffect(() => {
          ensureStyles();
          const node = containerRef.current;
          if (!node || !CospanBoard || typeof CospanBoard.mount !== 'function') return undefined;

          const adapter = {
            host: 'dsh',
            idlePollMs: DSH_IDLE_POLL_MS,
            getInitialState() {
              return {
                workspaceLabel: '',
                sessionId: sessionRef.current,
                visible: visibleRef.current,
              };
            },
            subscribe(onUpdate) {
              listenersRef.current.add(onUpdate);
              return () => listenersRef.current.delete(onUpdate);
            },
            prefillInput(draftText) {
              const actions = inputActionsRef.current;
              if (!actions) return;
              if (typeof actions.setDraft === 'function') {
                actions.setDraft(draftText);
              } else if (
                typeof actions.insertText === 'function' &&
                typeof actions.captureInsertion === 'function'
              ) {
                actions.insertText(draftText, actions.captureInsertion());
              }
            },
            async fetchBoard({ scope }) {
              if (!sessionRef.current) {
                return {
                  workspace: '',
                  caller_session_id: null,
                  jobs: [],
                  notice: 'Open a conversation session to view workspace tasks.',
                };
              }
              abortInFlightBoard();
              const controller =
                typeof AbortController === 'function' ? new AbortController() : null;
              boardAbortRef.current = controller;
              try {
                return await requestCospanApi('board', {
                  method: 'GET',
                  query: { sessionId: sessionRef.current, scope },
                  signal: controller ? controller.signal : undefined,
                });
              } finally {
                if (boardAbortRef.current === controller) {
                  boardAbortRef.current = null;
                }
              }
            },
            async fetchDetail(jobId) {
              if (!sessionRef.current) return { ok: false };
              return requestCospanApi('detail', {
                method: 'GET',
                query: { sessionId: sessionRef.current, id: jobId },
              });
            },
            async cancelJob(jobId) {
              if (!sessionRef.current) {
                return { ok: false, message: 'No active DSH session.' };
              }
              return requestCospanApi('cancel', {
                method: 'POST',
                body: { sessionId: sessionRef.current, id: jobId },
              });
            },
          };

          const instance = CospanBoard.mount(node, adapter);
          return () => {
            abortInFlightBoard();
            instance.destroy();
          };
        }, []);

        React.useEffect(() => {
          if (sessionRef.current === sessionId) return;
          sessionRef.current = sessionId;
          abortInFlightBoard();
          for (const listener of listenersRef.current) {
            listener({ sessionId });
          }
        }, [sessionId]);

        React.useEffect(() => {
          if (visibleRef.current === tabVisible) return;
          visibleRef.current = tabVisible;
          if (!tabVisible) abortInFlightBoard();
          for (const listener of listenersRef.current) {
            listener({ visible: tabVisible });
          }
        }, [tabVisible]);

        return h('div', {
          ref: containerRef,
          style: {
            height: '100%',
            width: '100%',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          },
        });
      }

      return function CospanSidebarBody(props) {
        return h(CospanErrorBoundary, null, h(CospanSidebarMount, props));
      };
    }

    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    function apply(ctx) {
      ensureStyles();
      const SidebarBody = createSidebarBody();
      const HeaderAction = createHeaderAction(ctx);

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => 'cospan',
            guide: [
              {
                id: 'cospan',
                order: 26,
                title: () => 'cospan',
                description: () => 'Cross-harness delegation · agy, codex, claude & dsh',
                icon: CospanEmblem,
              },
            ],
          }),
        'cospan: sidebar tab type'
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, SidebarBody)
          ),
        'cospan: sidebar tab body'
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
              CospanTabTitle
            )
          ),
        'cospan: sidebar tab title'
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'cospan-header-action',
                order: 16,
              },
              HeaderAction
            )
          ),
        'cospan: session header button'
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
