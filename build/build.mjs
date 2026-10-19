// One-shot build that writes versioned .user.js wrappers to release/ and bundles to dist/
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
const RELEASE = path.join(ROOT, 'release');

fs.mkdirSync(DIST_LIB, { recursive: true });
fs.mkdirSync(DIST_SCRIPTS, { recursive: true });
fs.mkdirSync(RELEASE, { recursive: true });

const listScripts = () =>
  fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const nowVersion = () => new Date().toISOString().replace(/[:.]/g, '');

function wrapper(meta) {
  const id = meta.id;
  const version = meta.version ? `${meta.version}.${nowVersion()}` : nowVersion();
  const lines = [];
  lines.push('// ==UserScript==');
  lines.push(`// @name         ${meta.name || id}`);
  lines.push(`// @namespace    ${meta.namespace || 'build'}`);
  lines.push(`// @version      ${version}`);
  lines.push(`// @description  ${meta.description || ''}`);
  (meta.match || []).forEach((m) => lines.push(`// @match        ${m}`));
  (meta.include || []).forEach((m) => lines.push(`// @include      ${m}`));
  (meta.exclude || []).forEach((m) => lines.push(`// @exclude      ${m}`));
  if (meta.noframes) lines.push('// @noframes');
  if (meta.homepageURL) lines.push(`// @homepageURL  ${meta.homepageURL}`);
  if (meta.supportURL) lines.push(`// @supportURL   ${meta.supportURL}`);
  if (meta.updateURL) lines.push(`// @updateURL    ${meta.updateURL}`);
  if (meta.downloadURL) lines.push(`// @downloadURL  ${meta.downloadURL}`);

  // Keep things modular in production too: point @require to where you will host dist files.
  const base = meta.productionBase || 'https://example.invalid/chatgpt-userscripts';
  lines.push(`// @require      ${base}/dist/lib/gmu.js`);
  lines.push(`// @require      ${base}/dist/scripts/${id}.js`);

  const grants = (meta.grant && meta.grant.length)
    ? meta.grant
    : ['GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest'];
  grants.forEach((g) => lines.push(`// @grant        ${g}`));
  lines.push('// ==/UserScript==');
  lines.push('(function(){})()');
  return lines.join('\n');
}

async function main() {
  // Build lib
  await esbuild.build({
    entryPoints: [path.join(SRC, 'lib', 'index.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GMU',
    sourcemap: false,
    outfile: path.join(DIST_LIB, 'gmu.js'),
    logLevel: 'info',
  });

  // Build each script
  for (const dir of listScripts()) {
    const meta = readJson(path.join(SCRIPTS_DIR, dir, 'meta.base.json'));
    const entry = path.join(SCRIPTS_DIR, dir, 'main.ts');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      sourcemap: false,
      outfile: path.join(DIST_SCRIPTS, `${meta.id}.js`),
      logLevel: 'info',
    });
    const wrapperText = wrapper(meta);
    fs.writeFileSync(path.join(RELEASE, `${meta.id}.user.js`), wrapperText, 'utf8');
  }
  console.log('Build complete. See dist/ and release/');
}

main().catch((e) => { console.error(e); process.exit(1); });
