// Simple dev server: builds shared lib + each script, serves dist and on-demand .user.js wrappers.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SCRIPTS_DIR = path.join(SRC, 'scripts');
const DIST = path.join(ROOT, 'dist');
const DIST_LIB = path.join(DIST, 'lib');
const DIST_SCRIPTS = path.join(DIST, 'scripts');

const PORT = parseInt(process.env.PORT || '5173', 10);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listScriptDirs() {
  ensureDir(SCRIPTS_DIR);
  return fs
    .readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function discoverScripts() {
  return listScriptDirs().map((dir) => {
    const metaPath = path.join(SCRIPTS_DIR, dir, 'meta.base.json');
    const entry = path.join(SCRIPTS_DIR, dir, 'main.ts');
    const meta = readJson(metaPath);
    if (!meta.id) throw new Error(`meta.base.json in ${dir} must include an "id"`);
    return { id: meta.id, dir, meta, entry };
  });
}

function devVersion(base) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  return `${base || '0.0.0'}-dev.${stamp}`;
}

function userJsWrapperText(script, port) {
  const meta = script.meta || {};
  const lines = [];
  lines.push('// ==UserScript==');
  lines.push(`// @name         ${meta.name || script.id}`);
  lines.push(`// @namespace    ${meta.namespace || 'local-dev'}`);
  lines.push(`// @version      ${devVersion(meta.version)}`);
  lines.push(`// @description  ${meta.description || ''}`);
  (meta.match || []).forEach((m) => lines.push(`// @match        ${m}`));
  (meta.include || []).forEach((m) => lines.push(`// @include      ${m}`));
  (meta.exclude || []).forEach((m) => lines.push(`// @exclude      ${m}`));
  if (meta.noframes) lines.push(`// @noframes`);

  const base = `http://127.0.0.1:${port}`;
  lines.push(`// @updateURL    ${base}/userscripts/${script.id}.user.js`);
  lines.push(`// @downloadURL  ${base}/userscripts/${script.id}.user.js`);
  lines.push(`// @require      ${base}/dist/lib/gmu.js`);
  lines.push(`// @require      ${base}/dist/scripts/${script.id}.js`);

  const grants = (meta.grant && meta.grant.length)
    ? meta.grant
    : ['GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest'];
  grants.forEach((g) => lines.push(`// @grant        ${g}`));
  lines.push('// ==/UserScript==');

  lines.push('(function(){ /* wrapper only; logic lives in required files */ })();');
  return lines.join('\n');
}

async function buildAll({ watch } = { watch: true }) {
  ensureDir(DIST_LIB);
  ensureDir(DIST_SCRIPTS);

  const libCtx = await esbuild.context({
    entryPoints: [path.join(SRC, 'lib', 'index.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GMU',
    sourcemap: true,
    outfile: path.join(DIST_LIB, 'gmu.js'),
    logLevel: 'info',
  });

  const scriptDefs = discoverScripts();
  const scriptContexts = [];
  for (const s of scriptDefs) {
    const ctx = await esbuild.context({
      entryPoints: [s.entry],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      sourcemap: true,
      outfile: path.join(DIST_SCRIPTS, `${s.id}.js`),
      logLevel: 'info',
    });
    scriptContexts.push({ id: s.id, ctx });
  }

  if (watch) {
    await libCtx.watch();
    for (const sc of scriptContexts) await sc.ctx.watch();
  } else {
    await libCtx.rebuild();
    await libCtx.dispose();
    for (const sc of scriptContexts) {
      await sc.ctx.rebuild();
      await sc.ctx.dispose();
    }
  }

  return { libCtx, scriptContexts };
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    // Serve dist
    if (pathname.startsWith('/dist/')) {
      const filePath = path.join(ROOT, pathname);
      if (!filePath.startsWith(DIST)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        const ctype =
          ext === '.js' ? 'application/javascript; charset=utf-8'
          : ext === '.map' ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': ctype, 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
      return;
    }

    // On-demand wrapper
    if (pathname.startsWith('/userscripts/') && pathname.endsWith('.user.js')) {
      const id = path.basename(pathname).replace(/\.user\.js$/, '');
      const scripts = discoverScripts();
      const target = scripts.find((s) => s.id === id);
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Userscript not found');
        return;
      }
      const content = userJsWrapperText(target, PORT);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(content);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('chatgpt-userscripts dev server. Try /userscripts/example.user.js or /dist/lib/gmu.js');
  });

  server.listen(PORT, () => {
    console.log(`Dev server running on http://127.0.0.1:${PORT}`);
  });
}

const once = process.argv.includes('--build');
await buildAll({ watch: !once });
serve();
