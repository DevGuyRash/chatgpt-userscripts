import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'userscript-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['build', 'src']) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(source, 'node_modules')), path.join(root, 'node_modules'), 'junction');
  return root;
}
function request(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}
async function start(root) {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['build/dev-server.mjs', '--build'], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`readiness timeout: ${logs}`)), 10000);
    const exited = code => finish(new Error(`exit ${code}: ${logs}`));
    const data = chunk => { logs += chunk; if (logs.includes('Dev server running')) finish(); };
    function finish(error) {
      clearTimeout(timer); child.off('exit', exited); child.off('error', finish); child.stdout.off('data', data);
      if (error) { child.kill(); reject(error); } else resolve();
    }
    child.on('exit', exited); child.on('error', finish); child.stdout.on('data', data);
  });
  return { child, port, logs: () => logs };
}

test('request-local metadata failures recover without restart or partial wrappers', { timeout: 30000 }, async t => {
  const root = fixture(t);
  const metadata = path.join(root, 'src/scripts/example/meta.base.json');
  const original = fs.readFileSync(metadata);
  const server = await start(root);
  try {
    for (const broken of ['{', null, '{}', 'null',
      ...['match', 'include', 'exclude', 'grant'].map(field => JSON.stringify({ id: 'example', [field]: 'not-an-array' })),
      JSON.stringify({ id: 'example', grant: { length: 1 } })]) {
      if (broken === null) fs.unlinkSync(metadata); else fs.writeFileSync(metadata, broken);
      const result = await request(server.port, '/userscripts/example.user.js');
      assert.equal(result.status, 503);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.match(result.body, /Fix meta.base.json/);
      assert.doesNotMatch(result.body, /==UserScript==/);
      assert.equal(server.child.exitCode, null);
      assert.equal((await request(server.port, '/dist/lib/gmu.js')).status, 200);
      fs.writeFileSync(metadata, original);
      const recovered = await request(server.port, '/userscripts/example.user.js');
      assert.equal(recovered.status, 200);
      assert.match(recovered.body, /==UserScript==/);
      assert.equal((await request(server.port, '/userscripts/missing.user.js')).status, 404);
    }
    assert.match(server.logs(), /meta.base.json/);
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      const exit = once(server.child, 'exit'); server.child.kill(); await exit;
    }
  }
});

test('invalid startup metadata still fails instead of listening', { timeout: 15000 }, async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'src/scripts/example/meta.base.json'), '{');
  const child = spawn(process.execPath, ['build/dev-server.mjs', '--build'], {
    cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 10000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(signal, null);
  assert.notEqual(code, 0);
  assert.match(output, /Cannot read userscript metadata/);
  assert.doesNotMatch(output, /Dev server running/);
});
