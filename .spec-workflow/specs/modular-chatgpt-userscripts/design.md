 # Design — Modular ChatGPT Userscripts (Vite+ + TypeScript)

 ## Overview
 Refactor two userscripts into a modular TypeScript repo using Vite+ for multi-entry builds that emit `.user.js`. Shared utilities remove duplication and keep entries small. A scaffold command adds future scripts automatically.

 ## Architecture
 - `entries/` — one folder per userscript entry
   - `codeblock-tools/` → `index.ts` (main), `metadata.ts` (userscript header data)
   - `mermaid-renderer/` → `index.ts`, `metadata.ts`
 - `shared/` — cross‑entry utilities
   - `dom.ts` (qs/qsa, element helpers, safe injection)
   - `theme.ts` (dark/light detection, CSS injection)
   - `time.ts` (debounce/throttle, idle-callback wrappers)
   - `storage.ts` (localStorage schema/upgrade helpers)
   - `observers.ts` (Mutation/Resize/Intersection wiring)
   - `ui/` (modal, toast, toolbar primitives)
   - `code/` (gutter/line-metrics, search highlighter, diff helpers)
 - `scripts/` — tooling
   - `scaffold.ts` (create new entry folder + metadata, register in `entries.json`)
   - `zip-dist.ts` (optional artifacts zip)
 - Root config
   - `entries.json` (authoritative entry list + per-entry build config)
   - `vite.config.ts` (Vite+ multi-entry; metadata injection; per-entry externals)
   - `tsconfig.json` (paths: `@shared/*` → `shared/*`)

 ## Entries and Metadata
 - `entries.json` schema (example):
   ```json
   {
     "codeblock-tools": {
       "path": "entries/codeblock-tools/index.ts",
       "metadata": {
         "name": "ChatGPT Codeblock Tools",
         "namespace": "https://tampermonkey.net/",
         "version": "1.14.0",
         "description": "Fast, modern controls for ChatGPT code blocks…",
         "match": ["https://chat.openai.com/*", "https://chatgpt.com/*"],
         "runAt": "document-idle",
         "grant": [],
         "require": [
           { "cdn": "https://cdnjs.cloudflare.com/ajax/libs/jsdiff/8.0.2/diff.min.js" },
           { "cdn": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" }
         ]
       }
     },
     "mermaid-renderer": {
       "path": "entries/mermaid-renderer/index.ts",
       "metadata": {
         "name": "ChatGPT Mermaid Renderer",
         "namespace": "http://tampermonkey.net/",
         "version": "1.0.4",
         "description": "Mermaid in ChatGPT with tabs, zoom, caching, errors…",
         "match": ["https://chat.openai.com/*", "https://chatgpt.com/*"],
         "runAt": "document-idle",
         "grant": [],
         "require": [
           { "cdn": "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js" }
         ]
       }
     }
   }
   ```
 - Each entry also exports `metadata.ts` for type-safety; the builder merges `metadata.ts` with `entries.json` (file overrides JSON when present).

 ## Build System (Vite+)
 - Multi-entry: load `entries.json`, produce Rollup inputs for each `path`.
 - Userscript header injection: small Vite+ plugin prepends a metadata block generated from metadata (name, namespace, version, match, run-at, grant, require).
 - Externals per entry: when `metadata.require` is present, mark those libs as external in Rollup and do not bundle them; otherwise bundle if imported.
 - Output filenames: `dist/<entry>.user.js`.
 - Dev workflow: `vite+ dev` (or `vite` if aliased) with watch on entries; rebuild changed entry quickly. No HMR is required for userscripts, but incremental rebuilds are enabled.

 ## TypeScript & Linting
 - `tsconfig.json`: strict mode, `"module": "ESNext"`, `"target": "ES2020"`, path alias `@shared/*`.
 - ESLint (recommended rules) and Prettier (optional) via npm scripts `lint`, `lint:fix`.
 - No implicit `any`; explicit escapes allowed in DOM interop areas.

 ## Shared Utilities Mapping (from existing scripts)
 - `dom.ts`: `qs`, `qsa`, element creation, safe style injection.
 - `theme.ts`: dark detection used by both scripts; CSS variable computation.
 - `time.ts`: `debounce`, `requestIdleCallbackSafe`.
 - `observers.ts`: wrappers to create/dispose `MutationObserver`, `ResizeObserver`, `IntersectionObserver`.
 - `storage.ts`: settings load/save with schema versioning (used by codeblock-tools).
 - `ui/modal.ts`, `ui/toast.ts`, `ui/toolbar.ts`: primitives to compose topbar/toolbars and toast messaging.
 - `code/search.ts`: build text index, highlight ranges, match navigation.
 - `code/diff.ts`: render unified patch HTML safely and +/- toggles.

 ## Migration Notes
 - Preserve behavior: streaming stabilization, lazy scans, DOM observers, per-diagram caching, error capture, zoom/pan/lightbox.
 - Replace direct DOM literals with helpers; keep CSS injection logic equivalent (computed by theme).
 - Keep per-entry features self-contained; only move truly generic helpers to `shared/`.

 ## External Libraries Strategy
 - Codeblock Tools: keep `jsdiff`, `highlight.js` as `@require` via metadata for size; entries may still import types or minimal wrappers (guarded).
 - Mermaid Renderer: keep `mermaid` as `@require` for size and compatibility; do not bundle mermaid.
 - Future entries can opt-in to bundling by omitting `require` and importing the lib.

 ## CLI Scaffolding
 - `npm run scaffold:new -- <kebab-name>`:
   - Creates `entries/<name>/index.ts` + `metadata.ts` from template.
   - Adds entry to `entries.json` with defaults (name, version `0.0.1`, matches, runAt).
   - Prints next steps.

 ## Scripts
 - `bootstrap`: install deps and initialize Vite+ config (idempotent).
 - `dev`: start Vite+ in watch mode over all entries.
 - `build`: emit `dist/*.user.js` with headers.
 - `typecheck`: `tsc -p tsconfig.json --noEmit`.
 - `lint`, `lint:fix`.
 - `zip`: optional `dist/artifacts.zip`.

 ## Acceptance Alignment
 - Two outputs functionally equivalent to originals.
 - New entry scaffolding wires into `entries.json` and builds without manual edits.
 - Shared utilities remove duplication (≥3 helpers consolidated).
 - Strict TS passes; lint/typecheck clean.

 ## Risks & Mitigations
 - Vite+ API mismatch: isolate userscript header plugin to a single small module for easy adjustment.
 - CDN availability: pin versions; allow switching CDNs in metadata.
 - ChatGPT DOM variance: selectors centralized; presence checks before mutating DOM.
