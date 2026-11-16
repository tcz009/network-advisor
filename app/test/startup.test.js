'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// These tests start the real entrypoint, so the deployed startup path is covered:
// loadState, PORT/BIND_HOST, the listen callback and the ROLE=agent refusal.
// The unit tests require() the module and never exercise any of that.

const APP_DIR = path.join(__dirname, '..');
const NODE = process.execPath;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'na-startup-'));
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    DATA_DIR: tempDir(),
    CHECK_TARGET: '127.0.0.1',
    CHECK_HOSTNAME: 'localhost',
    ...extra
  };
}

test('the hub entrypoint starts, serves, and shuts down cleanly', async () => {
  const port = 20000 + Math.floor(Math.random() * 2000);
  const child = spawn(NODE, ['server.js'], {
    cwd: APP_DIR,
    env: baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1' })
  });

  const started = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`hub did not start: ${output}`)), 15000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('listening')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`hub exited early (${code}): ${output}`)); });
  });

  await started;
  const response = await fetch(`http://127.0.0.1:${port}/api/pulse`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.ok(Number((await response.json()).at) > 0);

  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.on('exit', c => resolve(c)));
  assert.equal(code, 0, 'SIGTERM should be a clean shutdown');
});

test('agent mode refuses to start without a hub to report to', async () => {
  const child = spawn(NODE, ['server.js'], {
    cwd: APP_DIR,
    env: baseEnv({ ROLE: 'agent', ADVISOR_HUB: '' })
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const code = await new Promise(resolve => child.on('exit', c => resolve(c)));
  assert.equal(code, 1);
  assert.match(stderr, /ADVISOR_HUB/);
});

test('a corrupt state file does not stop the hub from starting', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'nodes.json'), '{"broken": ');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ bad: null }));

  const port = 20000 + Math.floor(Math.random() * 2000);
  const child = spawn(NODE, ['server.js'], {
    cwd: APP_DIR,
    env: baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1', DATA_DIR: dir })
  });

  const started = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`hub did not start on corrupt state: ${output}`)), 15000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('listening')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`hub exited (${code}): ${output}`)); });
  });

  await started;
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  child.kill('SIGTERM');
  await new Promise(resolve => child.on('exit', resolve));
});
