'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const kasa = require('../kasa.js');

test('payloads round-trip through the autokey cipher', () => {
  const plain = JSON.stringify({ system: { get_sysinfo: {} } });
  const encrypted = kasa.encryptPayload(plain);
  assert.equal(encrypted.length % 16, 0);
  assert.equal(kasa.decryptPayload(encrypted), plain);
});

test('framing prefixes the body length', () => {
  const body = Buffer.alloc(32, 7);
  const framed = kasa.frame(body);
  assert.equal(framed.readUInt32BE(0), 32);
  assert.equal(framed.length, 36);
});

function withServer(handler) {
  return new Promise(resolve => {
    const server = net.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('a real Kasa reply is confirmed and gives model and alias', async () => {
  const reply = kasa.frame(kasa.encryptPayload(JSON.stringify({
    system: { get_sysinfo: { model: 'HS100(UK)', alias: 'Desk Lamp' } }
  })));
  const server = await withServer(socket => {
    socket.once('data', () => socket.write(reply));
  });
  try {
    const result = await kasa.probeKasa('127.0.0.1', { port: server.address().port, timeout: 1500 });
    assert.equal(result.portOpen, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.model, 'HS100(UK)');
    assert.equal(result.alias, 'Desk Lamp');
  } finally {
    server.close();
  }
});

test('something listening on 9999 without the protocol is reported, not confirmed', async () => {
  // Accepts the connection and says nothing: a port scan would call this a plug.
  const server = await withServer(() => {});
  try {
    const result = await kasa.probeKasa('127.0.0.1', { port: server.address().port, timeout: 400 });
    assert.equal(result.portOpen, true);
    assert.equal(result.confirmed, false);
    assert.ok(result.error);
  } finally {
    server.close();
  }
});

test('a host that never answers still resolves within the deadline', async () => {
  // The regression: a pending connect never fired socket timeout, so one dead
  // address hung the whole sweep until the HTTP request timed out.
  const started = Date.now();
  const result = await kasa.probeKasa('192.0.2.1', { timeout: 300 });   // TEST-NET-1
  const elapsed = Date.now() - started;
  assert.equal(result.portOpen, false);
  assert.equal(result.confirmed, false);
  assert.ok(elapsed < 2000, `probe took ${elapsed}ms`);
});

test('a closed port is not reported at all', async () => {
  const result = await kasa.probeKasa('127.0.0.1', { port: 1, timeout: 300 });
  assert.equal(result.portOpen, false);
  assert.equal(result.confirmed, false);
});

test('discoverKasa returns the confirmed host and skips a silent one', async () => {
  const reply = kasa.frame(kasa.encryptPayload(JSON.stringify({
    system: { get_sysinfo: { model: 'KP115(UK)', alias: '' } }
  })));
  const server = await withServer(socket => {
    socket.once('data', () => socket.write(reply));
  });
  const port = server.address().port;
  try {
    const found = await kasa.discoverKasa(['127.0.0.1', '127.0.0.2'], { concurrency: 2, timeout: 600, port });
    assert.equal(found.length, 1);
    assert.equal(found[0].ip, '127.0.0.1');
    assert.equal(found[0].confirmed, true);
    assert.equal(found[0].label, 'KP115(UK)');
  } finally {
    server.close();
  }
});
