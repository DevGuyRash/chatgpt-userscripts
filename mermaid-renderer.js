// ==UserScript==
// @name         ChatGPT Mermaid Renderer
// @namespace    http://tampermonkey.net/
// @version      1.0.4
// @description  Mermaid in ChatGPT with tabs, dark/light, transparent/high-contrast defaults, lazy+cache, per-diagram zoom (editable), sticky controls, vertical/horizontal scroll, fixed-box toggle (restores original height), robust error handling, and cleanup of Mermaid's temporary containers to prevent page-level scrollbars. Shows full parse errors (line/column + excerpt) in-place and provides copy buttons for both code and error.
// @author       DevGuyRash
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js
// ==/UserScript==

(function () {
    'use strict';
  
    // --------------------------- Config ---------------------------
    const CONFIG = {
      tabsPosition: 'top',          // 'top' | 'bottom'
      lazyRender: true,
      rerenderOnThemeChange: true,
      maxCacheEntries: 60,
      rootMargin: '150px',
  
      // Zoom config
      zoom: { min: 0.1, max: 10, step: 0.15, bigStep: 0.35 }, // 10%–1000%
  
      // Vertical behavior
      maxViewportHeightRatio: 0.72, // pane max-height ≈ 72vh
      minMaxHeightPx: 260,          // never clamp below this
      verticalSafetyPx: 120,        // leave space for header/composer
      zoomPadPx: 36,                // bottom padding so overlay never covers SVG
      minPaneHeightPx: 220,         // ensure controls have breathing room
  
      // Default: keep pane size constant (reserve original height)
      fixedBoxDefault: true,
    };
  
    // --------------------------- State ----------------------------
    const processed = new WeakSet();
    const paneRaw = new WeakMap();
    const paneRendered = new WeakMap();
    const hostGroupByPane = new WeakMap();
  
    const paneSourcePre = new WeakMap();
    const preOldStyle = new WeakMap();
  
    // Zoom & layout state
    const paneSvg = new WeakMap();           // pane -> <svg>
    const paneScale = new WeakMap();         // pane -> number (1 = 100%)
    const paneBaseW = new WeakMap();         // pane -> base width px at 100%
    const paneFixedBox = new WeakMap();      // pane -> boolean (fixed box mode on/off)
    const paneFloorH = new WeakMap();        // pane -> fitted floor (when 100% & no scrollbars)
    const paneInitFloorH = new WeakMap();    // pane -> original container height at first render (pinned height)
    const paneCopyText = new WeakMap();      // pane -> original source text (preserve formatting)
    const paneBaselineSource = new WeakMap();// pane -> original baseline source
    const paneSettingsState = new WeakMap(); // pane -> settings popover state
    const paneErrorText = new WeakMap();     // pane -> last error string (full)
  
    const panesBySource = new WeakMap();     // pre -> Set<pane>
    const sourceObservers = new WeakMap();   // pre -> MutationObserver
    const sourceUpdateTimers = new WeakMap();// pre -> timeout id
    const paneErrorBox = new WeakMap();      // pane -> error element
    const allPanes = new Set();
    let lightboxOverlay = null;
    let lightboxKeyHandler = null;
    let lightboxSourcePane = null;
    const copyResetTimers = new WeakMap();
    const copyToastTimers = new WeakMap();
  
    let styleTag = null;
    let theme = detectTheme();               // 'dark' | 'default'
    const schedule = debounce(processAll, 60);
  
    // Render queue + rich parseError capture
    let renderChain = Promise.resolve();
    let activeRenderId = null;               // id currently rendering (guarded by renderChain)
    /** @type {Map<string, Array<{message:string,line?:number,col?:number}>>} */
    const renderErrorLog = new Map();        // id -> list of error info
  
    // LRU cache keyed by theme+code
    const svgCache = (() => {
      const map = new Map();
      const key = (t, c) => t + '|' + hash32(c);
      return {
        get(t, c) { const k = key(t,c); if (!map.has(k)) return null; const v = map.get(k); map.delete(k); map.set(k, v); return v; },
        set(t, c, svg) { const k = key(t,c); if (map.has(k)) map.delete(k); map.set(k, svg); if (map.size > CONFIG.maxCacheEntries) map.delete(map.keys().next().value); }
      };
    })();
  
    // Theme defaults (only injected when a diagram provides none)
    const THEME_DEFAULTS = {
      default: {
        background: 'transparent',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, "Noto Sans", "Helvetica Neue", Arial',
        textColor: '#0f172a',
        lineColor: '#334155',
        primaryColor: '#ffffff',
        primaryTextColor: '#0f172a',
        primaryBorderColor: '#94a3b8',
        secondaryColor: '#f8fafc',
        tertiaryColor: '#eef2ff',
        clusterBkg: '#f8fafc',
        clusterBorder: '#94a3b8',
        edgeLabelBackground: '#00000000'
      },
      dark: {
        background: 'transparent',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, "Noto Sans", "Helvetica Neue", Arial',
        textColor: '#e5e7eb',
        lineColor: '#94a3b8',
        primaryColor: '#111827',
        primaryTextColor: '#e5e7eb',
        primaryBorderColor: '#475569',
        secondaryColor: '#0f172a',
        tertiaryColor: '#1f2937',
        clusterBkg: '#0f172a',
        clusterBorder: '#334155',
        edgeLabelBackground: '#00000000'
      }
    };
  
    // --------------------------- Boot -----------------------------
    injectStyle(theme);
    if (!initMermaid(theme)) return;
    hookMermaidErrorHandler();
    killGlobalErrorBanners();
    watchForErrorBanners();
  
    observeDom();
    observeTheme();
    observeColorScheme();
  
    schedule(); setTimeout(schedule, 600); setTimeout(schedule, 2000);
  
    window.addEventListener('resize', debounce(() => {
      document.querySelectorAll('.userscript-mermaid-pane').forEach((pane) => {
        // Re-apply size rules on resize
        applyMaxHeight(pane);
        maybeUpdateBaseline(pane);
        updateFixedBoxSizing(pane);
        applyOverlayPadding(pane);
      });
    }, 80));
  
    // ------------------------ Init / Theme ------------------------
    function initMermaid(themeName) {
      if (!window.mermaid?.initialize) { console.warn('[Mermaid] not available'); return false; }
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: themeName,
        flowchart: { useMaxWidth: true },
        sequence: { useMaxWidth: true },
        er: { useMaxWidth: true }
      });
      return true;
    }
  
    function detectTheme() {
      const root = document.documentElement;
      const cls = root.classList;
      if (cls.contains('dark')) return 'dark';
      if (cls.contains('light')) return 'default';
      const scheme = (root.getAttribute('style') || '').match(/color-scheme:\s*(dark|light)/i)?.[1];
      if (scheme === 'dark') return 'dark';
      if (scheme === 'light') return 'default';
      const dt = root.getAttribute('data-theme');
      if (dt && /dark/i.test(dt)) return 'dark';
      if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
      return 'default';
    }
  
    function injectStyle(mode) {
      const isDark = mode === 'dark';
      const tabBg = isDark ? '#0f172a' : '#f8fafc';
      const tabBorder = isDark ? '#334155' : '#e5e7eb';
  
      const tabText = isDark ? '#e2e8f0' : '#0f172a';
      const tabMuted = isDark ? '#94a3b8' : '#64748b';
      const tabActive = isDark ? '#111827' : '#ffffff';
      const tabHover = isDark ? '#1f2937' : '#eef2ff';
      const ctrlBg = isDark ? 'rgba(15,23,42,0.7)' : 'rgba(255,255,255,0.82)';
      const ctrlBd = isDark ? '#334155' : '#d0d7e5';
      const ctrlTx = isDark ? '#e2e8f0' : '#0f172a';
      const ctrlDivider = isDark ? 'rgba(148,163,184,0.55)' : 'rgba(100,116,139,0.35)';
  
      const css = `
  /* Pane isolates layout so siblings don't borrow sizes during reflow */
  .userscript-mermaid-pane {
    position: relative; margin: 0;
    box-sizing: border-box; contain: layout paint;
  }
  
  /* Scroller contains the SVG; we set height/max-height inline per pane */
  .userscript-mermaid-pane .usm-scroll {
    overflow: auto;
    box-sizing: border-box; /* keep padding inside height to avoid page scrollbars */
    padding-bottom: 0;
    max-height: none;
  }
  
  /* SVG hygiene */
  .userscript-mermaid-pane .usm-scroll > svg {
    max-width: 100%; height: auto; display: block;
    background: transparent !important;
  }
  
  .userscript-mermaid-hidden { display:none !important; }
  
  /* Tab group */
  .userscript-mermaid-tabs { margin:8px 0; border:1px solid ${tabBorder}; border-radius:10px; overflow:clip; background:${tabActive}; }
  .userscript-mermaid-tabs .usm-tabbar { display:flex; gap:4px; padding:6px; background:${tabBg}; border-bottom:1px solid ${tabBorder}; }
  .userscript-mermaid-tabs.usm-bottom .usm-tabbar { order:2; border-top:1px solid ${tabBorder}; border-bottom:0; }
  .userscript-mermaid-tabs .usm-tabbar button {
    appearance:none; border:1px solid ${tabBorder}; background:${tabActive}; color:${tabMuted};
    padding:4px 8px; border-radius:8px; font:500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, "Noto Sans", "Helvetica Neue", Arial;
    cursor:pointer; white-space:nowrap;
  }
  .userscript-mermaid-tabs .usm-tabbar button[aria-selected="true"] { color:${tabText}; }
  .userscript-mermaid-tabs .usm-tabbar button:hover { background:${tabHover}; }
  .userscript-mermaid-tabs .usm-content { padding:10px; }
  
  /* Toolbar */
  .usm-toolbar {
    position:absolute; top:8px; right:8px;
    display:flex; gap:6px; align-items:center;
    background:${ctrlBg}; border:1px solid ${ctrlBd}; padding:4px;
    border-radius:10px; backdrop-filter:saturate(120%) blur(4px);
    color:${ctrlTx};
  }
  .usm-tool {
    appearance:none; border:1px solid ${ctrlBd}; background:transparent;
    color:inherit; width:28px; height:28px;
    border-radius:8px; display:flex; align-items:center; justify-content:center;
    font:600 13px system-ui,-apple-system,Segoe UI,Roboto; cursor:pointer;
    transition:background 120ms ease, filter 120ms ease;
  }
  .usm-tool:hover:not(:disabled) { filter:brightness(1.1); }
  .usm-tool:disabled { opacity:0.4; cursor:default; }
  .usm-tool .usm-icon { pointer-events:none; }
  .usm-tool.usm-settings .usm-icon { font-size:16px; }
  .usm-copy-active { background:${isDark ? 'rgba(34,197,94,0.25)' : 'rgba(34,197,94,0.16)'}; border-color:${isDark ? '#22c55e' : '#34d399'}; color:${isDark ? '#bbf7d0' : '#166534'}; }
  .usm-copy-failed { background:${isDark ? 'rgba(248,113,113,0.2)' : 'rgba(248,113,113,0.28)'}; border-color:${isDark ? '#f87171' : '#f87171'}; color:${isDark ? '#fecaca' : '#7f1d1d'}; }
  .usm-copy-toast {
    position:absolute; right:0; top:100%; margin-top:6px;
    padding:4px 8px; border-radius:6px;
    background:${ctrlBg}; border:1px solid ${ctrlBd}; color:${ctrlTx};
    font:600 11px system-ui,-apple-system,Segoe UI,Roboto;
    opacity:0; transform:translateY(-4px);
    transition:opacity 160ms ease, transform 160ms ease;
    pointer-events:none; white-space:nowrap;
  }
  .usm-toast-visible { opacity:1; transform:translateY(0); }
  
  /* Settings panel */
  .usm-settings-panel {
    position:fixed; z-index:9998;
    background:${ctrlBg}; color:${ctrlTx};
    border:1px solid ${ctrlBd}; border-radius:14px;
    padding:16px; width:min(320px, calc(100vw - 32px));
    box-shadow:0 22px 48px rgba(15,23,42,0.32);
    backdrop-filter:saturate(140%) blur(12px);
    color:${ctrlTx};
  }
  .usm-settings-panel h3 { margin:0 0 12px; font:700 14px system-ui,-apple-system,Segoe UI,Roboto; }
  .usm-settings-panel label { display:block; margin-bottom:6px; font:600 12px system-ui,-apple-system,Segoe UI,Roboto; }
  .usm-settings-panel textarea {
    width:100%; min-height:120px;
    border:1px solid ${ctrlBd}; border-radius:10px;
    background:rgba(15,23,42,0.04); color:${ctrlTx};
    padding:8px; font:500 12px/1.4 "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
    resize:vertical;
  }
  .usm-settings-panel textarea:focus { outline:2px solid ${isDark ? '#38bdf8' : '#0284c7'}; outline-offset:1px; }
  .usm-settings-hint { margin:6px 0 0; font:500 11px system-ui,-apple-system,Segoe UI,Roboto; opacity:0.75; }
  .usm-settings-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
  .usm-settings-actions button {
    appearance:none; border:1px solid ${ctrlBd}; border-radius:8px;
    background:transparent; color:${ctrlTx}; padding:6px 12px;
    font:600 12px system-ui,-apple-system,Segoe UI,Roboto; cursor:pointer;
    transition:filter 120ms ease;
  }
  .usm-settings-actions button:hover { filter:brightness(1.08); }
  .usm-settings-status { margin-top:10px; font:600 12px system-ui,-apple-system,Segoe UI,Roboto; }
  .usm-settings-status.usm-error { color:${isDark ? '#fda4af' : '#b91c1c'}; }
  .usm-settings-status.usm-success { color:${isDark ? '#bbf7d0' : '#166534'}; }
  
  /* D-pad controls */
  .usm-dpad {
    position:absolute; right:8px; bottom:8px;
    display:flex; flex-direction:column; align-items:flex-end; gap:4px;
  }
  .usm-dpad-grid {
    position:relative;
    width:112px; aspect-ratio:1/1;
    display:grid; grid-template-columns:repeat(3, minmax(0, 1fr));
    grid-template-rows:repeat(3, minmax(0, 1fr));
    gap:3px; background:${ctrlBg}; border:1px solid ${ctrlBd};
    border-radius:14px; padding:4px; backdrop-filter:saturate(140%) blur(4px);
    align-items:stretch; justify-items:stretch; overflow:hidden;
  }
  .usm-dpad .usm-btn {
    appearance:none; border:1px solid ${ctrlBd}; background:transparent; color:${ctrlTx};
    border-radius:8px;
    font:600 12px system-ui,-apple-system,Segoe UI,Roboto; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:background 120ms ease, filter 120ms ease;
    width:100%; height:100%; min-width:0; min-height:0;
  }
  .usm-dpad .usm-btn:hover { filter:brightness(1.1); }
  .usm-dpad .usm-reset { font-size:18px; }
  .usm-gap { width:100%; height:100%; }
  .usm-dpad-footer {
    width:112px; height:32px;
    display:grid; grid-template-columns:repeat(2, minmax(0, 1fr));
    background:${ctrlBg}; border:1px solid ${ctrlBd}; border-radius:12px;
    overflow:hidden; backdrop-filter:saturate(140%) blur(4px);
  }
  .usm-dpad-footer > * { display:flex; align-items:center; justify-content:center; background:transparent; cursor:pointer; transition:filter 120ms ease; }
  .usm-dpad-footer > *:not(:first-child) { border-left:1.5px solid ${ctrlDivider}; }
  .usm-dpad-footer .usm-btn,
  .usm-dpad-footer .usm-zoom-box {
    border:0; border-radius:0;
    font:600 12px system-ui,-apple-system,Segoe UI,Roboto;
    color:${ctrlTx}; width:100%; height:100%;
    backdrop-filter:none;
  }
  .usm-dpad .usm-toggle { appearance:none; }
  .usm-dpad .usm-toggle[aria-pressed="true"] { filter:brightness(1.15); }
  .usm-zoom-box {
    appearance:none; border:1px solid ${ctrlBd}; background:${ctrlBg}; color:${ctrlTx};
    border-radius:10px; padding:4px 10px; min-width:0;
    font:600 12px system-ui,-apple-system,Segoe UI,Roboto; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    backdrop-filter:saturate(120%) blur(4px);
  }
  .usm-dpad-footer .usm-zoom-box { border:0; border-radius:0; width:100%; height:100%; backdrop-filter:none; }
  .usm-zoom-box:hover { filter:brightness(1.05); }
  .usm-zoom-val { font:600 12px system-ui,-apple-system,Segoe UI,Roboto; text-align:center; }
  .usm-zoom-input {
    width:60px; height:28px; border:1px solid ${ctrlBd};
    border-radius:8px; background:transparent; color:${ctrlTx};
    font:600 12px system-ui,-apple-system,Segoe UI,Roboto; text-align:center; outline:none;
  }
  
  /* Copy icon visuals */
  .usm-copy-icon { position:relative; width:16px; height:16px; display:block; }
  .usm-copy-square { position:absolute; width:12px; height:12px; border:1.6px solid ${ctrlBd}; border-radius:4px; background:${ctrlBg}; transition:opacity 160ms ease; }
  .usm-copy-square.primary { top:0; left:1px; }
  .usm-copy-square.secondary { top:4px; left:4px; }
  .usm-copy-mark { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font:700 12px system-ui,-apple-system,Segoe UI,Roboto; opacity:0; transition:opacity 160ms ease; }
  .usm-copy[data-icon="success"] .usm-copy-square, .usm-copy[data-icon="error"] .usm-copy-square { opacity:0; }
  .usm-copy[data-icon="success"] .usm-copy-mark { opacity:1; color:${isDark ? '#bbf7d0' : '#166534'}; }
  .usm-copy[data-icon="success"] .usm-copy-mark::before { content:'✔'; }
  .usm-copy[data-icon="error"] .usm-copy-mark { opacity:1; color:${isDark ? '#fecaca' : '#7f1d1d'}; }
  .usm-copy[data-icon="error"] .usm-copy-mark::before { content:'⚠'; }
  
  /* Error presentation inside pane */
  .usm-error-box {
    margin:10px; padding:14px; border:1px solid #fca5a5;
    border-radius:12px; background:#fef2f2; color:#991b1b;
    font:600 13px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;
  }
  .usm-error-box .usm-error-head { font-weight:800; }
  .usm-error-box pre {
    margin:8px 0 0; white-space:pre-wrap; word-break:break-word;
    font:500 12px/1.4 "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
    color:#7f1d1d;
  }
  
  /* Lightbox */
  .usm-lightbox {
    position:fixed; inset:0;
    background:${isDark ? 'rgba(8,15,28,0.9)' : 'rgba(15,23,42,0.75)'};
    display:flex; align-items:center; justify-content:center;
    z-index:9999; opacity:0; transition:opacity 160ms ease;
  }
  .usm-lightbox.usm-open { opacity:1; }
  .usm-lightbox-content {
    position:relative; max-width:90vw; max-height:90vh;
    background:${isDark ? '#0f172a' : '#eff6ff'};
    border:1px solid ${ctrlBd}; border-radius:16px;
    padding:24px; box-shadow:0 34px 60px rgba(15,23,42,0.35);
    color:${ctrlTx}; overflow:hidden;
  }
  .usm-lightbox-body { max-height:calc(90vh - 72px); overflow:auto; }
  .usm-lightbox-body svg { width:100%; height:auto; }
  .usm-lightbox-close {
    position:absolute; top:12px; right:12px;
    width:32px; height:32px; border:1px solid ${ctrlBd}; border-radius:9px;
    background:transparent; color:${ctrlTx}; cursor:pointer;
    font:600 16px/28px system-ui,-apple-system,Segoe UI,Roboto;
  }
  .usm-lightbox-close:hover { filter:brightness(1.1); }
  
  /* Accessibility: respect reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .userscript-mermaid-pane .usm-scroll { scroll-behavior: auto !important; }
    .userscript-mermaid-pane .usm-scroll > svg { transition: none !important; }
    .usm-tool, .usm-copy-toast, .usm-lightbox { transition: none !important; }
  }
  
  /* Defensive: if Mermaid still leaves a #d{mmd-id} container in <body>, ensure it never affects layout */
  div[id^="d"][id*="mmd-"] {
    position: fixed !important;
    left: -100000px !important; top: -100000px !important;
    width: 0 !important; height: 0 !important;
    overflow: hidden !important; padding: 0 !important; margin: 0 !important; border: 0 !important;
    pointer-events: none !important; contain: layout style paint !important;
  }
  `;
      if (!styleTag) { styleTag = document.createElement('style'); styleTag.id = 'userscript-mermaid-style'; document.head.appendChild(styleTag); }
      styleTag.textContent = css;
    }
  
    // -------------------- Global error suppression + capture ----------------
    function hookMermaidErrorHandler() {
      const handler = (err, ctx) => {
        const msg = String(err?.message || err?.str || err || '').trim();
        if (activeRenderId) {
          const list = renderErrorLog.get(activeRenderId) || [];
          const info = { message: msg };
          // Extract line/column if present in ctx
          const h = (ctx && (ctx.hash || ctx)) || {};
          const loc = h.loc || h.location || h.yy && h.yy.loc || h.startPos || h.pos || {};
          const maybe = (k) => Number.isFinite(+k) ? +k : undefined;
          const lineGuess =
            maybe(h.line) ?? maybe(loc.line) ?? maybe(loc.first_line) ?? maybe(loc.start?.line);
          const colGuess =
            maybe(h.col) ?? maybe(loc.col) ?? maybe(loc.first_column) ?? maybe(loc.start?.column);
          if (lineGuess != null) info.line = lineGuess;
          if (colGuess != null) info.col = colGuess;
  
          // Also try to pull "line X, column Y" out of message
          const mLine = /line\s*[:\-]?\s*(\d+)/i.exec(msg); if (mLine) info.line ??= +mLine[1];
          const mCol  = /col(?:umn)?\s*[:\-]?\s*(\d+)/i.exec(msg); if (mCol) info.col ??= +mCol[1];
  
          list.push(info);
          renderErrorLog.set(activeRenderId, list);
        }
        console.warn('[Mermaid parseError]', msg, ctx);
      };
      try { window.mermaid.parseError = handler; } catch {}
      try { window.mermaid.mermaidAPI.parseError = handler; } catch {}
    }
  
    function killGlobalErrorBanners(root = document) {
      const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_ELEMENT, null);
      const doomed = [];
      while (walker.nextNode()) {
        const el = /** @type {Element} */(walker.currentNode);
        if (/Syntax error in text\s*mermaid version/i.test(el.textContent || '')) doomed.push(el);
      }
      doomed.forEach(el => el.remove());
    }
    function watchForErrorBanners() {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType === 1 && /Syntax error in text\s*mermaid version/i.test(n.textContent || '')) n.remove();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  
    // ---------------------- Block discovery ----------------------
    function findCandidateBlocks() {
      const out = [];
      document.querySelectorAll('code.language-mermaid, code[class*="language-mermaid"]').forEach(c => { if (!processed.has(c)) out.push(c); });
      document.querySelectorAll('code.mermaid, pre.mermaid').forEach(n => { if (!processed.has(n)) out.push(n); });
      const head = /^(?:%%\{.*\}%%\s*)?(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart-beta)\b/i;
      document.querySelectorAll('pre code:not(.language-mermaid):not(.mermaid)').forEach(code => {
        if (processed.has(code)) return;
        const txt = code.textContent?.trimStart();
        if (txt && head.test(txt)) out.push(code);
      });
      return out;
    }
  
    // --------------------- Transform & render --------------------
    function processAll() {
      const blocks = findCandidateBlocks();
      for (const node of blocks) toPane(node);
    }
  
    function toPane(codeOrPre) {
      if (processed.has(codeOrPre)) return;
      processed.add(codeOrPre);
  
      const pre = codeOrPre.closest?.('pre') || codeOrPre;
      const rawFull = codeOrPre.textContent || '';
      const raw = rawFull.replace(/\r\n/g, '\n').trim();
  
      const pane = document.createElement('div');
      pane.className = 'userscript-mermaid-pane userscript-mermaid-hidden';
      pane.setAttribute('role', 'tabpanel');
      paneRaw.set(pane, raw);
      const normalizedFull = rawFull.replace(/\r\n/g, '\n');
      paneCopyText.set(pane, normalizedFull);
      if (!paneBaselineSource.has(pane)) paneBaselineSource.set(pane, normalizedFull);
      paneRendered.set(pane, false);
      paneSourcePre.set(pane, pre);
      paneFixedBox.set(pane, CONFIG.fixedBoxDefault);
  
      pre.after(pane);
  
      hideSourcePre(pre);
      trackPaneForSource(pre, pane);
      allPanes.add(pane);
  
      const grouped = maybeGroupWithPrevious(pane);
      const hasContent = !!raw;
      if (!grouped && hasContent) {
        pane.classList.remove('userscript-mermaid-hidden');
        if (CONFIG.lazyRender) lazyObserver.observe(pane);
        else renderPane(pane);
      } else if (grouped && hasContent) {
        if (CONFIG.lazyRender) lazyObserver.observe(pane);
      }
      cleanupOrphanPanes();
    }
  
    function maybeGroupWithPrevious(pane) {
      const prev = pane.previousElementSibling;
      if (prev?.classList.contains('userscript-mermaid-tabs')) { appendPaneToGroup(prev, pane); return true; }
      if (prev?.classList.contains('userscript-mermaid-pane')) {
        const group = createTabGroup(); prev.before(group);
        appendPaneToGroup(group, prev); appendPaneToGroup(group, pane); return true;
      }
      return false;
    }
  
    function createTabGroup() {
      const group = document.createElement('div');
      group.className = 'userscript-mermaid-tabs' + (CONFIG.tabsPosition === 'bottom' ? ' usm-bottom' : '');
      group.setAttribute('role', 'group');
  
      const tabbar = document.createElement('div');
      tabbar.className = 'usm-tabbar';
      tabbar.setAttribute('role', 'tablist');
  
      const content = document.createElement('div');
      content.className = 'usm-content';
      if (CONFIG.tabsPosition === 'bottom') { content.style.order = 1; tabbar.style.order = 2; }
  
      tabbar.addEventListener('keydown', (e) => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
        const tabs = Array.from(tabbar.querySelectorAll('button[role="tab"]'));
        const idx = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
        let next = idx;
        if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
        if (e.key === 'ArrowLeft')  next = (idx - 1 + tabs.length) % tabs.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End')  next = tabs.length - 1;
        tabs[next]?.click(); tabs[next]?.focus(); e.preventDefault();
      });
  
      group.append(tabbar, content);
      return group;
    }
  
    function appendPaneToGroup(group, pane) {
      const tabbar = group.querySelector('.usm-tabbar');
      const content = group.querySelector('.usm-content');
      const idx = tabbar.children.length + 1;
      const label = deriveTabLabel(paneRaw.get(pane), idx);
  
      const panel = document.createElement('div');
      panel.className = 'userscript-mermaid-pane userscript-mermaid-hidden';
      panel.setAttribute('role', 'tabpanel');
      paneRaw.set(panel, paneRaw.get(pane));
      paneCopyText.set(panel, paneCopyText.get(pane));
      const baseline = paneBaselineSource.get(pane) ?? paneCopyText.get(pane);
      if (baseline != null) paneBaselineSource.set(panel, baseline);
      paneRendered.set(panel, false);
      paneSourcePre.set(panel, paneSourcePre.get(pane));
      paneFixedBox.set(panel, paneFixedBox.get(pane) ?? CONFIG.fixedBoxDefault);
      const pre = paneSourcePre.get(pane);
      const svg = paneSvg.get(pane);
      if (svg) {
        try { roSvg.unobserve(svg); } catch {}
      }
      paneCopyText.delete(pane);
      paneSvg.delete(pane);
      paneScale.delete(pane);
      paneBaseW.delete(pane);
      paneFloorH.delete(pane);
      paneInitFloorH.delete(pane);
      paneFixedBox.delete(pane);
      paneErrorBox.delete(pane);
      paneBaselineSource.delete(pane);
      paneRendered.delete(pane);
      paneRaw.delete(pane);
      paneSourcePre.delete(pane);
      closeSettingsPopover(pane, { silent: true });
      if (pre) untrackPaneForSource(pre, pane);
      allPanes.delete(pane);
      pane.remove();
      content.appendChild(panel);
      if (pre) trackPaneForSource(pre, panel);
      allPanes.add(panel);
      hostGroupByPane.set(panel, group);
  
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.textContent = label;
      btn.addEventListener('click', () => activate(panel, btn));
      tabbar.appendChild(btn);
  
      if (idx === 1) btn.click();
      if (CONFIG.lazyRender) lazyObserver.observe(panel);
    }
  
    function hideSourcePre(pre) {
      if (!pre) return;
      if (!preOldStyle.has(pre)) preOldStyle.set(pre, pre.getAttribute('style') || '');
      pre.style.setProperty('display', 'none', 'important');
      pre.style.setProperty('margin-top', '0', 'important');
      pre.style.setProperty('margin-bottom', '0', 'important');
    }
  
    function trackPaneForSource(pre, pane) {
      if (!pre) return;
      let set = panesBySource.get(pre);
      if (!set) {
        set = new Set();
        panesBySource.set(pre, set);
        watchSource(pre);
      }
      set.add(pane);
    }
  
    function untrackPaneForSource(pre, pane) {
      if (!pre) return;
      const set = panesBySource.get(pre);
      if (!set) return;
      set.delete(pane);
      if (set.size === 0) {
        panesBySource.delete(pre);
        const obs = sourceObservers.get(pre);
        if (obs) { obs.disconnect(); sourceObservers.delete(pre); }
        const timer = sourceUpdateTimers.get(pre);
        if (timer) { clearTimeout(timer); sourceUpdateTimers.delete(pre); }
      }
    }
  
    function watchSource(pre) {
      if (!pre || sourceObservers.has(pre)) return;
      const observer = new MutationObserver(() => scheduleSourceRefresh(pre));
      observer.observe(pre, { subtree: true, characterData: true, childList: true });
      sourceObservers.set(pre, observer);
    }
  
    function readPreContent(pre) {
      if (!pre) return '';
      const code = pre.querySelector('code');
      if (code && code.textContent != null) return code.textContent;
      return pre.textContent || '';
    }
  
    function writePreContent(pre, text) {
      if (!pre) return;
      const code = pre.querySelector('code');
      if (code) code.textContent = text;
      else pre.textContent = text;
    }
  
    function scheduleSourceRefresh(pre) {
      if (!pre) return;
      if (sourceUpdateTimers.has(pre)) clearTimeout(sourceUpdateTimers.get(pre));
      const timer = setTimeout(() => {
        sourceUpdateTimers.delete(pre);
        const full = readPreContent(pre);
        const normalizedFull = full.replace(/\r\n/g, '\n');
        const raw = normalizedFull.trim();
        const panes = panesBySource.get(pre);
        if (!panes || panes.size === 0) return;
        if (!raw) return;
        for (const pane of panes) {
          if (!pane || !pane.isConnected) continue;
          if (!paneBaselineSource.has(pane)) paneBaselineSource.set(pane, normalizedFull);
          paneCopyText.set(pane, normalizedFull);
          if (paneRaw.get(pane) === raw && paneRendered.get(pane)) continue;
          paneRaw.set(pane, raw);
          paneRendered.set(pane, false);
          renderPane(pane);
        }
      }, 160);
      sourceUpdateTimers.set(pre, timer);
    }
  
    function detachPane(pane) {
      if (!pane) return;
      const pre = paneSourcePre.get(pane);
      const group = hostGroupByPane.get(pane);
      const svg = paneSvg.get(pane);
      if (copyResetTimers.has(pane)) { clearTimeout(copyResetTimers.get(pane)); copyResetTimers.delete(pane); }
      if (copyToastTimers.has(pane)) { clearTimeout(copyToastTimers.get(pane)); copyToastTimers.delete(pane); }
      if (svg) {
        try { roSvg.unobserve(svg); } catch {}
      }
      paneSvg.delete(pane);
      paneScale.delete(pane);
      paneBaseW.delete(pane);
      paneFloorH.delete(pane);
      paneInitFloorH.delete(pane);
      paneFixedBox.delete(pane);
      paneErrorBox.delete(pane);
      paneBaselineSource.delete(pane);
      paneRendered.delete(pane);
      paneRaw.delete(pane);
      paneSourcePre.delete(pane);
      closeSettingsPopover(pane, { silent: true });
      if (lightboxSourcePane === pane) closeLightbox();
      if (pre) untrackPaneForSource(pre, pane);
      allPanes.delete(pane);
      hostGroupByPane.delete(pane);
      if (!group || !group.isConnected) {
        pane.remove();
        return;
      }
      const tabbar = group.querySelector('.usm-tabbar');
      const content = group.querySelector('.usm-content');
      const panels = Array.from(content?.children || []);
      const idx = panels.indexOf(pane);
      const wasActive = !pane.classList.contains('userscript-mermaid-hidden');
      pane.remove();
      if (idx >= 0) tabbar?.children[idx]?.remove();
      if (!content || content.children.length === 0) {
        group.replaceWith(document.createComment('userscript mermaid group removed'));
        return;
      }
      if (content.children.length === 1) {
        const only = content.children[0];
        group.parentNode.insertBefore(only, group);
        group.remove();
        hostGroupByPane.delete(only);
        only.classList.remove('userscript-mermaid-hidden');
        return;
      }
      if (wasActive) {
        const nextIdx = Math.min(idx, tabbar.children.length - 1);
        tabbar.querySelectorAll('button[role="tab"]')[nextIdx]?.click();
      }
    }
  
    function cleanupOrphanPanes() {
      for (const pane of Array.from(allPanes)) {
        const pre = paneSourcePre.get(pane);
        if (!pane.isConnected || (pre && !pre.isConnected)) {
          detachPane(pane);
        }
      }
    }
  
    function deriveTabLabel(raw, idx) {
      const m1 = raw.match(/%%\s*title:\s*(.+?)\s*%%/i);
      if (m1) return m1[1].trim().slice(0, 56);
      const m2 = raw.match(/^\s*(?:%%\{.*\}%%\s*)?([a-zA-Z-]+)/);
      const head = m2 ? m2[1] : 'diagram';
      return `${head} ${idx}`;
    }
  
    function activate(panel, btn) {
      const group = hostGroupByPane.get(panel);
      const tabbar = group.querySelector('.usm-tabbar');
      const content = group.querySelector('.usm-content');
      Array.from(tabbar.querySelectorAll('button[role="tab"]')).forEach(b => b.setAttribute('aria-selected','false'));
      btn.setAttribute('aria-selected','true');
      Array.from(content.children).forEach(p => p.classList.add('userscript-mermaid-hidden'));
      panel.classList.remove('userscript-mermaid-hidden');
      if (!paneRendered.get(panel)) renderPane(panel);
      requestAnimationFrame(() => { snapshotInitialBaseline(panel); updateFixedBoxSizing(panel); });
    }
  
    async function renderPane(pane) {
      const raw = paneRaw.get(pane);
      if (!raw) return;
  
      const originalSourceForDisplay = getPaneSourceText(pane);
      const hadInit = /%%\s*\{\s*init\s*:\s*\{[\s\S]*?themeVariables\s*:/i.test(raw);
      const lineOffset = hadInit ? 0 : 1; // when we inject the init directive, mermaid's line numbers shift by +1
      const effective = ensureDefaultsIfMissing(raw, theme);
      const cached = svgCache.get(theme, effective);
      if (cached) {
        removeErrorState(pane);
        pane.innerHTML = cached;
        paneRendered.set(pane, true);
        const src = paneSourcePre.get(pane);
        if (src) hideSourcePre(src);
        afterRenderSetup(pane);
        if (!hostGroupByPane.get(pane)) pane.classList.remove('userscript-mermaid-hidden');
        return;
      }
  
      // Render in an off-screen scratch container; serialize renders to capture parseError reliably
      const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const scratch = document.createElement('div');
      scratch.setAttribute('data-usm-scratch', id);
      scratch.style.cssText = 'position:fixed;left:-100000px;top:-100000px;width:0;height:0;overflow:hidden;padding:0;margin:0;border:0;pointer-events:none;contain:layout style paint;';
      document.body.appendChild(scratch);
  
      try {
        const { svg } = await withRenderQueue(id, async () => {
          renderErrorLog.delete(id);
          return await window.mermaid.render(id, effective, scratch);
        });
  
        // Mermaid sometimes returns an "error SVG". Detect and grab its error message (not the echoed code).
        let svgMsg = extractMermaidErrorText(svg);
        if (svgMsg) {
          // Prefer parseError output if it exists; fall back to SVG message.
          const infos = renderErrorLog.get(id) || [];
          const pretty = formatMermaidError(originalSourceForDisplay, infos, svgMsg, null, lineOffset);
          throw createMermaidError(pretty);
        }
  
        const wrap = document.createElement('div'); wrap.innerHTML = svg;
        const svgEl = wrap.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = '100%';
          svgEl.style.height = 'auto';
          svgEl.style.background = 'transparent';
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
        }
        removeErrorState(pane);
        pane.innerHTML = svgEl ? svgEl.outerHTML : wrap.innerHTML;
        paneRendered.set(pane, true);
        svgCache.set(theme, effective, pane.innerHTML);
        const src = paneSourcePre.get(pane);
        if (src) hideSourcePre(src);
        afterRenderSetup(pane);
        if (!hostGroupByPane.get(pane)) pane.classList.remove('userscript-mermaid-hidden');
      } catch (err) {
        const infos = renderErrorLog.get(id) || [];
        const pretty = typeof err?.message === 'string' && /Mermaid error:/i.test(err.message)
          ? err.message.replace(/^Mermaid error:\s*/i, '')
          : formatMermaidError(originalSourceForDisplay, infos, null, String(err?.message || ''), lineOffset);
        onRenderError(pane, pretty || 'Mermaid rendering failed.');
      } finally {
        renderErrorLog.delete(id);
        try { document.getElementById('d' + id)?.remove(); } catch {}
        try { scratch.remove(); } catch {}
      }
    }
  
    // Serialize calls to mermaid.render so parseError can be mapped to the active id safely
    async function withRenderQueue(id, task) {
      const prev = renderChain;
      let resolveNext;
      renderChain = new Promise((r) => { resolveNext = r; });
      await prev;
      activeRenderId = id;
      try {
        return await task();
      } finally {
        activeRenderId = null;
        if (typeof resolveNext === 'function') resolveNext();
      }
    }
  
    function isErrorSvgMarkup(svgString) {
      if (!svgString) return false;
      return /aria-roledescription=["']error["']/i.test(svgString) || /\berror-text\b/i.test(svgString);
    }
  
    // Return a *useful* message from Mermaid's error SVG, if present; avoid returning the echoed source text.
    function extractMermaidErrorText(svgString) {
      if (!isErrorSvgMarkup(svgString)) return null;
      try {
        const div = document.createElement('div');
        div.innerHTML = svgString;
        const svg = div.querySelector('svg');
        if (!svg) return null;
        // Prefer nodes that look like error messages
        const errNodes = svg.querySelectorAll('text.error-text, .error-text, g.error');
        let msg = Array.from(errNodes).map(n => (n.textContent || '').trim()).filter(Boolean).join('\n').trim();
        if (msg && /(error|syntax|lexical|parse)/i.test(msg)) return msg;
        // Otherwise, avoid returning all text (which often includes the diagram source)
        return null;
      } catch { return null; }
    }
  
    function createMermaidError(message) {
      const e = new Error('Mermaid error: ' + message);
      e.name = 'MermaidRenderError';
      return e;
    }
  
    // Build a friendly error with best available line/column + excerpt from original source.
    function formatMermaidError(source, infos, svgMsg, thrownMsg, lineOffset) {
      const messages = [];
      if (Array.isArray(infos)) for (const i of infos) if (i?.message) messages.push(i.message);
      if (svgMsg) messages.push(svgMsg);
      if (thrownMsg) messages.push(thrownMsg);
  
      const brief = pickBestMessage(messages) || 'Mermaid reported an error.';
      let line = firstDefined(
        ...infos.map(i => i?.line),
        findNum(/line\s*[:\-]?\s*(\d+)/i, brief),
        findNum(/line\s*[:\-]?\s*(\d+)/i, thrownMsg),
        findNum(/line\s*[:\-]?\s*(\d+)/i, svgMsg)
      );
      let col = firstDefined(
        ...infos.map(i => i?.col),
        findNum(/col(?:umn)?\s*[:\-]?\s*(\d+)/i, brief),
        findNum(/col(?:umn)?\s*[:\-]?\s*(\d+)/i, thrownMsg),
        findNum(/col(?:umn)?\s*[:\-]?\s*(\d+)/i, svgMsg)
      );
  
      // Adjust for injected directive (if any)
      if (typeof line === 'number') line = Math.max(1, line - (lineOffset || 0));
  
      const excerpt = buildExcerpt(source, line, col);
      return [brief, excerpt].filter(Boolean).join('\n\n');
    }
  
    function pickBestMessage(arr) {
      if (!arr || !arr.length) return '';
      // Prefer messages mentioning syntax/parse with some length
      const ranked = [...arr].filter(Boolean).map(s => String(s).trim()).filter(Boolean)
        .sort((a, b) => scoreMsg(b) - scoreMsg(a));
      return ranked[0] || '';
    }
    function scoreMsg(s) {
      let score = s.length;
      if (/(syntax|parse|lexical)/i.test(s)) score += 200;
      if (/line\s*\d+/i.test(s)) score += 100;
      if (/expect/i.test(s)) score += 40;
      return score;
    }
    function firstDefined(...vals) {
      for (const v of vals) if (Number.isFinite(v)) return v;
      return undefined;
    }
    function findNum(re, str) {
      if (!str) return undefined;
      const m = re.exec(String(str));
      return m ? +m[1] : undefined;
    }
  
    function buildExcerpt(source, line, col) {
      if (!source || !Number.isFinite(line)) return '';
      const lines = String(source).replace(/\r\n/g, '\n').split('\n');
      const idx = Math.min(Math.max(0, line - 1), lines.length - 1);
      const start = Math.max(0, idx - 2);
      const end = Math.min(lines.length, idx + 3);
      const digits = String(end).length;
      let out = '';
      for (let i = start; i < end; i++) {
        const ln = String(i + 1).padStart(digits, ' ');
        out += `${ln} | ${lines[i]}\n`;
        if (i === idx && Number.isFinite(col) && col > 0) {
          const caretPad = ' '.repeat(digits + 3 + (col - 1));
          out += `${caretPad}^\n`;
        }
      }
      return out.trimEnd();
    }
  
    function removeErrorState(pane) {
      pane.classList.remove('usm-error');
      const box = paneErrorBox.get(pane);
      if (box && box.isConnected) box.remove();
      paneErrorBox.delete(pane);
      paneErrorText.delete(pane);
      const tb = pane.querySelector('.usm-toolbar');
      if (tb) syncToolbarState(pane, tb);
    }
  
    function onRenderError(pane, errorText) {
      const src = paneSourcePre.get(pane);
      if (src) hideSourcePre(src);
  
      let scroller = scrollerOf(pane);
      if (!scroller) {
        scroller = document.createElement('div');
        scroller.className = 'usm-scroll';
        pane.innerHTML = '';
        pane.appendChild(scroller);
      } else {
        scroller.innerHTML = '';
      }
  
      paneSvg.delete(pane);
      paneScale.set(pane, 1);
      paneBaseW.delete(pane);
      paneRendered.set(pane, false);
  
      const errorBox = document.createElement('div');
      errorBox.className = 'usm-error-box';
      errorBox.innerHTML = `<span class="usm-error-head">Mermaid error:</span><pre>${escapeHtml(errorText || '')}</pre>`;
      scroller.appendChild(errorBox);
      paneErrorBox.set(pane, errorBox);
      paneErrorText.set(pane, String(errorText || ''));
      pane.classList.add('usm-error');
      attachUiShell(pane);
      killGlobalErrorBanners();
    }
  
    function ensureDefaultsIfMissing(code, mode) {
      const hasThemeVars = /%%\s*\{\s*init\s*:\s*\{[\s\S]*?themeVariables\s*:/i.test(code);
      const vars = JSON.stringify(THEME_DEFAULTS[mode] || THEME_DEFAULTS.default).replace(/</g, '\\u003c');
      const directive = `%%{init: { theme: "${mode === 'dark' ? 'dark' : 'default'}", themeVariables: ${vars} }}%%\n`;
      return hasThemeVars ? code : directive + code;
    }
  
    // --------------------- Zoom (per diagram) --------------------
    const roSvg = new ResizeObserver((entries) => {
      for (const e of entries) {
        const svg = /** @type {Element} */ (e.target);
        const pane = svg.closest('.userscript-mermaid-pane');
        if (!pane) continue;
        const scale = paneScale.get(pane) ?? 1;
        if (scale !== 1) continue; // only rebase at 100%
        requestAnimationFrame(() => {
          const w = svg.getBoundingClientRect().width || (svg.viewBox?.baseVal?.width) || (svg.width?.baseVal?.value) || 0;
          if (w > 0) paneBaseW.set(pane, w);
          maybeUpdateBaseline(pane);
          updateFixedBoxSizing(pane);
        });
      }
    });
  
    function afterRenderSetup(pane) {
      // Ensure scroll wrapper exists and holds the SVG
      const svg = pane.querySelector(':scope > svg');
      let scroller = pane.querySelector(':scope > .usm-scroll');
      if (!scroller) {
        scroller = document.createElement('div');
        scroller.className = 'usm-scroll';
        while (pane.firstChild) scroller.appendChild(pane.firstChild);
        pane.appendChild(scroller);
      } else if (svg) {
        scroller.appendChild(svg);
      }
  
      if (scroller) {
        scroller.style.minHeight = CONFIG.minPaneHeightPx + 'px';
      }
      pane.style.minHeight = CONFIG.minPaneHeightPx + 'px';
  
      const svgEl = scroller.querySelector('svg');
      if (!svgEl) return;
  
      const prevSvg = paneSvg.get(pane);
      if (prevSvg && prevSvg !== svgEl) {
        try { roSvg.unobserve(prevSvg); } catch {}
      }
      paneSvg.set(pane, svgEl);
      if (paneScale.get(pane) == null) paneScale.set(pane, 1);
  
      attachUiShell(pane);
  
      requestAnimationFrame(() => {
        const scale = paneScale.get(pane) || 1;
        const currentW = svgEl.getBoundingClientRect().width || svgEl.viewBox?.baseVal?.width || svgEl.width?.baseVal?.value || 0;
        if (currentW > 0) paneBaseW.set(pane, currentW / scale);
        svgEl.style.transition = 'width 200ms ease, max-width 200ms ease';
        svgEl.style.transformOrigin = 'top left';
        roSvg.observe(svgEl);
        applyMaxHeight(pane);        // set maxHeight (elastic mode)
        maybeUpdateBaseline(pane);   // fitted floor
        snapshotInitialBaseline(pane);// original/pinned height
        updateFixedBoxSizing(pane);  // apply fixed/elastic rules
        updateZoomDisplay(pane);
      });
    }
  
    function attachUiShell(pane) {
      ensureToolbar(pane);
      ensureDpad(pane);
      const scroller = scrollerOf(pane);
      if (scroller) {
        scroller.style.scrollBehavior = 'smooth';
      }
      applyOverlayPadding(pane);
      updateZoomDisplay(pane);
    }
  
    function ensureToolbar(pane) {
      let toolbar = pane.querySelector('.usm-toolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'usm-toolbar';
  
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'usm-tool usm-expand';
        expand.setAttribute('aria-label', 'Expand diagram');
        expand.innerHTML = '<span class="usm-icon">⤢</span>';
        expand.addEventListener('click', () => openLightbox(pane));
  
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'usm-tool usm-copy';
        copy.setAttribute('aria-label', 'Copy Mermaid code');
        const copyIcon = document.createElement('span');
        copyIcon.className = 'usm-copy-icon';
        const sqA = document.createElement('span'); sqA.className = 'usm-copy-square primary';
        const sqB = document.createElement('span'); sqB.className = 'usm-copy-square secondary';
        const mark = document.createElement('span'); mark.className = 'usm-copy-mark';
        copyIcon.append(sqA, sqB, mark);
        copy.appendChild(copyIcon);
        copy.addEventListener('click', () => handleCopy(pane, copy));
  
        // Extra button: copy error text (only shown when pane has error)
        const copyErr = document.createElement('button');
        copyErr.type = 'button';
        copyErr.className = 'usm-tool usm-copy-error';
        copyErr.setAttribute('aria-label', 'Copy Mermaid error');
        copyErr.title = 'Copy error';
        copyErr.style.display = 'none';
        copyErr.innerHTML = '<span class="usm-icon">❗</span>';
        copyErr.addEventListener('click', () => handleCopyError(pane, copyErr));
  
        const settings = document.createElement('button');
        settings.type = 'button';
        settings.className = 'usm-tool usm-settings';
        settings.setAttribute('aria-label', 'Diagram settings');
        settings.innerHTML = '<span class="usm-icon">⚙</span>';
        settings.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          toggleSettingsPopover(pane, settings);
        });
  
        toolbar.append(expand, copy, copyErr, settings);
        pane.appendChild(toolbar);
      }
      syncToolbarState(pane, toolbar);
    }
  
    function syncToolbarState(pane, toolbar) {
      const svg = paneSvg.get(pane);
      const expand = toolbar.querySelector('.usm-expand');
      if (expand) expand.disabled = !svg;
  
      const copyErr = toolbar.querySelector('.usm-copy-error');
      if (copyErr) {
        const hasErr = pane.classList.contains('usm-error');
        copyErr.style.display = hasErr ? '' : 'none';
        copyErr.disabled = !hasErr || !paneErrorText.get(pane);
      }
    }
  
    function handleCopy(pane, btn) {
      const text = (() => {
        const pre = paneSourcePre.get(pane);
        if (pre) return readPreContent(pre).replace(/\r\n/g, '\n');
        const stored = paneCopyText.get(pane);
        if (typeof stored === 'string') return stored;
        const raw = paneRaw.get(pane);
        return typeof raw === 'string' ? raw : '';
      })();
      if (!text) return;
      const write = navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard API unavailable'));
      write.then(() => showCopyFeedback(pane, btn, true)).catch(() => showCopyFeedback(pane, btn, false));
    }
  
    function handleCopyError(pane, btn) {
      const text = paneErrorText.get(pane) || '';
      if (!text) { showCopyFeedback(pane, btn, false); return; }
      const write = navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard API unavailable'));
      write.then(() => showCopyFeedback(pane, btn, true)).catch(() => showCopyFeedback(pane, btn, false));
    }
  
    function showCopyFeedback(pane, btn, ok) {
      btn.classList.toggle('usm-copy-failed', !ok);
      btn.classList.add('usm-copy-active');
      btn.dataset.icon = ok ? 'success' : 'error';
  
      const toolbar = pane.querySelector('.usm-toolbar');
      if (toolbar) {
        let toast = toolbar.querySelector('.usm-copy-toast');
        if (!toast) {
          toast = document.createElement('div');
          toast.className = 'usm-copy-toast';
          toolbar.appendChild(toast);
        }
        toast.textContent = ok ? 'Copied!' : 'Copy failed';
        toast.classList.add('usm-toast-visible');
        if (copyToastTimers.has(pane)) clearTimeout(copyToastTimers.get(pane));
        copyToastTimers.set(pane, setTimeout(() => {
          toast?.classList.remove('usm-toast-visible');
        }, 1500));
      }
  
      if (copyResetTimers.has(pane)) clearTimeout(copyResetTimers.get(pane));
      copyResetTimers.set(pane, setTimeout(() => {
        btn.classList.remove('usm-copy-active', 'usm-copy-failed');
        delete btn.dataset.icon;
      }, 1400));
    }
  
    function toggleSettingsPopover(pane, trigger) {
      const existing = paneSettingsState.get(pane);
      if (existing?.popover?.isConnected) {
        closeSettingsPopover(pane);
      } else {
        openSettingsPopover(pane, trigger);
      }
    }
  
    function openSettingsPopover(pane, trigger) {
      closeSettingsPopover(pane, { silent: true });
      const model = parsePaneStyleModel(pane);
      const popover = document.createElement('div');
      popover.className = 'usm-settings-panel';
      popover.style.visibility = 'hidden';
      popover.addEventListener('mousedown', (e) => e.stopPropagation());
      popover.addEventListener('click', (e) => e.stopPropagation());
  
      const title = document.createElement('h3');
      title.textContent = 'Diagram styling';
      popover.appendChild(title);
  
      const themeLabel = document.createElement('label');
      themeLabel.textContent = 'Theme variables (JSON)';
      popover.appendChild(themeLabel);
  
      const themeArea = document.createElement('textarea');
      themeArea.className = 'usm-theme-input';
      themeArea.value = formatThemeVars(model.themeVars);
      themeArea.spellcheck = false;
      popover.appendChild(themeArea);
  
      const themeHint = document.createElement('div');
      themeHint.className = 'usm-settings-hint';
      themeHint.textContent = 'Include keys like background, textColor, lineColor, primaryColor, primaryTextColor.';
      popover.appendChild(themeHint);
  
      const classLabel = document.createElement('label');
      classLabel.textContent = 'Class definitions (one per line)';
      popover.appendChild(classLabel);
  
      const classArea = document.createElement('textarea');
      classArea.className = 'usm-class-input';
      classArea.value = model.classLines.join('\n');
      classArea.placeholder = 'classDef node fill:#1f2937,stroke:#38bdf8,color:#f8fafc';
      classArea.spellcheck = false;
      popover.appendChild(classArea);
  
      const classHint = document.createElement('div');
      classHint.className = 'usm-settings-hint';
      classHint.textContent = 'Example: classDef task fill:#eef2ff,stroke:#475569,stroke-width:2px';
      popover.appendChild(classHint);
  
      const actions = document.createElement('div');
      actions.className = 'usm-settings-actions';
  
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.textContent = 'Apply';
      actions.appendChild(applyBtn);
  
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.textContent = 'Reset';
      actions.appendChild(resetBtn);
  
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = 'Close';
      actions.appendChild(closeBtn);
  
      popover.appendChild(actions);
  
      const status = document.createElement('div');
      status.className = 'usm-settings-status';
      status.hidden = true;
      popover.appendChild(status);
  
      const state = {
        pane,
        trigger,
        popover,
        themeArea,
        classArea,
        status,
        themeName: model.themeName,
        outsideHandler: null,
        escHandler: null,
        repositionHandler: null
      };
  
      paneSettingsState.set(pane, state);
      document.body.appendChild(popover);
  
      const outsideHandler = (event) => {
        if (!state.popover?.contains(event.target) && event.target !== state.trigger) {
          closeSettingsPopover(pane);
        }
      };
      const escHandler = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeSettingsPopover(pane);
        }
      };
      const repositionHandler = () => positionSettingsPopover(state);
  
      state.outsideHandler = outsideHandler;
      state.escHandler = escHandler;
      state.repositionHandler = repositionHandler;
  
      document.addEventListener('mousedown', outsideHandler, true);
      document.addEventListener('touchstart', outsideHandler, true);
      document.addEventListener('keydown', escHandler, true);
      window.addEventListener('resize', repositionHandler, true);
      window.addEventListener('scroll', repositionHandler, true);
  
      applyBtn.addEventListener('click', () => applySettingsChanges(pane));
      resetBtn.addEventListener('click', () => resetSettingsToBaseline(pane));
      closeBtn.addEventListener('click', () => closeSettingsPopover(pane));
  
      refreshSettingsValues(pane);
      requestAnimationFrame(() => {
        positionSettingsPopover(state);
        if (state.popover) state.popover.style.visibility = 'visible';
      });
    }
  
    function refreshSettingsValues(pane, opts = {}) {
      const state = paneSettingsState.get(pane);
      if (!state) return;
      const model = parsePaneStyleModel(pane);
      state.themeArea.value = formatThemeVars(model.themeVars);
      state.classArea.value = model.classLines.join('\n');
      state.themeName = model.themeName;
      if (!opts?.preserveStatus) clearSettingsStatus(state);
    }
  
    function applySettingsChanges(pane) {
      const state = paneSettingsState.get(pane);
      if (!state) return;
      clearSettingsStatus(state);
      let themeObj;
      try {
        const raw = state.themeArea.value.trim();
        themeObj = raw ? JSON.parse(raw) : {};
      } catch (err) {
        showSettingsStatus(state, 'Theme variables must be valid JSON.', 'error');
        return;
      }
      if (!themeObj || typeof themeObj !== 'object' || Array.isArray(themeObj)) {
        showSettingsStatus(state, 'Theme variables must be an object.', 'error');
        return;
      }
  
      const classLinesRaw = state.classArea.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const normalizedClasses = [];
      for (const line of classLinesRaw) {
        const trimmed = line.replace(/;\s*$/, '');
        const finalLine = /^classDef\s+/i.test(trimmed) ? trimmed : `classDef ${trimmed}`;
        const body = finalLine.slice('classDef'.length).trim();
        if (!body) {
          showSettingsStatus(state, 'Each class definition needs a name and properties.', 'error');
          return;
        }
        normalizedClasses.push('classDef ' + body);
      }
  
      try {
        const changed = writePaneStyles(pane, themeObj, normalizedClasses, state.themeName);
        if (changed) {
          refreshSettingsValues(pane, { preserveStatus: true });
          showSettingsStatus(state, 'Updated diagram styles.', 'success');
        } else {
          showSettingsStatus(state, 'No changes to apply.', 'success');
        }
      } catch (err) {
        console.error('[Mermaid userscript] failed to apply styles', err);
        showSettingsStatus(state, err?.message || 'Failed to update diagram.', 'error');
      }
    }
  
    function resetSettingsToBaseline(pane) {
      const state = paneSettingsState.get(pane);
      if (!state) return;
      clearSettingsStatus(state);
      const pre = paneSourcePre.get(pane);
      const baseline = paneBaselineSource.get(pane);
      if (!pre || baseline == null) {
        refreshSettingsValues(pane, { preserveStatus: true });
        showSettingsStatus(state, 'Nothing to reset.', 'success');
        return;
      }
      const normalized = baseline.replace(/\r\n/g, '\n');
      writePreContent(pre, normalized);
      const trimmed = normalized.trim();
      const peers = panesBySource.get(pre);
      if (peers) {
        for (const p of peers) {
          paneCopyText.set(p, normalized);
          paneRaw.set(p, trimmed);
          paneRendered.set(p, false);
        }
      } else {
        paneCopyText.set(pane, normalized);
        paneRaw.set(pane, trimmed);
        paneRendered.set(pane, false);
      }
      scheduleSourceRefresh(pre);
      refreshSettingsValues(pane, { preserveStatus: true });
      showSettingsStatus(state, 'Restored original diagram styles.', 'success');
    }
  
    function positionSettingsPopover(state) {
      const trigger = state?.trigger;
      const popover = state?.popover;
      if (!trigger || !trigger.isConnected) {
        if (state?.pane) closeSettingsPopover(state.pane, { silent: true });
        return;
      }
      if (!popover || !popover.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      const popRect = popover.getBoundingClientRect();
      let left = rect.right - popRect.width;
      let top = rect.bottom + 8;
      if (Number.isNaN(left)) left = rect.left;
      if (Number.isNaN(top)) top = rect.bottom + 8;
      left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
      const maxTop = window.innerHeight - popRect.height - 8;
      if (top > maxTop) {
        top = Math.max(8, rect.top - popRect.height - 8);
      }
      top = Math.max(8, Math.min(top, maxTop));
      popover.style.left = Math.round(left) + 'px';
      popover.style.top = Math.round(top) + 'px';
    }
  
    function closeSettingsPopover(pane, opts = {}) {
      const state = pane ? paneSettingsState.get(pane) : null;
      if (!state) return;
      if (state.outsideHandler) {
        document.removeEventListener('mousedown', state.outsideHandler, true);
        document.removeEventListener('touchstart', state.outsideHandler, true);
      }
      if (state.escHandler) document.removeEventListener('keydown', state.escHandler, true);
      if (state.repositionHandler) {
        window.removeEventListener('resize', state.repositionHandler, true);
        window.removeEventListener('scroll', state.repositionHandler, true);
      }
      if (state.popover?.isConnected) state.popover.remove();
      paneSettingsState.delete(pane);
      if (!opts?.silent) state.trigger?.focus?.();
    }
  
    function showSettingsStatus(state, message, kind) {
      if (!state?.status) return;
      state.status.textContent = message;
      state.status.hidden = false;
      state.status.classList.remove('usm-error', 'usm-success');
      if (kind === 'error') state.status.classList.add('usm-error');
      else if (kind === 'success') state.status.classList.add('usm-success');
    }
  
    function clearSettingsStatus(state) {
      if (!state?.status) return;
      state.status.hidden = true;
      state.status.textContent = '';
      state.status.classList.remove('usm-error', 'usm-success');
    }
  
    function formatThemeVars(vars) {
      try { return JSON.stringify(vars ?? {}, null, 2); } catch { return '{}'; }
    }
  
    function parsePaneStyleModel(pane) {
      const source = getPaneSourceText(pane);
      if (!paneBaselineSource.has(pane)) paneBaselineSource.set(pane, source);
      const info = findInitDirective(source);
      const inferredTheme = info?.themeName && THEME_DEFAULTS[info.themeName] ? info.themeName : theme;
      const baseThemeVars = { ...(THEME_DEFAULTS[inferredTheme] || THEME_DEFAULTS.default) };
      if (info?.themeVars && typeof info.themeVars === 'object' && !Array.isArray(info.themeVars)) {
        Object.assign(baseThemeVars, info.themeVars);
      }
      const classLines = extractClassDefLines(source);
      return {
        source,
        themeVars: baseThemeVars,
        classLines,
        themeName: info?.themeName || inferredTheme
      };
    }
  
    function getPaneSourceText(pane) {
      const pre = paneSourcePre.get(pane);
      if (pre) return readPreContent(pre).replace(/\r\n/g, '\n');
      const stored = paneCopyText.get(pane);
      if (typeof stored === 'string') return stored;
      const raw = paneRaw.get(pane);
      return typeof raw === 'string' ? raw : '';
    }
  
    function findInitDirective(source) {
      if (!source) return null;
      let start = source.indexOf('%%{');
      while (start !== -1) {
        const close = source.indexOf('}%%', start + 3);
        if (close === -1) break;
        const body = source.slice(start + 3, close);
        if (!/init\s*:/i.test(body)) {
          start = source.indexOf('%%{', close + 3);
          continue;
        }
        const themeMatch = body.match(/theme\s*:\s*(['"])(.*?)\1/i);
        const themeName = themeMatch?.[2]?.trim();
        const tvInfo = extractThemeVariables(body);
        return {
          start,
          end: close + 3,
          body,
          themeName,
          themeVars: tvInfo.themeVars,
          tvObjectStart: tvInfo.tvObjectStart,
          tvObjectEnd: tvInfo.tvObjectEnd
        };
      }
      return null;
    }
  
    function extractThemeVariables(body) {
      const idx = body.indexOf('themeVariables');
      if (idx === -1) return { themeVars: null, tvObjectStart: null, tvObjectEnd: null };
      const braceStart = body.indexOf('{', idx);
      if (braceStart === -1) return { themeVars: null, tvObjectStart: null, tvObjectEnd: null };
      const braceEnd = findMatchingBrace(body, braceStart);
      if (braceEnd === -1) return { themeVars: null, tvObjectStart: braceStart, tvObjectEnd: null };
      const objText = body.slice(braceStart, braceEnd + 1);
      return {
        themeVars: parseJsonLike(objText),
        tvObjectStart: braceStart,
        tvObjectEnd: braceEnd
      };
    }
  
    function findMatchingBrace(str, start) {
      let depth = 0;
      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (ch === '"' || ch === '\'') { i = skipString(str, i); continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }
  
    function skipString(str, start) {
      const quote = str[start];
      let i = start + 1;
      while (i < str.length) {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === quote) return i;
        i++;
      }
      return str.length - 1;
    }
  
    function parseJsonLike(text) {
      try { return JSON.parse(text); } catch {}
      let normalized = text;
      try {
        normalized = normalized.replace(/([,{\s])([A-Za-z0-9_-]+)\s*:/g, (match, p1, p2) => `${p1}"${p2}":`);
        normalized = normalized.replace(/'/g, '"');
        return JSON.parse(normalized);
      } catch { return null; }
    }
  
    function extractClassDefLines(source) {
      const lines = [];
      const re = /^[ \t]*classDef[^\n]*$/gm;
      let match;
      while ((match = re.exec(source)) != null) {
        const line = match[0].trim();
        if (line) lines.push(line);
      }
      return lines;
    }
  
    function writePaneStyles(pane, themeVars, classLines, hintTheme) {
      const pre = paneSourcePre.get(pane);
      if (!pre) throw new Error('Unable to locate original Mermaid source.');
      const current = readPreContent(pre).replace(/\r\n/g, '\n');
      const info = findInitDirective(current);
      const themeName = info?.themeName || hintTheme || theme;
      const themeJson = JSON.stringify(themeVars ?? {}, null, 2).replace(/\n/g, '\n    ');
      let next;
      if (info) {
        const before = current.slice(0, info.start);
        const after = current.slice(info.end);
        let body = info.body;
        if (typeof info.tvObjectStart === 'number' && typeof info.tvObjectEnd === 'number' && info.tvObjectEnd >= info.tvObjectStart) {
          body = body.slice(0, info.tvObjectStart) + themeJson + body.slice(info.tvObjectEnd + 1);
        } else {
          body = `init: { theme: "${themeName}", themeVariables: ${themeJson} }`;
        }
        next = before + '%%{' + body + '}%%' + after;
      } else {
        const directive = `%%{init: { theme: "${themeName}", themeVariables: ${themeJson} }}%%\n`;
        next = directive + current;
      }
  
      next = next.replace(/^[ \t]*classDef[^\n]*\n?/gm, '');
      let rebuilt = next.replace(/\s+$/, '');
      const block = classLines.length ? classLines.map((line) => line.endsWith(';') ? line : line + ';').join('\n') : '';
      if (block) {
        rebuilt += (rebuilt.endsWith('\n') ? '' : '\n') + block + '\n';
      } else {
        rebuilt += rebuilt.endsWith('\n') ? '' : '\n';
      }
      const normalized = rebuilt.replace(/\r\n/g, '\n');
      if (normalized === current) return false;
  
      writePreContent(pre, normalized);
      const peers = panesBySource.get(pre);
      if (peers) {
        for (const p of peers) {
          paneCopyText.set(p, normalized);
          paneRaw.set(p, normalized.trim());
          paneRendered.set(p, false);
        }
      } else {
        paneCopyText.set(pane, normalized);
        paneRaw.set(pane, normalized.trim());
        paneRendered.set(pane, false);
      }
      scheduleSourceRefresh(pre);
      return true;
    }
  
    function ensureDpad(pane) {
      let dpad = pane.querySelector('.usm-dpad');
      if (!dpad) {
        dpad = document.createElement('div');
        dpad.className = 'usm-dpad';
        dpad.innerHTML = `
          <div class="usm-dpad-grid">
            <span class="usm-gap"></span>
            <button type="button" class="usm-btn usm-up" aria-label="Pan up">▲</button>
            <button type="button" class="usm-btn usm-zoom-in" aria-label="Zoom in">＋</button>
  
            <button type="button" class="usm-btn usm-left" aria-label="Pan left">◀</button>
            <button type="button" class="usm-btn usm-reset" aria-label="Reset view">⟳</button>
            <button type="button" class="usm-btn usm-right" aria-label="Pan right">▶</button>
  
            <span class="usm-gap"></span>
            <button type="button" class="usm-btn usm-down" aria-label="Pan down">▼</button>
            <button type="button" class="usm-btn usm-zoom-out" aria-label="Zoom out">－</button>
          </div>
          <div class="usm-dpad-footer">
            <button type="button" class="usm-btn usm-toggle" aria-label="Toggle fixed box"></button>
            <button type="button" class="usm-zoom-box" aria-label="Set zoom percent"><span class="usm-zoom-val"></span></button>
          </div>
        `;
        pane.appendChild(dpad);
  
        const up = dpad.querySelector('.usm-up');
        const down = dpad.querySelector('.usm-down');
        const left = dpad.querySelector('.usm-left');
        const right = dpad.querySelector('.usm-right');
        const zoomIn = dpad.querySelector('.usm-zoom-in');
        const zoomOut = dpad.querySelector('.usm-zoom-out');
        const reset = dpad.querySelector('.usm-reset');
        const zoomBox = dpad.querySelector('.usm-zoom-box');
  
        up?.addEventListener('click', () => panScroller(pane, 0, -1));
        down?.addEventListener('click', () => panScroller(pane, 0, 1));
        left?.addEventListener('click', () => panScroller(pane, -1, 0));
        right?.addEventListener('click', () => panScroller(pane, 1, 0));
        zoomIn?.addEventListener('click', (e) => nudgeZoom(pane, +(e.shiftKey ? CONFIG.zoom.bigStep : CONFIG.zoom.step)));
        zoomOut?.addEventListener('click', (e) => nudgeZoom(pane, -(e.shiftKey ? CONFIG.zoom.bigStep : CONFIG.zoom.step)));
        reset?.addEventListener('click', () => {
          setZoom(pane, 1);
          const scroller = scrollerOf(pane);
          scroller?.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
        });
        zoomBox?.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); enterZoomEdit(pane); });
  
        const toggle = dpad.querySelector('.usm-toggle');
        toggle?.addEventListener('click', () => {
          paneFixedBox.set(pane, !paneFixedBox.get(pane));
          snapshotInitialBaseline(pane);
          syncFixedToggle(pane, dpad);
          updateFixedBoxSizing(pane);
        });
      }
      syncFixedToggle(pane, dpad);
    }
  
    function syncFixedToggle(pane, dpad) {
      const toggle = dpad?.querySelector('.usm-toggle');
      if (!toggle) return;
      const on = !!paneFixedBox.get(pane);
      toggle.textContent = on ? '▣' : '□';
      toggle.setAttribute('aria-pressed', String(on));
      toggle.title = on
        ? 'Fixed box: keep original height (scroll inside)'
        : 'Elastic box: container grows with content';
    }
  
    function panScroller(pane, dx, dy) {
      const scroller = scrollerOf(pane);
      if (!scroller) return;
      const stepX = Math.max(80, Math.round(scroller.clientWidth * 0.25));
      const stepY = Math.max(60, Math.round(scroller.clientHeight * 0.25));
      scroller.scrollTo({
        left: scroller.scrollLeft + dx * stepX,
        top: scroller.scrollTop + dy * stepY,
        behavior: 'smooth'
      });
    }
  
    function openLightbox(pane) {
      const svg = paneSvg.get(pane);
      if (!svg) return;
  
      closeLightbox();
  
      const clone = svg.cloneNode(true);
      clone.removeAttribute('style');
      const scale = paneScale.get(pane) || 1;
      const base = paneBaseW.get(pane) || svg.getBoundingClientRect().width || svg.viewBox?.baseVal?.width || svg.width?.baseVal?.value || 0;
      const viewportW = Math.max(480, Math.min(window.innerWidth || 0, document.documentElement?.clientWidth || window.innerWidth || 0));
      const viewportH = Math.max(360, Math.min(window.innerHeight || 0, document.documentElement?.clientHeight || window.innerHeight || 0));
      const maxWidth = Math.floor(viewportW * 0.9);
      const minWidth = Math.floor(viewportW * 0.6);
      let desired = base > 0 ? base * scale : svg.getBoundingClientRect().width || minWidth;
      if (!Number.isFinite(desired) || desired <= 0) desired = minWidth;
      const clamped = Math.max(Math.min(desired, maxWidth), Math.min(minWidth, maxWidth));
      const maxHeight = Math.floor(viewportH * 0.85);
  
      clone.style.height = 'auto';
      clone.style.minWidth = Math.min(minWidth, maxWidth) + 'px';
      clone.style.width = clamped + 'px';
      clone.style.maxWidth = maxWidth + 'px';
      clone.style.maxHeight = maxHeight + 'px';
  
      const overlay = document.createElement('div');
      overlay.className = 'usm-lightbox';
  
      const inner = document.createElement('div');
      inner.className = 'usm-lightbox-content';
      inner.style.maxWidth = Math.min(Math.floor(viewportW * 0.96), Math.max(clamped + 80, 640)) + 'px';
      inner.style.maxHeight = Math.floor(viewportH * 0.9) + 'px';
  
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'usm-lightbox-close';
      closeBtn.setAttribute('aria-label', 'Close diagram');
      closeBtn.innerHTML = '✕';
      closeBtn.addEventListener('click', closeLightbox);
  
      const body = document.createElement('div');
      body.className = 'usm-lightbox-body';
      body.appendChild(clone);
  
      inner.append(closeBtn, body);
      overlay.appendChild(inner);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLightbox(); });
  
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('usm-open'));
  
      lightboxOverlay = overlay;
      lightboxSourcePane = pane;
      lightboxKeyHandler = (ev) => { if (ev.key === 'Escape') closeLightbox(); };
      document.addEventListener('keydown', lightboxKeyHandler);
    }
  
    function closeLightbox() {
      if (!lightboxOverlay) return;
      lightboxOverlay.classList.remove('usm-open');
      const overlay = lightboxOverlay;
      lightboxOverlay = null;
      lightboxSourcePane = null;
      setTimeout(() => overlay.remove(), 160);
      if (lightboxKeyHandler) {
        document.removeEventListener('keydown', lightboxKeyHandler);
        lightboxKeyHandler = null;
      }
    }
  
    function nudgeZoom(pane, delta) {
      setZoom(pane, (paneScale.get(pane) || 1) + delta);
    }
  
    function setZoom(pane, next) {
      const svg = paneSvg.get(pane);
      const baseW = paneBaseW.get(pane) || svg?.getBoundingClientRect().width || 0;
      if (!svg || baseW <= 0) return;
  
      const clamped = Math.max(CONFIG.zoom.min, Math.min(CONFIG.zoom.max, Number(next) || 1));
      paneScale.set(pane, clamped);
  
      svg.style.transition = 'width 200ms ease, max-width 200ms ease';
      svg.classList.add('usm-zooming');
      setTimeout(() => svg.classList.remove('usm-zooming'), 220);
  
      if (clamped === 1) {
        svg.style.maxWidth = '100%';
        svg.style.width = '';
        svg.style.height = 'auto';
      } else {
        const px = Math.round(baseW * clamped);
        svg.style.maxWidth = 'none';
        svg.style.width = px + 'px';
        svg.style.height = 'auto';
      }
  
      applyMaxHeight(pane);
      maybeUpdateBaseline(pane);
      updateFixedBoxSizing(pane);
      updateZoomDisplay(pane);
    }
  
    function updateZoomDisplay(pane) {
      const val = pane.querySelector('.usm-zoom-val');
      if (val && val.tagName !== 'INPUT') {
        val.textContent = Math.round((paneScale.get(pane) || 1) * 100) + '%';
      }
    }
  
    function enterZoomEdit(pane) {
      const val = pane.querySelector('.usm-zoom-val');
      if (!val || val.tagName === 'INPUT') return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'usm-zoom-input';
      input.value = String(Math.round((paneScale.get(pane) || 1) * 100));
      let committed = false;
  
      const exit = () => {
        input.replaceWith(val);
        updateZoomDisplay(pane);
      };
      const commit = () => {
        committed = true;
        const percent = parsePercent(input.value);
        if (percent != null) {
          const minP = CONFIG.zoom.min * 100;
          const maxP = CONFIG.zoom.max * 100;
          const clampedP = Math.max(minP, Math.min(maxP, percent));
          setZoom(pane, clampedP / 100);
        }
        exit();
      };
  
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); exit(); }
      });
      input.addEventListener('blur', () => { if (!committed) exit(); });
  
      val.replaceWith(input);
      input.focus();
      input.select();
    }
  
    function parsePercent(v) {
      if (v == null) return null;
      const s = String(v).trim(); let n;
      if (/x$/i.test(s))       n = parseFloat(s.replace(/x$/i, '').replace(',', '.')) * 100;
      else if (/%$/.test(s))   n = parseFloat(s.replace('%', '').replace(',', '.'));
      else { n = parseFloat(s.replace(',', '.')); if (n > 0 && n <= 5) n = n * 100; }
      return Number.isFinite(n) ? n : null;
    }
  
    // ---------------- Baseline / Fixed-box sizing ----------------
    function scrollerOf(pane) { return pane.querySelector(':scope > .usm-scroll'); }
    function hasScrollbars(scroller) {
      if (!scroller) return false;
      const v = scroller.scrollHeight > scroller.clientHeight + 1;
      const h = scroller.scrollWidth > scroller.clientWidth + 1;
      return v || h;
    }
  
    // Save fitted floor when scale==1 and no scrollbars (informational)
    function maybeUpdateBaseline(pane) {
      if (pane.classList.contains('userscript-mermaid-hidden')) return;
      const scroller = scrollerOf(pane); if (!scroller) return;
      const s = paneScale.get(pane) || 1;
      if (Math.abs(s - 1) > 1e-3) return;     // only at 100%
      if (hasScrollbars(scroller)) return;    // only when fully fitted
      const h = Math.ceil(scroller.getBoundingClientRect().height);
      if (h > 0) paneFloorH.set(pane, h);
    }
  
    // Snapshot original container height (pinned height) once after first render
    function snapshotInitialBaseline(pane) {
      if (paneInitFloorH.get(pane)) return;
      const scroller = scrollerOf(pane); if (!scroller) return;
      const h = Math.ceil(scroller.getBoundingClientRect().height);
      if (h > 0) paneInitFloorH.set(pane, h);
    }
  
    // Compute the viewport cap used for elastic mode (and for clamping the pinned height on small screens)
    function computeVhCap() {
      const viewportCap = Math.floor(window.innerHeight * CONFIG.maxViewportHeightRatio) - CONFIG.verticalSafetyPx;
      return Math.max(
        CONFIG.minPaneHeightPx,
        CONFIG.minMaxHeightPx,
        viewportCap
      );
    }
  
    // Apply sizing rules depending on mode
    function updateFixedBoxSizing(pane) {
      const scroller = scrollerOf(pane); if (!scroller) return;
      const fixedOn = !!paneFixedBox.get(pane);
      const minH = CONFIG.minPaneHeightPx;
  
      if (fixedOn) {
        // Pin to original height (clamped to current viewport cap)
        snapshotInitialBaseline(pane);
        const initH = paneInitFloorH.get(pane) || Math.ceil(scroller.getBoundingClientRect().height) || 0;
        const target = Math.max(minH, Math.max(0, Math.min(initH, computeVhCap())));
        pane.style.minHeight = target + 'px';
        scroller.style.minHeight = target + 'px';
        scroller.style.height = target + 'px';
        scroller.style.maxHeight = ''; // height takes precedence
      } else {
        // Elastic: container grows/shrinks with content, bounded by viewport cap
        const cap = Math.max(computeVhCap(), minH);
        pane.style.minHeight = minH + 'px';
        scroller.style.minHeight = minH + 'px';
        scroller.style.height = '';
        scroller.style.maxHeight = cap + 'px';
      }
    }
  
    // ---------------- Vertical clamp (elastic mode helper) -------
    function applyMaxHeight(pane) {
      if (!!paneFixedBox.get(pane)) return; // fixed mode ignores max-height
      const scroller = scrollerOf(pane);
      if (scroller) {
        scroller.style.maxHeight = Math.max(computeVhCap(), CONFIG.minPaneHeightPx) + 'px';
        scroller.style.minHeight = CONFIG.minPaneHeightPx + 'px';
      }
    }
  
    function applyOverlayPadding(pane) {
      const scroller = scrollerOf(pane);
      if (!scroller) return;
      const dpad = pane.querySelector('.usm-dpad');
      let padBottom = CONFIG.zoomPadPx;
      let padRight = 0;
      if (dpad && dpad.isConnected) {
        const rect = dpad.getBoundingClientRect();
        if (rect.height) padBottom = Math.max(padBottom, Math.ceil(rect.height + 16));
        if (rect.width) padRight = Math.max(padRight, Math.ceil(rect.width + 16));
      }
      scroller.style.paddingBottom = padBottom + 'px';
      scroller.style.paddingRight = padRight ? padRight + 'px' : '';
    }
  
    // ------------------------- Observers -------------------------
    function observeDom() {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = n;
          if (el.matches?.('pre, code, article, [data-message-id], .markdown, [data-testid="conversation-turn"]') ||
              el.querySelector?.('pre, code, article, .markdown, [data-testid="conversation-turn"]')) {
            schedule(); return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  
    function observeTheme() {
      const rerun = debounce(() => {
        const next = detectTheme();
        if (next === theme) return;
        theme = next;
        injectStyle(theme);
        if (CONFIG.rerenderOnThemeChange) {
          initMermaid(theme);
          const visible = Array.from(document.querySelectorAll('.userscript-mermaid-pane:not(.userscript-mermaid-hidden)'));
          for (const p of visible) { paneRendered.set(p, false); renderPane(p); }
        }
      }, 50);
  
      const opts = { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] };
      new MutationObserver(rerun).observe(document.documentElement, opts);
      if (document.body) new MutationObserver(rerun).observe(document.body, opts);
    }
  
    function observeColorScheme() {
      if (!window.matchMedia) return;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener?.('change', () => {
        const cls = document.documentElement.classList;
        const explicit = cls.contains('dark') || cls.contains('light') || document.documentElement.hasAttribute('data-theme');
        if (!explicit) { theme = detectTheme(); injectStyle(theme); if (CONFIG.rerenderOnThemeChange) { initMermaid(theme); schedule(); } }
      });
    }
  
    const lazyObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const pane = e.target;
          if (!paneRendered.get(pane)) renderPane(pane);
          lazyObserver.unobserve(pane);
        }
      }
    }, { root: null, rootMargin: CONFIG.rootMargin, threshold: 0 });
  
    // --------------------------- Utils ---------------------------
    function debounce(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
    function hash32(str) { let h=5381,i=str.length; while(i){ h=((h<<5)+h) ^ str.charCodeAt(--i); } return (h>>>0).toString(36); }
  })();
  