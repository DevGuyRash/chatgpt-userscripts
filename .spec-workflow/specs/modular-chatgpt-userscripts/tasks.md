# Tasks Document

- [ ] 1. Initialize repo scaffolding and configs
  - File: package.json; tsconfig.json; entries.json; dirs: entries/, shared/, scripts/
  - Create base package/TS configs and folder structure
  - Prepare Vite+ config skeleton (no externals bundling)
  - Purpose: Establish scaffolding and scripts for builds
  - _Leverage: .spec-workflow/specs/modular-chatgpt-userscripts/requirements.md, .spec-workflow/specs/modular-chatgpt-userscripts/design.md_
  - _Requirements: Outputs, Scripts, Constraints_
  - _Prompt: Using the spec workflow droid, Role: Build-tooling engineer | Task: Add package and TS configs, create base folders, prepare a Vite+ skeleton without bundling externals | Restrictions: Do not import external libs; do not bundle mermaid/jsdiff/highlight | Success: typecheck and lint scripts run successfully_

- [ ] 2. Implement Vite+ multi-entry build with userscript header plugin
  - File: vite.config.ts; scripts/vite-userscript-header.ts (reads entries.json)
  - Read entries.json to define inputs and externals
  - Inject userscript headers and emit dist/<entry>.user.js
  - Purpose: Provide build system per entry
  - _Leverage: entries.json, .spec-workflow/specs/modular-chatgpt-userscripts/design.md (Build System)_
  - _Requirements: Build, Outputs_
  - _Prompt: Using the spec workflow droid, Role: Vite+ plugin engineer | Task: Implement Vite+ config and userscript header plugin to produce .user.js and honor @require externals | Restrictions: No runtime feature code | Success: npm run build emits at least one placeholder .user.js_

- [ ] 3. Add CLI scaffold script
  - File: scripts/scaffold.ts (or .mjs)
  - Create entries/<name>/index.ts and metadata.ts
  - Register new entry in entries.json
  - Purpose: Enable future scripts to auto-build
  - _Leverage: .spec-workflow/specs/modular-chatgpt-userscripts/design.md (CLI Scaffolding)_
  - _Requirements: Outputs, Scripts (scaffold)_
  - _Prompt: Using the spec workflow droid, Role: DX tooling engineer | Task: Build a minimal CLI to scaffold a new entry and update entries.json | Restrictions: No deps beyond Node stdlib | Success: npm run scaffold:new -- demo creates and registers demo_

- [ ] 4. Port shared utilities from existing scripts
  - File: shared/* (new modules)
  - Extract DOM, theme, time, storage, observers, UI, and code helpers
  - Preserve behavior; refactor only
  - Purpose: Remove duplication across entries
  - _Leverage: codeblock-tools.js, mermaid-renderer.js_
  - _Requirements: DRY, SOLID, KISS_
  - _Prompt: Using the spec workflow droid, Role: Library engineer | Task: Create shared modules matching existing behavior | Restrictions: No behavior changes; minimal comments | Success: Utilities compile and are imported by entries_

- [ ] 5. Migrate Codeblock Tools entry
  - File: entries/codeblock-tools/index.ts; entries/codeblock-tools/metadata.ts (after task 4)
  - Port collapse/wrap/search/diff/± toggles, streaming stabilization, settings UI, line numbers, HLJS integration, language exclusion
  - Keep jsdiff and highlight.js via @require
  - Purpose: Provide TS entry with feature parity
  - _Leverage: shared/*, codeblock-tools.js_
  - _Requirements: Feature parity, Performance, Compatibility_
  - _Prompt: Using the spec workflow droid, Role: Feature porting engineer | Task: Port codeblock tools with parity and externals via @require | Restrictions: No regressions; do not bundle externals | Success: Built .user.js matches behavior on ChatGPT_

- [ ] 6. Migrate Mermaid Renderer entry
  - File: entries/mermaid-renderer/index.ts; entries/mermaid-renderer/metadata.ts (after task 4)
  - Preserve lazy render, caching, error capture (line/column), zoom/pan/lightbox, tabs, settings popover, fixed/elastic sizing, theme-change rerender
  - Keep mermaid via @require
  - Purpose: Provide TS entry with feature parity
  - _Leverage: shared/*, mermaid-renderer.js_
  - _Requirements: Feature parity, Performance, Compatibility_
  - _Prompt: Using the spec workflow droid, Role: Feature porting engineer | Task: Port mermaid renderer with parity and externals via @require | Restrictions: Do not bundle mermaid | Success: Built .user.js matches behavior on ChatGPT_

- [ ] 7. Add zip artifacts script
  - File: scripts/zip-dist.ts (or .mjs)
  - Package all .user.js into dist/artifacts.zip
  - Purpose: Simplify distribution
  - _Leverage: .spec-workflow/specs/modular-chatgpt-userscripts/design.md (Scripts)_
  - _Requirements: Outputs (zip optional)_
  - _Prompt: Using the spec workflow droid, Role: Release engineer | Task: Zip all outputs into dist/artifacts.zip | Restrictions: Local-only; no network | Success: Zip contains all .user.js files_

- [ ] 8. Quality gates and final verification
  - File: — (final integration)
  - Run typecheck/lint; verify both userscripts on target sites; test scaffolded new entry
  - Purpose: Meet acceptance criteria
  - _Leverage: .spec-workflow/specs/modular-chatgpt-userscripts/requirements.md, .spec-workflow/specs/modular-chatgpt-userscripts/design.md, built artifacts_
  - _Requirements: Acceptance Criteria_
  - _Prompt: Using the spec workflow droid, Role: Maintainer | Task: Validate quality gates and behavior end-to-end | Restrictions: No extraneous changes or docs | Success: All gates pass; artifacts ready_
