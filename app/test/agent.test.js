'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'na-agent-test-'));
process.env.AGENT_TOKEN = 'test-token-123';

const advisor = require('../server.js');

const goodReport = {
  name: 'vpngate',
  version: '0.1.0',
  platform: 'Linux arm64',
  gateway: '192.168.1.1',
  iface: 'wlan0',
  router: { ok: true, reachable: true, avgMs: 2.5, lossPct: 0, error: null },
  internet: { ok: true, reachable: true, avgMs: 18, lossPct: 0, error: null },
  dns: { ok: true, address: '104.16.132.229' },
  load: { load1: 0.2, cores: 4 },
  uptimeSec: 3600,
  devices: [
    { ip: '192.168.1.31', mac: 'dc:a6:32:aa:bb:cc', iface: 'wlan0' },
    { ip: '192.168.1.32', mac: 'de:ad:be:ef:00:01', iface: 'wlan0', hostname: 'pixel-9.local' }
  ]
};

/* ------------------------------------------------------------------ token */

test('agent token comparison rejects a missing or wrong secret', () => {
  assert.equal(advisor.agentTokenMatches('test-token-123', 'test-token-123'), true);
  assert.equal(advisor.agentTokenMatches('test-token-124', 'test-token-123'), false);
  assert.equal(advisor.agentTokenMatches('short', 'test-token-123'), false);
  assert.equal(advisor.agentTokenMatches(undefined, 'test-token-123'), false);
  assert.equal(advisor.agentTokenMatches('', ''), false);
});

/* -------------------------------------------------------------- sanitising */

test('sanitiseReport keeps a valid report and labels devices itself', () => {
  const report = advisor.sanitiseReport(goodReport);
  assert.equal(report.name, 'vpngate');
  assert.equal(report.gateway, '192.168.1.1');
  assert.equal(report.devices.length, 2);
  assert.equal(report.devices[0].label, 'Raspberry Pi');
  assert.equal(report.devices[1].label, 'Randomised MAC');
  assert.equal(report.devices[1].hostname, 'pixel-9.local');
  assert.equal(report.load.busy, false);
});

test('sanitiseReport strips a name down to something safe to key on', () => {
  const report = advisor.sanitiseReport({ ...goodReport, name: '<b>pi hq</b> ⚡' });
  assert.match(report.name, /^[A-Za-z0-9_.-]+$/);
  assert.match(report.label, /pi hq/);
});

test('sanitiseReport drops malformed devices instead of trusting them', () => {
  const report = advisor.sanitiseReport({
    ...goodReport,
    devices: [
      { ip: 'not-an-ip', mac: 'dc:a6:32:aa:bb:cc' },
      { ip: '192.168.1.99', mac: 'nonsense' },
      { ip: '192.168.1.77', mac: 'dc:a6:32:aa:bb:cd', iface: 'wlan0' },
      null,
      'string'
    ]
  });
  assert.equal(report.devices.length, 1);
  assert.equal(report.devices[0].ip, '192.168.1.77');
});

test('sanitiseReport refuses a body that is not an object', () => {
  assert.throws(() => advisor.sanitiseReport(null), /Invalid report/);
  assert.throws(() => advisor.sanitiseReport('nope'), /Invalid report/);
});

test('sanitiseReport tolerates missing sections', () => {
  const report = advisor.sanitiseReport({ name: 'bare' });
  assert.equal(report.gateway, null);
  assert.equal(report.router.avgMs, null);
  assert.deepEqual(report.devices, []);
  assert.equal(report.load, null);
});

/* ------------------------------------------------------------------ merging */

test('agents feed a merged device list tagged with who saw them', () => {
  advisor.recordAgent(advisor.sanitiseReport(goodReport));
  advisor.recordAgent(advisor.sanitiseReport({ ...goodReport, name: 'RPiHole' }));
  const merged = advisor.mergedDevices();
  assert.ok(merged.length >= 2);
  const pixel = merged.find(device => device.ip === '192.168.1.32');
  assert.deepEqual(pixel.seenBy.sort(), ['RPiHole', 'vpngate']);
  assert.equal(pixel.hostname, 'pixel-9.local');
});

test('activeAgents hides the raw device list and flags online state', () => {
  advisor.recordAgent(advisor.sanitiseReport(goodReport));
  const agents = advisor.activeAgents();
  const vpngate = agents.find(agent => agent.name === 'vpngate');
  assert.equal(vpngate.online, true);
  assert.equal(vpngate.deviceCount, 2);
  assert.equal(vpngate.devices, undefined);
});

/* -------------------------------------------------------------------- HTTP */

test('agent intake requires the shared token', async t => {
  const { server } = advisor;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const missing = await fetch(`${base}/api/agents/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(goodReport)
  });
  assert.equal(missing.status, 403);

  const wrong = await fetch(`${base}/api/agents/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-advisor-token': 'wrong' },
    body: JSON.stringify(goodReport)
  });
  assert.equal(wrong.status, 403);

  const ok = await fetch(`${base}/api/agents/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-advisor-token': 'test-token-123' },
    body: JSON.stringify({ ...goodReport, name: 'DietPiDL' })
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, name: 'DietPiDL', devices: 2 });

  const list = await (await fetch(`${base}/api/agents`)).json();
  assert.equal(list.intake, true);
  assert.ok(list.agents.some(agent => agent.name === 'DietPiDL'));

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(Array.isArray(state.devices));
  assert.ok(state.devices.some(device => device.ip === '192.168.1.31'));
});

test('agent reports with too many devices are still bounded', async t => {
  const { server } = advisor;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const devices = Array.from({ length: 700 }, (_, i) => ({
    ip: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    mac: `dc:a6:32:00:00:${(i % 256).toString(16).padStart(2, '0')}`
  }));
  const response = await fetch(`${base}/api/agents/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-advisor-token': 'test-token-123' },
    body: JSON.stringify({ ...goodReport, name: 'flood', devices })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.devices, 512);
});
