'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Its own data directory and process, so loadState() cannot disturb other suites.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'na-storage-test-'));
process.env.CHECK_TARGET = '127.0.0.1';
process.env.CHECK_HOSTNAME = 'localhost';
process.env.DATA_DIR = DATA_DIR;

const advisor = require('../server.js');

const NODES = path.join(DATA_DIR, 'nodes.json');
const AGENTS = path.join(DATA_DIR, 'agents.json');
const HISTORY = path.join(DATA_DIR, 'history.json');

test('writeJsonAtomic leaves the previous file as .bak', () => {
  const file = path.join(DATA_DIR, 'probe.json');
  advisor.writeJsonAtomic(file, { generation: 1 });
  advisor.writeJsonAtomic(file, { generation: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { generation: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { generation: 1 });
  // No temporary file is left behind.
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a corrupt state file falls back to its backup', () => {
  const file = path.join(DATA_DIR, 'recover.json');
  advisor.writeJsonAtomic(file, { keep: 'this' });
  advisor.writeJsonAtomic(file, { keep: 'newer' });
  // Simulate a crash that truncated the primary after the backup was written.
  fs.writeFileSync(file, '{ "truncated": ');
  const result = advisor.readJsonFile(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { keep: 'this' });
  assert.match(result.from, /\.bak$/);
});

test('readJsonFile reports a missing file without throwing', () => {
  const result = advisor.readJsonFile(path.join(DATA_DIR, 'absent.json'));
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
});

test('loadState ignores null and malformed entries instead of crashing', () => {
  fs.writeFileSync(NODES, JSON.stringify({ good: { id: 'good', name: 'Phone', lastSeen: Date.now() }, broken: null }));
  fs.writeFileSync(AGENTS, JSON.stringify({ MediaPi: { name: 'MediaPi', lastSeen: Date.now() }, junk: null, stringy: 'nope' }));
  fs.writeFileSync(HISTORY, JSON.stringify([null, 'nope', { at: 'x', routerMs: 1 }]));

  // The regression: a null node entry threw inside loadState and crash-looped the hub.
  assert.doesNotThrow(() => advisor.loadState());

  const agents = advisor.activeAgents();
  assert.ok(agents.some(agent => agent.name === 'MediaPi'));
  assert.ok(!agents.some(agent => agent.name === 'junk'));
});

test('loadState survives a completely unreadable state directory', () => {
  fs.writeFileSync(NODES, 'not json at all');
  assert.doesNotThrow(() => advisor.loadState());
});

test('a saved scan snapshot restores device identity after a restart', () => {
  // Without this, every device type and broadcast identity vanished on restart
  // until someone ran another sweep.
  const snapshot = {
    finishedAt: Date.now(),
    arp: [{
      ip: '192.168.1.109', mac: 'dc:71:44:1c:41:47', label: 'Samsung', hostname: null,
      kind: 'TV', room: null, responded: true, sweepMs: 21.5,
      kasa: null, mdns: null, upnp: { server: 'SHP, UPnP/1.0, Samsung UPnP SDK/1.0', serviceTypes: ['MediaRenderer'] }
    }]
  };
  advisor.writeJsonAtomic(path.join(DATA_DIR, 'lastscan.json'), snapshot);
  advisor.loadState();

  const device = advisor.mergedDevices().find(entry => entry.ip === '192.168.1.109');
  assert.ok(device, 'the saved device should come back');
  assert.equal(device.kind, 'TV');
  assert.equal(device.upnp.server.includes('Samsung'), true);
});

test('trimAgents drops stale sensors and caps the map', () => {
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  const map = {
    fresh: { name: 'fresh', lastSeen: now - 60_000 },
    stale: { name: 'stale', lastSeen: now - 8 * day },
    never: { name: 'never' }
  };
  advisor.trimAgents(map, { now });
  assert.deepEqual(Object.keys(map), ['fresh']);

  const many = {};
  for (let i = 0; i < 5; i++) many[`a${i}`] = { name: `a${i}`, lastSeen: now - i * 1000 };
  advisor.trimAgents(many, { now, max: 2 });
  assert.deepEqual(Object.keys(many).sort(), ['a0', 'a1']);
});
