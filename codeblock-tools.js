// ==UserScript==
// @name         ChatGPT Codeblock Tools
// @namespace    https://tampermonkey.net/
// @version      1.14.0
// @description  Fast, modern controls for ChatGPT code blocks: glass top bar (language + icons), precise collapse, wrap, find, exact copy, line numbers with wrap-continuation, and diff/patch tools. Slide-out +/- tray (no pre-reserved space). Streaming-safe finalize. User-configurable exclude list (default: mermaid).
// @author       You
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jsdiff/8.0.2/diff.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js
// ==/UserScript==

(function () {
    'use strict';
  
    // --------------------------- Settings / Schema ----------------------------
    const SETTINGS_KEY = 'vm_codeblock_tools_v1';
    const SETTINGS_SCHEMA = 8;
  
    const DEFAULTS = Object.freeze({
      schema: SETTINGS_SCHEMA,
      collapseMode: 'none',        // 'none' | 'lines' | 'pill'
      collapseLines: 12,           // N numbered lines for "lines" mode
      defaultHeightPx: 360,        // max height (auto-shrink below this)
      minHeightPx: 120,            // minimum height for tiny snippets
      wrap: false,                 // soft wrap default
      searchCaseSensitive: false,
      searchContextPx: 60,
      diffContext: 3,
      pillPreviewChars: 64,
      showLanguage: true,
      searchHighlightColorLight: '#fff275',
      searchHighlightColorDark:  '#facc15',
      // Performance guards
      lazyRootMargin: '800px 0px',
      measureWrapMaxLines: 1500,
      searchMaxMarks: 5000,
      // Streaming stabilization
      streamStabilizeMs: 700,
      // NEW: Exclude languages (comma-separated, case-insensitive)
      excludedLangs: 'mermaid'
    });
  
    let SETTINGS = loadSettings();
    function loadSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULTS, ...(parsed || {}) };
        merged.schema = SETTINGS_SCHEMA;
        saveSettings(merged);
        return merged;
      } catch { return { ...DEFAULTS }; }
    }
    function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }
  
    // --------------------------- State / helpers ------------------------------
    const processed = new WeakSet();
    const byContainer = new WeakMap();
    const byScroller  = new WeakMap();
    const bySearchInput = new WeakMap();
  
    /** @typedef {{
     *  container: HTMLElement, topbar: HTMLElement, toolbar: HTMLElement, langBadge: HTMLElement,
     *  scroller: HTMLElement, pair: HTMLElement, gutter: HTMLElement, gutterList: HTMLOListElement, codeWrap: HTMLElement,
     *  pre: HTMLPreElement, code: HTMLElement, language: string,
     *  inDiff: boolean, diffBackup: string|null,
     *  pill: HTMLElement, search: { needle: string, ranges: Array<{start:number,end:number}>, index: number, groups: HTMLElement[][] },
     *  wrapOn: boolean, collapseMode: 'none'|'lines'|'pill', heightPx: number, userResized: boolean, lh: number,
     *  hideAdd: boolean, hideDel: boolean,
     *  streamObs?: MutationObserver|null, streamTimer?: number|null, streaming?: boolean, squelchUntil?: number,
     *  isFinalizing?: boolean
     * }} BlockState
     */
  
    let IO = null, RO = null, delegated = false;
  
    const qs  = (sel, root = document) => root.querySelector(sel);
    const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  
    function getExcludedSet() {
      const raw = (SETTINGS.excludedLangs || '').toLowerCase();
      return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
    }
    function isExcludedLanguage(lang) {
      if (!lang) return false;
      return getExcludedSet().has(String(lang).toLowerCase());
    }
    function shouldSkipCodeEl(codeEl) {
      const lang = extractLanguage(codeEl);
      if (isExcludedLanguage(lang)) return true;
      // Fallback: if first non-empty word is excluded (covers ```<lang> text blocks without class)
      const firstWord = (codeEl.textContent || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
      return isExcludedLanguage(firstWord);
    }
  
    // --------------------------- Theme / CSS ----------------------------------
    function detectDark() {
      const root = document.documentElement;
      if (root.classList.contains('dark')) return true;
      const scheme = (root.getAttribute('style') || '').match(/color-scheme:\s*(dark|light)/i)?.[1];
      if (scheme === 'dark') return true;
      if (scheme === 'light') return false;
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    }
  
    function injectStyle() {
      const dark = detectDark();
      const glass = dark ? 'rgba(15,23,42,0.55)' : 'rgba(255,255,255,0.65)';
      const glassBorder = dark ? 'rgba(148,163,184,0.25)' : 'rgba(15,23,42,0.10)';
      const text = dark ? '#E5E7EB' : '#0F172A';
      const muted = dark ? '#9aa7b8' : '#64748b';
      const trayBg = dark ? 'rgba(148,163,184,0.10)' : 'rgba(15,23,42,0.05)';
      const trayBorder = dark ? 'rgba(148,163,184,0.20)' : 'rgba(15,23,42,0.08)';
      const trayShadow = dark ? '0 1px 4px rgba(0,0,0,0.35)' : '0 1px 4px rgba(0,0,0,0.15)';
      const accent = dark ? '#38bdf8' : '#0ea5e9';
      const hl = dark ? SETTINGS.searchHighlightColorDark : SETTINGS.searchHighlightColorLight;
  
      const css = `
  .vmcb-wrap { position: relative; margin: 0.85rem 0; border-radius: 14px; }
  
  .vmcb-topbar {
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
    padding: 8px 10px; color: ${text};
    background: ${glass}; backdrop-filter: blur(10px) saturate(140%);
    border: 1px solid ${glassBorder}; border-bottom: 0; border-radius: 14px 14px 0 0;
    box-shadow: inset 0 -1px 0 ${glassBorder};
  }
  .vmcb-lang {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; background: linear-gradient(180deg, rgba(56,189,248,0.20), rgba(56,189,248,0.10));
    border: 1px solid ${glassBorder}; border-radius: 999px;
    font: 700 12px system-ui,-apple-system,Segoe UI,Roboto; color: ${text};
    text-transform: lowercase; letter-spacing: .3px; box-shadow: ${trayShadow};
  }
  
  .vmcb-toolbar {
    display: inline-flex; gap: 6px; align-items: center;
    background: ${trayBg}; border: 1px solid ${trayBorder};
    border-radius: 10px; padding: 4px; box-shadow: ${trayShadow}; position: relative;
  }
  .vmcb-btn {
    appearance: none; border: none; background: transparent; color: inherit;
    width: 30px; height: 30px; border-radius: 8px; display: inline-flex;
    align-items: center; justify-content: center; cursor: pointer;
    transition: transform 80ms ease, box-shadow 140ms ease, background 140ms ease, color 140ms ease, filter 120ms ease;
  }
  .vmcb-btn svg{
    width:18px; height:18px; display:block;
    stroke: currentColor; fill: none;
    vector-effect: non-scaling-stroke;
    shape-rendering: geometricPrecision;
  }
  .vmcb-btn:hover { background: rgba(0,0,0,0.06); filter: brightness(1.06); }
  .vmcb-btn:active { transform: translateY(0.5px); }
  .vmcb-btn[aria-pressed="true"] { background: rgba(56,189,248,0.16); box-shadow: inset 0 0 0 1px ${accent}; }
  
  /* ---- Diff tray: SLIDE (expands toolbar; no reserved space) ---- */
  .vmcb-diffgroup {
    --btn: 30px; --gap: 6px;
    position: relative; display: inline-flex; align-items: center;
    overflow: hidden; width: var(--btn);
    transition: width 160ms cubic-bezier(.2,.7,.2,1);
  }
  .vmcb-diffbar { display: inline-flex; align-items: center; }
  .vmcb-diffsub {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: var(--gap);
    background: ${trayBg}; border: 1px solid ${trayBorder}; border-radius: 8px; padding: 4px;
    box-shadow: ${trayShadow};
    opacity: 0; transform: translateX(10px);
    transition: opacity 160ms ease, transform 160ms ease;
  }
  .vmcb-diffsub .vmcb-btn + .vmcb-btn { box-shadow: -1px 0 0 ${trayBorder} inset; }
  
  .vmcb-diffgroup[data-show="on"]:hover,
  .vmcb-diffgroup[data-show="on"]:focus-within,
  .vmcb-diffgroup[data-open="true"] {
    width: calc(var(--btn) * 3 + var(--gap) * 2 + 10px);
  }
  .vmcb-diffgroup[data-show="on"]:hover .vmcb-diffsub,
  .vmcb-diffgroup[data-show="on"]:focus-within .vmcb-diffsub,
  .vmcb-diffgroup[data-open="true"] .vmcb-diffsub {
    opacity: 1; transform: translateX(0);
  }
  
  .vmcb-btn[data-role="diff-minus"][aria-pressed="true"] { color: ${dark ? '#ef4444' : '#b91c1c'}; }
  .vmcb-btn[data-role="diff-plus"][aria-pressed="true"]  { color: ${dark ? '#22c55e' : '#15803d'}; }
  /* Color halves of the diff icon based on toggles */
  .vmcb-wrap[data-hide-del="on"]  .vmcb-btn[data-role="diff"] .box-del { stroke: ${dark ? '#ef4444' : '#b91c1c'}; }
  .vmcb-wrap[data-hide-add="on"]  .vmcb-btn[data-role="diff"] .box-add { stroke: ${dark ? '#22c55e' : '#16a34a'}; }
  
  /* Search box */
  .vmcb-searchbox {
    display: none; align-items: center; gap: 6px; padding: 6px;
    position: absolute; top: 46px; right: 12px; z-index: 6;
    background: ${glass}; color: ${text}; border: 1px solid ${glassBorder}; border-radius: 10px;
    backdrop-filter: blur(10px) saturate(140%);
  }
  .vmcb-searchbox input[type="text"] {
    width: 220px; padding: 6px 8px; border: 1px solid ${glassBorder}; border-radius: 8px; outline: none; background: ${dark ? '#0f172a' : '#ffffff'}; color: ${text};
    font: 600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
  }
  .vmcb-searchbox .vmcb-count { font: 600 11px system-ui,-apple-system,Segoe UI,Roboto; opacity: 0.85; min-width: 42px; text-align: right; color: ${muted}; }
  .vmcb-searchbox .vmcb-smallbtn { width: 28px; height: 28px; }
  
  .vmcb-scroller {
    overflow: auto; height: 360px; resize: vertical; padding: 0; position: relative;
    border-radius: 0 0 14px 14px; border: 1px solid ${glassBorder}; border-top: 0; background: transparent;
    contain: layout paint;
  }
  .vmcb-pair { display: grid; grid-template-columns: auto 1fr; }
  .vmcb-gutter { user-select: none; border-right: 1px solid ${glassBorder}; padding: 0; background: transparent; color: ${muted}; min-width: 3.6em; }
  .vmcb-gutter ol { margin: 0; padding: 6px 8px 6px 6px; list-style: none; }
  .vmcb-gutter li { text-align: right; padding: 0 4px; font: 500 12px ui-monospace; line-height: var(--vmcb-lh, 1.5); height: var(--vmcb-lh, 1.5); }
  .vmcb-gutter li.vmcb-cont { color: ${muted}; }
  .vmcb-gutter li.vmcb-cont::before { content: '↪'; }
  
  .vmcb-codewrap { overflow: hidden; }
  .vmcb-scroller pre { margin: 0 !important; padding: 6px 10px 10px 10px; }
  .vmcb-scroller pre code { display: block; }
  
  /* Soft wrap */
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap,
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap pre,
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap pre *,
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap code,
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap code * {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
  }
  .vmcb-wrap[data-wrap="on"] .vmcb-codewrap pre { overflow-x: hidden !important; }
  
  /* Non-diff per-line wrapper */
  .vmcb-ln { display:block; min-height: var(--vmcb-lh, 1.5em); }
  .vmcb-ln:empty::after { content: "\\200B"; white-space: pre; }
  
  /* Pill collapse */
  .vmcb-pill {
    display: none; position: relative; padding: 8px 10px; border: 1px dashed ${glassBorder}; border-radius: 999px;
    background: ${glass}; color: ${text}; font: 600 12px ui-monospace;
    width: max-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
    margin: 8px auto; user-select: none; backdrop-filter: blur(8px) saturate(130%);
  }
  .vmcb-collapsed-pill .vmcb-pill { display: inline-block; }
  .vmcb-collapsed-pill .vmcb-scroller, .vmcb-collapsed-pill .vmcb-topbar { display: none; }
  .vmcb-collapsed-lines .vmcb-scroller { overflow: auto; }
  .vmcb-fadebottom::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 38px;
    background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, ${dark ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.96)'} 100%);
    pointer-events: none;
  }
  
  /* Search highlight */
  .vmcb-highlight { background: ${hl}; border-radius: 4px; box-shadow: 0 0 0 2px ${hl} inset; padding: 0 1px; }
  
  /* Diff coloring + structure */
  .vmcb-wrap code .vmcb-dline { display:block; padding:0 8px; }
  .vmcb-wrap code .vmcb-diff-add  { background: rgba(34,197,94,0.16); }
  .vmcb-wrap code .vmcb-diff-del  { background: rgba(239,68,68,0.20); }
  .vmcb-wrap code .vmcb-diff-hdr  { background: rgba(59,130,246,0.18); font-weight:600; }
  .vmcb-wrap code .vmcb-diff-hunk { background: rgba(148,163,184,0.25); font-style:italic; }
  
  /* Minimal highlight.js palette */
  .hljs { color: ${dark ? '#e5e7eb' : '#0f172a'}; }
  .hljs-comment, .hljs-quote { color: ${dark ? '#94a3b8' : '#64748b'}; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-subst { color: ${dark ? '#93c5fd' : '#1d4ed8'}; }
  .hljs-string, .hljs-doctag, .hljs-regexp { color: ${dark ? '#86efac' : '#166534'}; }
  .hljs-number, .hljs-literal, .hljs-bullet { color: ${dark ? '#fca5a5' : '#b91c1c'}; }
  
  /* Modal + Toast */
  .vmcb-modal { position: fixed; inset: 0; z-index: 9999; display: none; align-items: center; justify-content: center; background: ${dark ? 'rgba(8,15,28,0.88)' : 'rgba(15,23,42,0.66)'}; }
  .vmcb-modal.open { display: flex; }
  .vmcb-dialog {
    background: ${dark ? '#0f172a' : '#ffffff'}; color: ${text}; border: 1px solid ${glassBorder}; border-radius: 14px;
    width: min(720px, calc(100vw - 32px)); max-height: min(80vh, 800px); display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,0.35);
  }
  .vmcb-dialog header, .vmcb-dialog footer { padding: 12px; border-bottom: 1px solid ${glassBorder}; }
  .vmcb-dialog header { display: flex; align-items: center; justify-content: space-between; font: 700 14px system-ui,-apple-system,Segoe UI,Roboto; }
  .vmcb-dialog footer { border-top: 1px solid ${glassBorder}; border-bottom: 0; display: flex; gap: 8px; justify-content: flex-end; }
  .vmcb-dialog main { padding: 12px; overflow: auto; display: grid; gap: 10px; }
  .vmcb-dialog textarea {
    width: 100%; min-height: 260px; resize: vertical; background: ${dark ? '#0f172a' : '#ffffff'}; color: ${text};
    border: 1px solid ${glassBorder}; border-radius: 10px; padding: 8px;
    font: 600 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
  }
  .vmcb-row { display: flex; gap: 10px; align-items: center; }
  .vmcb-row label { font: 600 12px system-ui,-apple-system,Segoe UI,Roboto; min-width: 240px; }
  .vmcb-row input[type="number"], .vmcb-row select, .vmcb-row input[type="checkbox"], .vmcb-row input[type="color"], .vmcb-row input[type="text"] {
    font: 600 12px system-ui,-apple-system,Segoe UI,Roboto; background: ${dark ? '#0f172a' : '#ffffff'}; color: ${text};
    border: 1px solid ${glassBorder}; border-radius: 8px; padding: 6px 8px;
  }
  .vmcb-dialog button {
    appearance: none; border: 1px solid ${glassBorder}; background: ${trayBg}; color: ${text}; border-radius: 8px; padding: 8px 12px;
    font: 600 12px system-ui,-apple-system,Segoe UI,Roboto; cursor: pointer; transition: filter 100ms ease, box-shadow 140ms ease, background 140ms ease;
  }
  .vmcb-dialog button:hover { filter: brightness(1.05); }
  .vmcb-dialog button.vmcb-ack { box-shadow: inset 0 0 0 2px ${accent}; }
  .vmcb-danger { color: ${dark ? '#fecaca' : '#7f1d1d'}; border-color: ${dark ? '#7f1d1d' : '#fecaca'}; }
  
  .vmcb-toast {
    position: fixed; right: 18px; bottom: 18px; z-index: 9999;
    background: ${glass}; color: ${text}; border: 1px solid ${glassBorder}; border-radius: 10px; padding: 8px 12px;
    font: 600 12px system-ui,-apple-system,Segoe UI,Roboto; opacity: 0; transform: translateY(6px);
    transition: opacity 160ms ease, transform 160ms ease; backdrop-filter: blur(10px) saturate(140%);
  }
  .vmcb-toast.vmcb-show { opacity: 1; transform: translateY(0); }
  
  @media (prefers-reduced-motion: reduce) { .vmcb-scroller { scroll-behavior: auto !important; } }
  `;
      let tag = document.getElementById('vmcb-style');
      if (!tag) { tag = document.createElement('style'); tag.id = 'vmcb-style'; document.head.appendChild(tag); }
      tag.textContent = css;
    }
    injectStyle();
  
    // --------------------------- Icons ----------------------------------------
    function icon(name) {
      const common = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
      const i = {
        search:  `<svg viewBox="0 0 24 24" ${common}><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>`,
        wrap:    `<svg viewBox="0 0 24 24" ${common}><path d="M4 6h16"></path><path d="M4 12h10a4 4 0 1 1 0 8h-3"></path><path d="M11 17l-3 3l3 3"></path></svg>`,
        collapse:`<svg viewBox="0 0 24 24" ${common}><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h16"></path></svg>`,
        diff:    `<svg viewBox="0 0 24 24" ${common}>
                    <g class="box-del">
                      <rect x="3" y="3" width="8" height="8" rx="2"></rect>
                      <path d="M5.5 7h3"></path>
                    </g>
                    <g class="box-add">
                      <rect x="13" y="13" width="8" height="8" rx="2"></rect>
                      <path d="M15.5 17h3"></path>
                      <path d="M17 15.5v3"></path>
                    </g>
                  </svg>`,
        reset:   `<svg viewBox="0 0 24 24" ${common}><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path></svg>`,
        gear:    `<svg viewBox="0 0 24 24" ${common}><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1 .6 1.6 1.6 0 0 1-2 0 1.6 1.6 0 0 0-1-.6 1.6 1.6 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.3 9l-.1.1a1.6 1.6 0 0 0-.6 1 1.6 1.6 0 0 0 .6 1z"></path></svg>`,
        copy:    `<svg viewBox="0 0 24 24" ${common}><rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="4" y="4" width="10" height="10" rx="2"></rect></svg>`,
        up:      `<svg viewBox="0 0 24 24" ${common}><path d="M6 15l6-6l6 6"></path></svg>`,
        down:    `<svg viewBox="0 0 24 24" ${common}><path d="M6 9l6 6l6-6"></path></svg>`,
        close:   `<svg viewBox="0 0 24 24" ${common}><path d="M18 6L6 18M6 6l12 12"></path></svg>`,
        case:    `<svg viewBox="0 0 24 24" ${common}><path d="M6 17l3-10l3 10"></path><path d="M7.5 13h3"></path><path d="M14 15.5a2.5 2.5 0 1 0 0-5h-1.8v5"></path><path d="M12.2 13.5H16"></path></svg>`,
        plus:    `<svg viewBox="0 0 24 24" ${common}><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>`,
        minus:   `<svg viewBox="0 0 24 24" ${common}><path d="M5 12h14"></path></svg>`
      };
      return i[name] || '';
    }
  
    // --------------------------- Boot -----------------------------------------
    observeDom(); observeTheme();
    scheduleScan(); setTimeout(scheduleScan, 400); setTimeout(scheduleScan, 1500);
    installDelegation();
  
    function ensureIO() {
      if (!IO && 'IntersectionObserver' in window) {
        IO = new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting) {
            IO.unobserve(e.target);
            try { enhance(e.target); } catch (err) { console.error('[vmcb] enhance failed', err); }
          }
        }, { root: null, rootMargin: SETTINGS.lazyRootMargin });
      }
      return IO;
    }
    function ensureRO() {
      if (!RO && 'ResizeObserver' in window) {
        RO = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const st = byScroller.get(entry.target);
            if (!st) continue;
            requestAnimationFrame(() => {
              try {
                refreshLineHeight(st);
                refreshGutter(st);
                if (!st.userResized && st.collapseMode === 'none') autoHeight(st);
              } catch {}
            });
          }
        });
      }
      return RO;
    }
  
    function scheduleScan() {
      const io = ensureIO();
      qsa('pre code').forEach(code => {
        const pre = code.closest('pre');
        if (!pre || processed.has(pre)) return;
        if (shouldSkipCodeEl(code)) return;
        if (io) io.observe(pre);
        else try { enhance(pre); } catch (e) { console.error('[vmcb] enhance failed', e); }
      });
    }
  
    // --------------------------- Enhance ---------------------------------------
    function buildToolbar() {
      const tb = document.createElement('div');
      tb.className = 'vmcb-toolbar';
      const mk = (role, title, svg) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vmcb-btn';
        b.dataset.role = role;
        b.title = title; b.setAttribute('aria-label', title);
        b.innerHTML = svg;
        return b;
      };
  
      // Diff group — slide-out submenu (no pre-reserved space)
      const diffGroup = document.createElement('div');
      diffGroup.className = 'vmcb-diffgroup';
      diffGroup.dataset.show = 'off';
      const bar = document.createElement('div'); bar.className = 'vmcb-diffbar';
  
      const diffBtn = mk('diff', 'Patch / Diff mode', icon('diff'));
  
      const sub = document.createElement('div'); sub.className = 'vmcb-diffsub';
      const minusBtn = mk('diff-minus', 'Hide leading "-" (keep red highlights)', icon('minus'));
      const plusBtn  = mk('diff-plus',  'Hide leading "+" (keep green highlights)', icon('plus'));
      minusBtn.setAttribute('aria-pressed', 'false');
      plusBtn.setAttribute('aria-pressed', 'false');
      sub.append(minusBtn, plusBtn);
      bar.append(diffBtn, sub);
      diffGroup.append(bar);
  
      const resetBtn = mk('reset', 'Reset (exit diff mode)', icon('reset'));
      resetBtn.style.display = 'none';
  
      tb.append(
        mk('find',     'Find in code',                         icon('search')),
        mk('copy',     'Copy current contents',                icon('copy')),
        mk('wrap',     'Toggle soft wrap',                     icon('wrap')),
        mk('collapse', 'Collapse (click: none ↔ lines, Alt: pill)', icon('collapse')),
        diffGroup,
        resetBtn,
        mk('settings', 'Settings (defaults)',                  icon('gear'))
      );
      return tb;
    }
  
    function buildTopbar(lang) {
      const top = document.createElement('div');
      top.className = 'vmcb-topbar';
      const langBadge = document.createElement('div');
      langBadge.className = 'vmcb-lang';
      if (SETTINGS.showLanguage && lang && lang.toLowerCase() !== 'text') {
        langBadge.textContent = String(lang).toLowerCase();
      } else {
        langBadge.style.display = 'none';
      }
      const spacer = document.createElement('div');
      const toolbar = buildToolbar();
      top.append(langBadge, spacer, toolbar);
      top._handles = { toolbar, langBadge };
      return top;
    }
  
    function buildPill(lang, content) {
      const pill = document.createElement('div');
      pill.className = 'vmcb-pill';
      const preview = (content || '').trim().replace(/\s+/g, ' ').slice(0, SETTINGS.pillPreviewChars);
      pill.textContent = `[${lang}] ${preview}${preview.length >= SETTINGS.pillPreviewChars ? '…' : ''}`;
      pill.dataset.role = 'pill-expand';
      return pill;
    }
  
    function extractLanguage(codeEl) {
      const cls = codeEl.className || '';
      const m = cls.match(/language-([A-Za-z0-9_+-]+)/);
      return (m && m[1]) ? m[1] : 'text';
    }
  
    function enhance(pre) {
      const code = pre.querySelector('code') || pre;
      if (shouldSkipCodeEl(code)) return; // guard again at enhance-time
      const lang = extractLanguage(code);
  
      const container = document.createElement('div');
      container.className = 'vmcb-wrap';
  
      const topbar = buildTopbar(lang);
      const toolbar = topbar._handles.toolbar;
      const langBadge = topbar._handles.langBadge;
  
      const scroller = document.createElement('div');
      scroller.className = 'vmcb-scroller';
      scroller.style.height = SETTINGS.defaultHeightPx + 'px';
      scroller.tabIndex = 0;
  
      const pill = buildPill(lang, code.textContent || '');
  
      const pair = document.createElement('div'); pair.className = 'vmcb-pair';
      const gutter = document.createElement('div'); gutter.className = 'vmcb-gutter';
      const ol = document.createElement('ol'); gutter.appendChild(ol);
      const codeWrap = document.createElement('div'); codeWrap.className = 'vmcb-codewrap';
  
      pair.append(gutter, codeWrap);
      scroller.appendChild(pair);
      container.append(topbar, pill, scroller);
  
      // Search box
      const box = document.createElement('div');
      box.className = 'vmcb-searchbox';
      box.innerHTML = `
        <input type="text" placeholder="Find…">
        <span class="vmcb-count">0/0</span>
        <button class="vmcb-btn vmcb-smallbtn" data-role="search-prev" title="Previous match" aria-label="Previous match">${icon('up')}</button>
        <button class="vmcb-btn vmcb-smallbtn" data-role="search-next" title="Next match" aria-label="Next match">${icon('down')}</button>
        <button class="vmcb-btn vmcb-smallbtn" data-role="search-case" title="Case sensitive" aria-label="Case sensitive">${icon('case')}</button>
        <button class="vmcb-btn vmcb-smallbtn" data-role="search-close" title="Close search" aria-label="Close search">${icon('close')}</button>
      `;
      container.appendChild(box);
  
      // Insert wrapper before moving <pre>
      const parent = pre.parentNode;
      if (parent) parent.insertBefore(container, pre);
      codeWrap.appendChild(pre);
  
      /** @type {BlockState} */
      const st = {
        container, topbar, toolbar, langBadge, scroller, pair, gutter, gutterList: ol, codeWrap,
        pre, code, language: lang,
        inDiff: false, diffBackup: null, pill,
        search: { needle: '', ranges: [], index: -1, groups: [] },
        wrapOn: !!SETTINGS.wrap, collapseMode: SETTINGS.collapseMode,
        heightPx: SETTINGS.defaultHeightPx, userResized: false, lh: 0,
        hideAdd: false, hideDel: false,
        streamObs: null, streamTimer: null, streaming: false, squelchUntil: 0,
        isFinalizing: false
      };
  
      processed.add(pre);
      byContainer.set(container, st);
      byScroller.set(scroller, st);
      const inputEl = /** @type {HTMLInputElement} */(box.querySelector('input'));
      if (inputEl) bySearchInput.set(inputEl, st);
  
      // Minimal initial work; heavy rendering deferred until stream settles
      requestIdleCallbackSafe(() => {
        stripChatGPTChrome(st);
        applyWrapState(st);
        applyCollapseState(st);
        updateDiffGroupVisibility(st);
        armStreamingWatcher(st);
        scheduleFirstFinalize(st); // fast path for non-streaming blocks
      });
  
      const ro = ensureRO();
      if (ro) ro.observe(scroller);
    }
  
    // --------------------------- Transforms ------------------------------------
    const COMMON_LANGS = new Set([
      'bash','sh','zsh','shell','javascript','js','typescript','ts','jsx','tsx',
      'python','py','go','golang','java','kotlin','c','cpp','c++','c#','cs','csharp',
      'rust','rs','ruby','rb','php','swift','scala','elixir','erlang','haskell','hs',
      'lua','r','vb','vbnet','sql','json','yaml','yml','toml','ini','dockerfile','makefile',
      'powershell','ps1','html','xml','css','scss','less','markdown','md','diff','patch','text','txt','nginx','conf','properties'
    ]);
  
    function stripFencesAndLangHeader(st) {
      try {
        const raw = (st.code.textContent || '').replace(/\r\n/g, '\n');
        let lines = raw.split('\n');
        if (/^\s*```/.test(lines[0] || '')) lines.shift();
        if (lines.length > 1 && COMMON_LANGS.has((lines[0] || '').trim().toLowerCase())) {
          const rest = lines.slice(1).join('\n').trim();
          if (rest.length > 0) lines.shift();
        }
        if (lines.length && /^\s*```\s*$/.test(lines[lines.length - 1] || '')) lines.pop();
        const next = lines.join('\n');
        if (next !== raw) st.code.textContent = next;
      } catch {}
    }
  
    function stripChatGPTChrome(st) {
      try {
        const pre  = st.pre;
        const code = st.code;
        if (code.parentElement !== pre) { pre.innerHTML = ''; pre.appendChild(code); }
        else { Array.from(pre.children).forEach(ch => { if (ch !== code && !ch.contains(code)) ch.style.display = 'none'; }); }
      } catch {}
    }
  
    function applySyntaxHighlight(st) {
      try {
        if (window.hljs && st.language && st.language.toLowerCase() !== 'text') {
          window.hljs.highlightElement(st.code);
          st.code.classList.add('hljs');
        }
      } catch {}
    }
  
    function ensureDiffStructureIfNeeded(st) {
      const lang = (st.language || '').toLowerCase();
      const isDiffLike = /^(diff|patch)$/.test(lang) || /language-(diff|patch)/i.test(st.code.className || '');
      if (!isDiffLike) return;
      if (hasDiffLines(st)) return;
      const raw = (st.code.textContent || '').replace(/\r\n/g, '\n');
      st.code.innerHTML = diffTextToHtml(raw); // no extra visual blank lines
    }
  
    // Non-diff: split to per-line spans preserving inline markup
    function wrapLinesPreserveMarkup(st) {
      if (hasDiffLines(st) || st.code.querySelector('.vmcb-ln')) return;
      const code = st.code;
      const fragOut = document.createDocumentFragment();
  
      let lineSpan = document.createElement('span');
      lineSpan.className = 'vmcb-ln';
      let stack = [lineSpan];
  
      const newLine = () => {
        fragOut.appendChild(lineSpan);
        const newLineSpan = document.createElement('span'); newLineSpan.className = 'vmcb-ln';
        const newStack = [newLineSpan];
        for (let i = 1; i < stack.length; i++) {
          const clone = stack[i].cloneNode(false);
          newStack[newStack.length - 1].appendChild(clone);
          newStack.push(clone);
        }
        lineSpan = newLineSpan;
        stack = newStack;
      };
  
      const process = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parts = node.nodeValue.replace(/\r\n/g, '\n').split('\n');
          for (let i = 0; i < parts.length; i++) {
            if (parts[i]) stack[stack.length - 1].appendChild(document.createTextNode(parts[i]));
            if (i < parts.length - 1) newLine();
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const clone = node.cloneNode(false);
          stack[stack.length - 1].appendChild(clone);
          stack.push(clone);
          for (let ch = node.firstChild; ch; ch = ch.nextSibling) process(ch);
          stack.pop();
        }
      };
  
      const children = Array.from(code.childNodes);
      for (const n of children) process(n);
      fragOut.appendChild(lineSpan);
      code.innerHTML = '';
      code.appendChild(fragOut);
    }
  
    // --------------------------- Metrics / Layout ------------------------------
    function refreshLineHeight(st) {
      const lh = getLineHeightPx(st.code);
      if (lh && lh !== st.lh) { st.lh = lh; st.container.style.setProperty('--vmcb-lh', lh + 'px'); }
    }
    function getLineHeightPx(el) {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 16;
      const raw = cs.lineHeight;
      if (!raw || raw === 'normal') return Math.round(fs * 1.4);
      if (raw.endsWith('px')) { const n = parseFloat(raw); return Number.isFinite(n) ? n : Math.round(fs * 1.4); }
      const n = parseFloat(raw); return Number.isFinite(n) ? (n < 10 ? Math.round(n * fs) : Math.round(n)) : Math.round(fs * 1.4);
    }
  
    function hasDiffLines(st) { return !!st.code.querySelector('.vmcb-dline'); }
    function getLineSpans(st) {
      const diffs = Array.from(st.code.querySelectorAll('.vmcb-dline'));
      return diffs.length ? diffs : Array.from(st.code.querySelectorAll('.vmcb-ln'));
    }
  
    function refreshGutter(st) {
      const lineEls = getLineSpans(st);
      const lh = st.lh || getLineHeightPx(st.code);
  
      const items = [];
      if (!st.wrapOn) {
        for (let i = 0; i < lineEls.length; i++) items.push({ type: 'num', text: String(i + 1) });
      } else {
        const large = lineEls.length > SETTINGS.measureWrapMaxLines;
        for (let i = 0; i < lineEls.length; i++) {
          items.push({ type: 'num', text: String(i + 1) });
          if (large) continue;
          const h = Math.max(lineEls[i].getBoundingClientRect().height, lh);
          const wraps = Math.max(1, Math.floor(h / lh + 0.01));
          for (let k = 1; k < wraps; k++) items.push({ type: 'cont' });
        }
      }
  
      const ol = st.gutterList;
      const need = items.length, cur = ol.children.length;
      for (let i = cur - 1; i >= need; i--) ol.removeChild(ol.lastChild);
      for (let i = 0; i < need; i++) {
        const spec = items[i];
        let li = ol.children[i];
        if (!li) { li = document.createElement('li'); ol.appendChild(li); }
        li.className = spec.type === 'cont' ? 'vmcb-cont' : '';
        li.textContent = spec.type === 'num' ? spec.text : '';
      }
    }
  
    function heightForFirstNNumberedLines(st, n) { const lh = st.lh || getLineHeightPx(st.code); return Math.max(1, n) * lh; }
  
    function autoHeight(st) {
      if (st.userResized) return;
      const lineEls = getLineSpans(st);
      const lh = st.lh || getLineHeightPx(st.code);
  
      let rows = 0;
      if (st.wrapOn) {
        const large = lineEls.length > SETTINGS.measureWrapMaxLines;
        if (large) rows = lineEls.length;
        else for (const el of lineEls) { const h = Math.max(el.getBoundingClientRect().height, lh); rows += Math.max(1, Math.floor(h / lh + 0.01)); }
      } else rows = lineEls.length;
  
      const contentH = Math.max(SETTINGS.minHeightPx, Math.round(rows * lh));
      const h = Math.min(SETTINGS.defaultHeightPx, contentH);
      st.heightPx = h;
      if (st.collapseMode === 'none') st.scroller.style.height = h + 'px';
    }
  
    // --------------------------- Visual state ---------------------------------
    function applyWrapState(st) {
      st.container.dataset.wrap = st.wrapOn ? 'on' : 'off';
      const wrapBtn = st.toolbar.querySelector('[data-role="wrap"]');
      if (wrapBtn) wrapBtn.setAttribute('aria-pressed', st.wrapOn ? 'true' : 'false');
    }
  
    function applyCollapseState(st) {
      const { container, scroller, pill } = st;
      container.classList.remove('vmcb-collapsed-pill', 'vmcb-collapsed-lines', 'vmcb-fadebottom');
      pill.style.display = 'none';
      scroller.style.display = '';
      scroller.style.maxHeight = '';
  
      const collapseBtn = st.toolbar.querySelector('[data-role="collapse"]');
  
      if (st.collapseMode === 'pill') {
        container.classList.add('vmcb-collapsed-pill');
        pill.style.display = 'inline-block';
        if (collapseBtn) collapseBtn.setAttribute('aria-pressed', 'true');
        return;
      }
      if (st.collapseMode === 'lines') {
        const h = heightForFirstNNumberedLines(st, SETTINGS.collapseLines);
        scroller.style.height = Math.round(h) + 'px';
        container.classList.add('vmcb-collapsed-lines', 'vmcb-fadebottom');
        if (collapseBtn) collapseBtn.setAttribute('aria-pressed', 'true');
        return;
      }
  
      scroller.style.height = st.heightPx + 'px';
      if (collapseBtn) collapseBtn.setAttribute('aria-pressed', 'false');
    }
  
    // --------------------------- Copy / Text ----------------------------------
    function getPlainText(st) {
      const dlines = Array.from(st.code.querySelectorAll('.vmcb-dline'));
      if (dlines.length) return dlines.map(n => n.textContent || '').join('\n');
      const lineEls = Array.from(st.code.querySelectorAll('.vmcb-ln'));
      if (lineEls.length) return lineEls.map(n => n.textContent || '').join('\n');
      return (st.code.textContent || '').replace(/\r\n/g, '\n');
    }
  
    // --------------------------- Search ---------------------------------------
    function toggleSearchBox(st, on) {
      const box = st.container.querySelector('.vmcb-searchbox');
      const input = box?.querySelector('input');
      if (!box || !input) return;
      box.style.display = on ? 'flex' : 'none';
      const caseBtn = box.querySelector('[data-role="search-case"]');
      if (caseBtn) caseBtn.setAttribute('aria-pressed', SETTINGS.searchCaseSensitive ? 'true' : 'false');
  
      if (on) {
        input.value = st.search.needle || '';
        setTimeout(() => input.focus(), 0);
        runSearch(st, input.value || '');
      } else {
        clearHighlights(st);
        updateSearchCounter(st, 0, -1);
      }
    }
  
    function runSearch(st, needle) {
      st.search.needle = needle;
      clearHighlights(st);
      if (!needle) { updateSearchCounter(st, 0, -1); return; }
  
      const hay = (st.code.textContent || '').replace(/\r\n/g, '\n');
      const ranges = [];
      const flags = SETTINGS.searchCaseSensitive ? 'g' : 'gi';
      let re; try { re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); } catch { return; }
  
      let m, safety = 0;
      while ((m = re.exec(hay)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
        if (++safety > SETTINGS.searchMaxMarks) break;
      }
  
      st.search.ranges = ranges;
      st.search.index = ranges.length ? 0 : -1;
      st.search.groups = highlightRanges(st, ranges);
      updateSearchCounter(st, ranges.length, st.search.index);
      if (ranges.length) scrollToMatch(st, st.search.index);
    }
  
    function buildTextIndex(root) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n){ return (n.nodeValue && n.nodeValue.length) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
      });
      let off = 0, node;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        nodes.push({ node, start: off, end: off + len, len });
        off += len;
      }
      return nodes;
    }
  
    function highlightRanges(st, ranges) {
      const nodes = buildTextIndex(st.code);
      const groups = [];
      for (const { start, end } of ranges) {
        let sIdx = -1, eIdx = -1;
        for (let i = 0; i < nodes.length; i++) {
          if (sIdx < 0 && nodes[i].end > start) sIdx = i;
          if (nodes[i].start < end) eIdx = i;
          if (nodes[i].start >= end) break;
        }
        if (sIdx < 0 || eIdx < 0) { groups.push([]); continue; }
  
        const sNode = nodes[sIdx].node;
        const eNode = nodes[eIdx].node;
        const sOff  = Math.max(0, start - nodes[sIdx].start);
        const eOff  = Math.min(nodes[eIdx].len, end - nodes[eIdx].start);
  
        const rng = document.createRange();
        rng.setStart(sNode, sOff);
        rng.setEnd(eNode, eOff);
        try {
          const mark = document.createElement('mark'); mark.className = 'vmcb-highlight';
          rng.surroundContents(mark); groups.push([mark]);
        } catch {
          const subgroup = [];
          let pos = start;
          for (let i = sIdx; i <= eIdx; i++) {
            const n = nodes[i];
            const s = Math.max(0, pos - n.start);
            const e = Math.min(n.len, end - n.start);
            if (e > s) {
              const rr = document.createRange();
              rr.setStart(n.node, s); rr.setEnd(n.node, e);
              const mk = document.createElement('mark'); mk.className = 'vmcb-highlight';
              rr.surroundContents(mk); subgroup.push(mk);
            }
            pos = Math.max(pos, n.end);
          }
          groups.push(subgroup);
        }
      }
      return groups;
    }
  
    function clearHighlights(st) {
      st.search.groups = [];
      qsa('mark.vmcb-highlight', st.pre).forEach(mark => {
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
    }
    function updateSearchCounter(st, total, idx) {
      const countEl = st.container.querySelector('.vmcb-searchbox .vmcb-count');
      if (countEl) countEl.textContent = total ? `${idx + 1}/${total}` : '0/0';
    }
    function scrollToMatch(st, idx, smooth = true) {
      const groups = st.search.groups || [];
      const segs = groups[idx] || groups[0] || [];
      const target = segs[0];
      if (!target) return;
      const scr = st.scroller.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      const delta = tr.top - scr.top - SETTINGS.searchContextPx;
      st.scroller.scrollTo({ top: st.scroller.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
    }
    function jumpMatch(st, dir) {
      if (!st.search.ranges.length) return;
      st.search.index = (st.search.index + dir + st.search.ranges.length) % st.search.ranges.length;
      updateSearchCounter(st, st.search.ranges.length, st.search.index);
      scrollToMatch(st, st.search.index, true);
    }
  
    // --------------------------- Diff mode + +/- toggles ----------------------
    const DiffLib = (window.Diff || window.JsDiff || window.diff || window.jsdiff);
  
    function openDiffModal(st) {
      if (st.streaming) { toast('Waiting for generation to settle…'); return; }
  
      const modal = buildModal('Patch / Diff mode');
      const main = modal.querySelector('main');
      const footer = modal.querySelector('footer');
  
      const ta = document.createElement('textarea');
      ta.placeholder = 'Paste SOURCE text here. The current code block is TARGET.\nA unified patch will be generated (SOURCE → TARGET).';
  
      const row = document.createElement('div'); row.className = 'vmcb-row';
      const lblCtx = document.createElement('label'); lblCtx.textContent = 'Context lines';
      const inCtx = document.createElement('input'); inCtx.type = 'number'; inCtx.min = '0'; inCtx.max = '1000'; inCtx.value = String(SETTINGS.diffContext);
      row.append(lblCtx, inCtx);
      main.append(ta, row);
  
      const applyBtn = document.createElement('button'); applyBtn.textContent = 'Generate patch';
      const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => { cancelBtn.classList.add('vmcb-ack'); closeModal(modal); });
      applyBtn.addEventListener('click', () => {
        applyBtn.classList.add('vmcb-ack');
        const src = ta.value.replace(/\r\n/g, '\n');
        const tgt = getPlainText(st).replace(/\r\n/g, '\n');
        const ctx = Math.max(0, Math.min(1000, parseInt(inCtx.value || '3', 10) || 0));
        SETTINGS.diffContext = ctx; saveSettings(SETTINGS);
  
        if (!DiffLib?.createTwoFilesPatch) { alert('Diff library failed to load.'); return; }
        const patch = DiffLib.createTwoFilesPatch('source', 'target', src, tgt, '', '', { context: ctx });
        if (!/^\s*@@/m.test(patch)) { alert('No differences detected (source and target are identical).'); return; }
        enterDiffMode(st, patch);
        closeModal(modal);
      });
  
      footer.append(applyBtn, cancelBtn);
      openModal(modal);
    }
  
    // Build HTML lines for diff without injecting extra newline text nodes (avoids visual blank rows in <pre>)
    function diffTextToHtml(text) {
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const htmlLines = (text || '').replace(/\r\n/g,'\n').split('\n').map(line => {
        let cls = 'vmcb-dline ';
        if (line.startsWith('@@')) cls += 'vmcb-diff-hunk';
        else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) cls += 'vmcb-diff-hdr';
        else if (line.startsWith('+')) cls += 'vmcb-diff-add';
        else if (line.startsWith('-')) cls += 'vmcb-diff-del';
        else cls += 'vmcb-diff-ctx';
        return `<span class="${cls}">${esc(line)}</span>`;
      });
      return htmlLines.join(''); // no newline nodes → no extra visual spacing
    }
  
    function applyDiffStyling(st) {
      const raw = st.code.textContent || '';
      st.code.innerHTML = diffTextToHtml(raw);
    }
  
    function enterDiffMode(st, patchText) {
      if (st.inDiff) exitDiffMode(st, { restore: false });
      st.diffBackup = getPlainText(st);
      st.inDiff = true;
      st.code.className = (st.code.className || '').replace(/language-[^\s]+/g, '').trim() + ' language-diff';
      st.code.textContent = patchText.replace(/\r\n/g, '\n');
      applyDiffStyling(st);
  
      const resetBtn = st.toolbar.querySelector('[data-role="reset"]');
      const diffBtn = st.toolbar.querySelector('[data-role="diff"]');
      if (resetBtn) resetBtn.style.display = '';
      if (diffBtn) diffBtn.setAttribute('aria-pressed', 'true');
  
      st.scroller.style.maxHeight = Math.max(SETTINGS.defaultHeightPx, 260) + 'px';
      refreshLineHeight(st);
      refreshGutter(st);
      updateDiffGroupVisibility(st);
    }
  
    function exitDiffMode(st, { restore }) {
      if (!st.inDiff) return;
      const resetBtn = st.toolbar.querySelector('[data-role="reset"]');
      const diffBtn = st.toolbar.querySelector('[data-role="diff"]');
      if (resetBtn) resetBtn.style.display = 'none';
      if (diffBtn) diffBtn.setAttribute('aria-pressed', 'false');
      st.inDiff = false;
  
      if (restore && st.diffBackup != null) {
        st.code.textContent = st.diffBackup;
        if (st.language) {
          st.code.className = (st.code.className || '').replace(/language-[^\s]+/g, '').trim() + ' language-' + st.language;
        }
        applySyntaxHighlight(st);
        ensureDiffStructureIfNeeded(st);
        if (!hasDiffLines(st)) wrapLinesPreserveMarkup(st);
        refreshLineHeight(st);
      }
      st.hideAdd = st.hideDel = false;
      st.container.dataset.hideAdd = 'off';
      st.container.dataset.hideDel = 'off';
      st.diffBackup = null;
  
      refreshGutter(st); autoHeight(st); applyCollapseState(st);
      updateDiffGroupVisibility(st);
    }
  
    function updateDiffGroupVisibility(st) {
      const group = st.toolbar.querySelector('.vmcb-diffgroup');
      if (!group) return;
      const show = st.inDiff || /language-(diff|patch)/i.test(st.code.className || '') || hasDiffLines(st);
      group.dataset.show = show ? 'on' : 'off';
    }
  
    // Hide/show the leading '+' or '-' WITHOUT losing the line's class (keeps colors).
    function setHideDiffChar(st, type, on) {
      const cls = type === 'add' ? '.vmcb-diff-add' : '.vmcb-diff-del';
      const lines = qsa('.vmcb-dline' + cls, st.code);
      const head = type === 'add' ? '+' : '-';
      for (const el of lines) {
        if (on) {
          if (el.dataset.vmcbHeadRemoved === head) continue;
          const t = el.textContent || '';
          if (t.startsWith(head)) {
            el.textContent = t.slice(1);   // keep line classes → colors preserved
            el.dataset.vmcbHeadRemoved = head;
          }
        } else {
          if (el.dataset.vmcbHeadRemoved === head) {
            el.textContent = head + (el.textContent || '');
            delete el.dataset.vmcbHeadRemoved;
          }
        }
      }
    }
  
    // --------------------------- Settings UI ----------------------------------
    function openSettingsModal() {
      const modal = buildModal('Codeblock Power Tools — Settings (Global defaults)');
      const main = modal.querySelector('main');
      const footer = modal.querySelector('footer');
  
      const row1  = rowSelect('Collapse mode (default)', ['none','lines','pill'], SETTINGS.collapseMode);
      const row2  = rowNumber('Lines (collapse: lines)', SETTINGS.collapseLines, 1, 200);
      const row3  = rowNumber('Default height max (px)', SETTINGS.defaultHeightPx, 120, 3000);
      const row3b = rowNumber('Minimum height (px)', SETTINGS.minHeightPx, 60, 1000);
      const row4  = rowCheckbox('Soft wrap (default)', SETTINGS.wrap);
      const row5  = rowCheckbox('Search case sensitive (default)', SETTINGS.searchCaseSensitive);
      const row6  = rowNumber('Diff context lines', SETTINGS.diffContext, 0, 1000);
      const row7  = rowNumber('Pill preview chars', SETTINGS.pillPreviewChars, 16, 400);
      const row8  = rowCheckbox('Show language badge', SETTINGS.showLanguage);
      const row9  = colorRow('Search highlight (light theme)', SETTINGS.searchHighlightColorLight);
      const row10 = colorRow('Search highlight (dark theme)',  SETTINGS.searchHighlightColorDark);
      const row11 = rowNumber('Wrap measure max lines (perf)', SETTINGS.measureWrapMaxLines, 200, 10000);
      const row12 = rowNumber('Search highlight max marks', SETTINGS.searchMaxMarks, 100, 20000);
      const row13 = rowNumber('Stream stabilize debounce (ms)', SETTINGS.streamStabilizeMs, 200, 3000);
      const row14 = rowText('Exclude languages (comma-list)', SETTINGS.excludedLangs);
  
      main.append(row1.el,row2.el,row3.el,row3b.el,row4.el,row5.el,row6.el,row7.el,row8.el,row9.el,row10.el,row11.el,row12.el,row13.el,row14.el);
  
      const applyBtn = document.createElement('button'); applyBtn.textContent = 'Apply to all';
      const resetBtn = document.createElement('button'); resetBtn.textContent = 'Reset defaults'; resetBtn.className = 'vmcb-danger';
      const closeBtn = document.createElement('button'); closeBtn.textContent = 'Close';
  
      closeBtn.addEventListener('click', () => { closeBtn.classList.add('vmcb-ack'); closeModal(modal); });
      resetBtn.addEventListener('click', () => {
        resetBtn.classList.add('vmcb-ack');
        SETTINGS = { ...DEFAULTS }; saveSettings(SETTINGS);
        applyAllSettings();
        toast('Defaults restored & applied.');
      });
      applyBtn.addEventListener('click', () => {
        applyBtn.classList.add('vmcb-ack');
        SETTINGS.collapseMode        = row1.get();
        SETTINGS.collapseLines       = row2.get();
        SETTINGS.defaultHeightPx     = row3.get();
        SETTINGS.minHeightPx         = row3b.get();
        SETTINGS.wrap                = row4.get();
        SETTINGS.searchCaseSensitive = row5.get();
        SETTINGS.diffContext         = row6.get();
        SETTINGS.pillPreviewChars    = row7.get();
        SETTINGS.showLanguage        = row8.get();
        SETTINGS.searchHighlightColorLight = row9.get();
        SETTINGS.searchHighlightColorDark  = row10.get();
        SETTINGS.measureWrapMaxLines = row11.get();
        SETTINGS.searchMaxMarks      = row12.get();
        SETTINGS.streamStabilizeMs   = row13.get();
        SETTINGS.excludedLangs       = row14.get();
        SETTINGS.schema = SETTINGS_SCHEMA;
        saveSettings(SETTINGS);
        applyAllSettings();                 // apply immediately
        toast('Settings applied to all code blocks.');
      });
  
      footer.append(applyBtn, resetBtn, closeBtn);
      openModal(modal);
    }
  
    function rowSelect(label, options, current) {
      const el = document.createElement('div'); el.className = 'vmcb-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const sel = document.createElement('select');
      options.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (v === current) o.selected = true; sel.appendChild(o); });
      el.append(lab, sel);
      return { el, get: () => sel.value, set: (v)=>{ sel.value=v; } };
    }
    function rowNumber(label, current, min, max) {
      const el = document.createElement('div'); el.className = 'vmcb-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.value = String(current);
      el.append(lab, inp);
      return { el, get: () => clampInt(inp.value, min, max, current), set: (v)=>{ inp.value = String(v); } };
    }
    function rowCheckbox(label, current) {
      const el = document.createElement('div'); el.className = 'vmcb-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!current;
      el.append(lab, inp);
      return { el, get: () => !!inp.checked, set: (v)=>{ inp.checked = !!v; } };
    }
    function colorRow(label, current) {
      const el = document.createElement('div'); el.className = 'vmcb-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'color';
      try { inp.value = normalizeHex(current); } catch { inp.value = '#fff275'; }
      el.append(lab, inp);
      return { el, get: () => inp.value, set: (v)=>{ try { inp.value = normalizeHex(v); } catch {} } };
    }
    function rowText(label, current) {
      const el = document.createElement('div'); el.className = 'vmcb-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = current || '';
      el.append(lab, inp);
      return { el, get: () => String(inp.value || '').trim(), set: (v)=>{ inp.value = String(v || ''); } };
    }
    function normalizeHex(c) {
      c = (c || '').trim();
      if (/^#([0-9a-f]{3,8})$/i.test(c)) return c;
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return '#fff275';
      const r = (parseInt(m[1]) & 255).toString(16).padStart(2,'0');
      const g = (parseInt(m[2]) & 255).toString(16).padStart(2,'0');
      const b = (parseInt(m[3]) & 255).toString(16).padStart(2,'0');
      return `#${r}${g}${b}`;
    }
    function clampInt(v, min, max, d) { const n = parseInt(String(v), 10); if (!Number.isFinite(n)) return d; return Math.max(min, Math.min(max, n)); }
  
    function applyAllSettings() {
      injectStyle();
  
      // Decide which blocks to teardown due to exclusion
      const toTeardown = [];
      for (const [container, st] of byContainer) {
        if (!container.isConnected) continue;
        if (isExcludedLanguage(st.language)) toTeardown.push(st);
      }
      // Teardown excluded ones
      for (const st of toTeardown) teardownBlock(st);
  
      // Re-apply to remaining enhanced blocks
      for (const [container, st] of byContainer) {
        if (!container.isConnected) continue;
        if (!st.inDiff) {
          st.wrapOn = !!SETTINGS.wrap;
          st.collapseMode = SETTINGS.collapseMode;
          const show = SETTINGS.showLanguage && st.language && st.language.toLowerCase() !== 'text';
          st.langBadge.textContent = show ? st.language.toLowerCase() : '';
          st.langBadge.style.display = show ? '' : 'none';
          finalizeStream(st); // re-render safely with new look/limits
        }
      }
  
      // Rescan the DOM to enhance any non-excluded, not-yet-processed blocks
      scheduleScan();
    }
  
    function teardownBlock(st) {
      try { st.streamObs?.disconnect(); } catch {}
      try { RO?.unobserve(st.scroller); } catch {}
      const input = st.container.querySelector('.vmcb-searchbox input');
      if (input) bySearchInput.delete(input);
      byScroller.delete(st.scroller);
      byContainer.delete(st.container);
      processed.delete(st.pre);
  
      // Move the original <pre> back where the wrapper sits, then remove wrapper
      const parent = st.container.parentNode;
      if (parent) parent.insertBefore(st.pre, st.container);
      st.container.remove();
    }
  
    // --------------------------- Streaming watcher ----------------------------
    function armStreamingWatcher(st) {
      try { st.streamObs?.disconnect(); } catch {}
      st.streaming = false;
      const obs = new MutationObserver(() => {
        const now = performance.now();
        if (st.inDiff) return;
        if (st.squelchUntil && now < st.squelchUntil) return;
        st.streaming = true;
        if (st.streamTimer) clearTimeout(st.streamTimer);
        st.streamTimer = setTimeout(() => finalizeStream(st), SETTINGS.streamStabilizeMs);
      });
      obs.observe(st.code, { childList: true, characterData: true, subtree: true });
      st.streamObs = obs;
    }
  
    function scheduleFirstFinalize(st) {
      // If the block isn't streaming, render shortly; otherwise the observer will handle it.
      setTimeout(() => { if (!st.streaming) finalizeStream(st); }, 100);
    }
  
    function collectRawFromDom(st) {
      if (hasDiffLines(st)) {
        return qsa('.vmcb-dline', st.code).map(n => n.textContent || '').join('\n');
      }
      return (st.code.textContent || '').replace(/\r\n/g, '\n');
    }
  
    function finalizeStream(st) {
      if (st.isFinalizing) return;
      st.isFinalizing = true;
  
      st.streaming = false;
      try { st.streamObs?.disconnect(); } catch {}
  
      const rawBefore = collectRawFromDom(st);
  
      // Rebuild cleanly from raw text each pass (idempotent)
      st.code.textContent = rawBefore;
      stripFencesAndLangHeader(st);
      if (st.language) st.code.className = (st.code.className || '').replace(/language-[^\s]+/g, '').trim() + ' language-' + st.language;
  
      applySyntaxHighlight(st);
      ensureDiffStructureIfNeeded(st);
      if (!hasDiffLines(st)) wrapLinesPreserveMarkup(st);
  
      if (st.hideAdd) setHideDiffChar(st, 'add', true);
      if (st.hideDel) setHideDiffChar(st, 'del', true);
  
      refreshLineHeight(st); refreshGutter(st); autoHeight(st); applyCollapseState(st);
      updateDiffGroupVisibility(st);
  
      st.isFinalizing = false;
      armStreamingWatcher(st);
    }
  
    function squelchStream(st, ms = SETTINGS.streamStabilizeMs) {
      st.squelchUntil = performance.now() + ms;
      setTimeout(() => { if (performance.now() >= st.squelchUntil) st.squelchUntil = 0; }, ms + 50);
    }
  
    // --------------------------- Modal / Toast --------------------------------
    function buildModal(titleText) {
      const modal = document.createElement('div');
      modal.className = 'vmcb-modal';
      const dlg = document.createElement('div'); dlg.className = 'vmcb-dialog';
      const header = document.createElement('header');
      const title = document.createElement('div'); title.textContent = titleText;
      const close = document.createElement('button'); close.textContent = '✕'; close.addEventListener('click', () => closeModal(modal));
      header.append(title, close);
      const main = document.createElement('main');
      const footer = document.createElement('footer');
      dlg.append(header, main, footer);
      modal.appendChild(dlg);
      document.body.appendChild(modal);
      return modal;
    }
    function openModal(modal) { modal.classList.add('open'); const onKey = (e) => { if (e.key === 'Escape') closeModal(modal); }; modal._key = onKey; document.addEventListener('keydown', onKey, true); modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); }); }
    function closeModal(modal) { try { document.removeEventListener('keydown', modal._key, true); } catch {} modal.classList.remove('open'); setTimeout(() => modal.remove(), 20); }
    function toast(msg) { let t = document.getElementById('vmcb-toast'); if (!t) { t = document.createElement('div'); t.id = 'vmcb-toast'; t.className = 'vmcb-toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('vmcb-show'); setTimeout(() => t.classList.remove('vmcb-show'), 1200); }
  
    // --------------------------- Observers / Delegation -----------------------
    function observeDom() {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = /** @type {Element} */(n);
          if (el.matches?.('pre, code, article, .markdown, [data-testid="conversation-turn"]') ||
              el.querySelector?.('pre, code, article, .markdown, [data-testid="conversation-turn"]')) {
            scheduleScan();
            return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  
    function observeTheme() {
      const on = debounce(() => { injectStyle(); }, 80);
      new MutationObserver(on).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    }
  
    function installDelegation() {
      if (delegated) return; delegated = true;
  
      document.addEventListener('click', (e) => {
        const tgt = /** @type {HTMLElement} */(e.target);
        const roleEl = tgt.closest?.('[data-role]');
        const wrap = tgt.closest?.('.vmcb-wrap'); if (!wrap) return;
        const st = byContainer.get(wrap); if (!st) return;
  
        const role = roleEl?.getAttribute?.('data-role');
        switch (role) {
          case 'collapse': {
            e.preventDefault();
            const alt = e.altKey;
            st.collapseMode = alt ? (st.collapseMode === 'pill' ? 'none' : 'pill')
                                  : (st.collapseMode === 'none' ? 'lines' : 'none');
            applyCollapseState(st);
            break;
          }
          case 'wrap': {
            e.preventDefault();
            st.wrapOn = !st.wrapOn;
            applyWrapState(st);
            autoHeight(st);
            applyCollapseState(st);
            break;
          }
          case 'copy': {
            e.preventDefault();
            const text = getPlainText(st);
            navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
            break;
          }
          case 'settings': e.preventDefault(); openSettingsModal(); break;
          case 'diff': {
            e.preventDefault();
            openDiffModal(st);
            break;
          }
          case 'reset': {
            e.preventDefault();
            exitDiffMode(st, { restore: true });
            refreshGutter(st); autoHeight(st); applyCollapseState(st);
            break;
          }
          case 'find': {
            e.preventDefault();
            toggleSearchBox(st, true);
            const input = st.container.querySelector('.vmcb-searchbox input'); input?.select();
            break;
          }
          case 'search-prev': e.preventDefault(); jumpMatch(st, -1); break;
          case 'search-next': e.preventDefault(); jumpMatch(st, +1); break;
          case 'search-case': {
            e.preventDefault();
            SETTINGS.searchCaseSensitive = !SETTINGS.searchCaseSensitive;
            saveSettings(SETTINGS);
            roleEl?.setAttribute('aria-pressed', SETTINGS.searchCaseSensitive ? 'true' : 'false');
            const input = st.container.querySelector('.vmcb-searchbox input');
            runSearch(st, (/** @type {HTMLInputElement} */(input))?.value || '');
            break;
          }
          case 'search-close': e.preventDefault(); toggleSearchBox(st, false); break;
  
          // +/- diff toggles
          case 'diff-minus': {
            e.preventDefault();
            if (st.streaming) { toast('Waiting for generation to settle…'); return; }
            if (!hasDiffLines(st)) return;
            squelchStream(st, 800);
            st.hideDel = !st.hideDel;
            st.container.dataset.hideDel = st.hideDel ? 'on' : 'off';
            roleEl.setAttribute('aria-pressed', st.hideDel ? 'true' : 'false');
            setHideDiffChar(st, 'del', st.hideDel);
            break;
          }
          case 'diff-plus': {
            e.preventDefault();
            if (st.streaming) { toast('Waiting for generation to settle…'); return; }
            if (!hasDiffLines(st)) return;
            squelchStream(st, 800);
            st.hideAdd = !st.hideAdd;
            st.container.dataset.hideAdd = st.hideAdd ? 'on' : 'off';
            roleEl.setAttribute('aria-pressed', st.hideAdd ? 'true' : 'false');
            setHideDiffChar(st, 'add', st.hideAdd);
            break;
          }
        }
  
        if (tgt.closest?.('[data-role="pill-expand"]')) { st.collapseMode = 'none'; applyCollapseState(st); }
      }, true);
  
      // Search input (delegated)
      document.addEventListener('input', (e) => {
        const el = /** @type {HTMLElement} */(e.target);
        if (!(el instanceof HTMLInputElement)) return;
        if (!el.closest('.vmcb-searchbox')) return;
        const st = bySearchInput.get(el); if (!st) return;
        runSearch(st, el.value || '');
      }, true);
  
      // Keyboard
      document.addEventListener('keydown', (e) => {
        const el = /** @type {HTMLElement} */(e.target);
        const scroller = el.closest?.('.vmcb-scroller');
        if (scroller && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          const st = byScroller.get(scroller);
          if (st) { e.preventDefault(); toggleSearchBox(st, true); const input = st.container.querySelector('.vmcb-searchbox input'); input?.select(); return; }
        }
        if (el instanceof HTMLInputElement && el.closest('.vmcb-searchbox')) {
          const st = bySearchInput.get(el); if (!st) return;
          if (e.key === 'Enter') { e.preventDefault(); jumpMatch(st, +1); }
          if (e.key === 'Escape') { e.preventDefault(); toggleSearchBox(st, false); }
        }
      }, true);
  
      // Manual resize → persist
      document.addEventListener('mouseup', (e) => {
        const el = /** @type {HTMLElement} */(e.target);
        const sc = el.closest?.('.vmcb-scroller'); if (!sc) return;
        const st = byScroller.get(sc); if (!st) return;
        const h = Math.max(SETTINGS.minHeightPx, Math.round(st.scroller.getBoundingClientRect().height));
        st.heightPx = h; st.userResized = true;
        if (st.collapseMode === 'none') st.scroller.style.height = h + 'px';
        refreshGutter(st);
      }, true);
    }
  
    // --------------------------- Helpers --------------------------------------
    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
    function requestIdleCallbackSafe(fn) { if ('requestIdleCallback' in window) return window.requestIdleCallback(fn, { timeout: 800 }); return setTimeout(fn, 50); }
  
  })();
  