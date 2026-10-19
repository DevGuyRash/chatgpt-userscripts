# Modular ChatGPT Userscripts

This repo hosts modular userscripts for ChatGPT and related sites.

- Multiple small userscripts instead of one monolith.
- Shared library bundled to a single global `GMU` via esbuild.
- Each `.user.js` file is just metadata + `@require` for shared lib and its own script bundle.

## Scripts layout

```text
src/
  lib/        # shared modules -> dist/lib/gmu.js (IIFE global: GMU)
  scripts/    # one folder per userscript
    example/
      meta.base.json
      main.ts
```

## Commands

```bash
npm run dev   # build + serve, local update URLs for Tampermonkey/Violentmonkey
npm run build # one-shot build to dist/ + release/
```

Point Tampermonkey/Violentmonkey at `http://127.0.0.1:5173/userscripts/<id>.user.js` during development.
