import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

test('malformed URLs return 400 without stopping userscript serving', { timeout: 30000 }, async () => {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));
  const child = spawn(process.execPath, ['build/dev-server.mjs', '--build'], {
    cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`server readiness timed out: ${output}`)), 15000);
      const onExit = (code) => finish(new Error(`server exited ${code}: ${output}`));
      const onData = (chunk) => {
        output += chunk;
        if (output.includes(`Dev server running on http://127.0.0.1:${port}`)) finish();
      };
      const finish = (error) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', finish);
        child.stdout.off('data', onData);
        error ? reject(error) : resolve();
      };
      child.on('exit', onExit);
      child.on('error', finish);
      child.stdout.on('data', onData);
    });
    for (const path of ['//[', 'http://[invalid', '//[']) {
      const bad = await request(port, path);
      assert.equal(bad.status, 400);
      assert.equal(bad.body, 'Bad request URL');
      assert.equal(child.exitCode, null);
      const wrapper = await request(port, '/userscripts/example.user.js');
      assert.equal(wrapper.status, 200);
      assert.match(wrapper.body, /==UserScript==/);
      assert.ok(wrapper.body.includes(`http://127.0.0.1:${port}/dist/lib/gmu.js`));
      const bundle = await request(port, '/dist/lib/gmu.js');
      assert.equal(bundle.status, 200);
      assert.match(bundle.body, /var GMU/);
    }
    const absolute = await request(port, `http://127.0.0.1:${port}/userscripts/example.user.js`);
    assert.equal(absolute.status, 200);
    assert.match(absolute.body, /==UserScript==/);
    assert.equal((await request(port, '/userscripts/missing.user.js')).status, 404);
    assert.equal((await request(port, '/dist/missing.js')).status, 404);
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});
