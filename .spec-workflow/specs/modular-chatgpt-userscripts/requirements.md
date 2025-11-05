 # Modular ChatGPT Userscripts — Requirements
 
 ## Scope
 - Refactor two working userscripts (`codeblock-tools.js`, `mermaid-renderer.js`) into a modular TypeScript repo with shared libraries and multi-entry build.
 - Use Vite+ (new tooling) with TypeScript to build userscript outputs (.user.js) via a multi-entry pipeline and a CLI scaffold for future scripts.
 - Preserve feature parity and UX behavior of both scripts on chat.openai.com and chatgpt.com.
 
 ## Goals (EARS-style requirements)
 - When building the repo, the system shall output a separate `.user.js` for each script entry with correct Tampermonkey/Violentmonkey metadata.
 - When running `dev`/`watch`, the system shall rebuild entries incrementally and serve HMR where feasible for rapid iteration.
 - When adding a new script via CLI, the system shall scaffold a new entry (code, metadata, config) and register it for builds automatically.
 - When importing from shared libs, the system shall tree-shake and avoid duplication across entries.
 - When bundling, the system shall keep output self-contained or use `@require` for large externals per per-entry config (mermaid, highlight.js, jsdiff).
 - When targeting ChatGPT pages, the scripts shall run at `document-idle` (configurable) and respect `@match` for both domains.
 - When migrating to TS, the system shall retain runtime behavior (rendering, event delegation, observers, settings persistence) with no regressions.
 - When building diffs and search (codeblock-tools), the system shall preserve performance guards and streaming-stabilization semantics.
 - When rendering mermaid diagrams, the system shall preserve lazy rendering, caching, error capture, zoom/pan, tab grouping, and lightbox behavior.
 - When sharing utilities (DOM/query, theme detection, debounce, modal/toast, storage, observers), the system shall provide them in `/shared` packages reused by entries.
 - When linting/typechecking, the system shall surface errors on CI and locally (npm scripts) and block release builds on errors.
 - When releasing artifacts, the system shall optionally zip the `dist/` outputs into a single archive for easy import.
 - When bootstrapping the repo, the system shall install dependencies and initialize Vite+ config with a single command (automated installs).
 
 ## Non-Goals
 - No server hosting or auto-install into user script managers.
 - No telemetry or analytics.
 - No redesign of UI/UX beyond modularization and TypeScript migration.
 
 ## Constraints & Quality Attributes
 - Simplicity first (KISS), avoid speculative abstractions (YAGNI), adhere to DRY/SOLID where it reduces duplication and clarifies ownership.
 - Outputs must remain compatible with Tampermonkey and Violentmonkey.
 - Build system must support per-entry metadata and per-entry externals.
 - Prefer small, focused modules; avoid global state leakage.
 - Performance: initial load should not regress vs current JS; diff/search and mermaid renderers must remain responsive on long content.
 
 ## Inputs
 - Existing files: `codeblock-tools.js`, `mermaid-renderer.js`.
 - Target sites: `https://chat.openai.com/*`, `https://chatgpt.com/*`.
 - External libs currently used: `mermaid`, `highlight.js`, `jsdiff`.
 
 ## Outputs
 - Dist: `dist/<entry>.user.js` per configured entry.
 - Optional: `dist/artifacts.zip` containing all built `.user.js` files.
 - Repo scripts: `dev`, `build`, `typecheck`, `lint`, `scaffold:new`.
 - Repo scripts: add `bootstrap` to install deps and initialize Vite+ config.
 
 ## Acceptance Criteria
 - Build produces two working `.user.js` files functionally equivalent to originals.
 - New script scaffolding registers a third entry and builds it without manual wiring.
 - Shared libs eliminate at least 3 duplicated utilities between the two scripts.
 - TypeScript compilation passes with strict-ish settings (no `any` by default except explicit escape hatches).
 - Lint and typecheck pass on CI and locally.
 - Builds use Vite+; `npm run build` emits `.user.js` for each entry via Vite+ multi-entry configuration.
 - A single `npm run bootstrap` (or equivalent) installs dependencies and configures Vite+.
 
 ## Risks / Mitigations
 - Large externals (e.g., mermaid) can bloat bundles: allow per-entry externalization via `@require` and CDN pinning.
 - DOM structure changes on ChatGPT could break selectors: centralize selectors and feature-detect where possible.
 - Tampermonkey/Violentmonkey differences: keep metadata minimal and avoid engine-specific GM_* APIs unless gated.
 
 ## Compliance
 - DRY: shared utilities for DOM, styling, storage, observers.
 - SOLID: entries depend on abstractions (interfaces) for UI helpers and storage; modules have single responsibilities.
 - YAGNI: do not introduce unused frameworks or cross-cutting infra.
 - KISS: straightforward file structure; minimal config.
 
