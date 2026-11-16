'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Point storage at a scratch directory before the module reads its config.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'na-test-'));

const advisor = require('../server.js');
const { VENDORS } = require('../oui.js');
const { describeMac, vendorFor, isLocallyAdministered, normaliseMac } = require('../oui.js');

/* ------------------------------------------------------------------- parsing */

test('parsePing reads the average and loss from a healthy run', () => {
  const out = 'PING 192.168.1.1 (192.168.1.1): 56 data bytes\n'
    + '64 bytes from 192.168.1.1: icmp_seq=0 ttl=64 time=0.4 ms\n'
    + '--- 192.168.1.1 ping statistics ---\n'
    + '3 packets transmitted, 3 packets received, 0.0% packet loss\n'
    + 'round-trip min/avg/max = 0.3/0.4/0.5 ms\n';
  const result = advisor.parsePing(out);
  assert.equal(result.avgMs, 0.4);
  assert.equal(result.lossPct, 0);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test('parsePing reports total loss without inventing a latency', () => {
  const out = '--- 1.1.1.1 ping statistics ---\n3 packets transmitted, 0 packets received, 100.0% packet loss\n';
  const result = advisor.parsePing(out);
  assert.equal(result.avgMs, null);
  assert.equal(result.lossPct, 100);
  assert.equal(result.ok, false);
  assert.equal(result.reachable, false);
});

test('parsePing keeps the average but flags partial loss', () => {
  const out = '3 packets transmitted, 2 packets received, 33.3% packet loss\n'
    + 'round-trip min/avg/max = 1.0/2.5/4.0 ms\n';
  const result = advisor.parsePing(out);
  assert.equal(result.avgMs, 2.5);
  assert.equal(result.lossPct, 33.3);
  assert.equal(result.ok, false);
  assert.equal(result.reachable, true);
  assert.match(result.error, /lost/);
});

test('parsePing tolerates empty or garbage input', () => {
  assert.equal(advisor.parsePing('').avgMs, null);
  assert.equal(advisor.parsePing(undefined).avgMs, null);
});

/* ------------------------------------------------------------------ gateway */

test('parseGatewayRoutes decodes the little-endian hex gateway', () => {
  // 192.168.1.1 little-endian is 0101A8C0.
  const table = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eno1\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
  const result = advisor.parseGatewayRoutes(table);
  assert.equal(result.address, '192.168.1.1');
  assert.equal(result.iface, 'eno1');
});

test('parseGatewayRoutes prefers the default route with the lowest metric', () => {
  const table = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'tun0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n'
    + 'eno1\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
  assert.equal(advisor.parseGatewayRoutes(table).iface, 'eno1');
});

test('parseGatewayRoutes ignores non-default routes and down links', () => {
  const nonDefault = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eno1\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n';
  assert.equal(advisor.parseGatewayRoutes(nonDefault), null);

  const linkDown = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eno1\t00000000\t0101A8C0\t0002\t0\t0\t100\t00000000\t0\t0\t0\n';
  assert.equal(advisor.parseGatewayRoutes(linkDown), null);
});

test('chooseGateway keeps a VPN peer from masquerading as the LAN router', () => {
  const routes = advisor.parseGatewayRouteList(
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'tun0\t00000000\t55080A0A\t0003\t0\t0\t50\t00000000\t0\t0\t0\n'
    + 'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n'
  );
  assert.equal(routes.length, 2);
  assert.equal(routes[0].iface, 'tun0'); // lowest metric wins on paper
  const chosen = advisor.chooseGateway(routes);
  assert.equal(chosen.address, '192.168.1.1');
  assert.equal(chosen.iface, 'eth0');
  assert.equal(chosen.isTunnel, false);
  assert.equal(chosen.vpn.iface, 'tun0');
  assert.equal(chosen.vpn.address, '10.10.8.85');
});

test('chooseGateway falls back to the tunnel when it is the only default', () => {
  const routes = advisor.parseGatewayRouteList(
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'tun0\t00000000\t55080A0A\t0003\t0\t0\t50\t00000000\t0\t0\t0\n'
  );
  const chosen = advisor.chooseGateway(routes);
  assert.equal(chosen.address, '10.10.8.85');
  assert.equal(chosen.iface, 'tun0');
  assert.equal(chosen.isTunnel, true);
  // No LAN route to compare against, so the tunnel is not also reported as "vpn".
  assert.equal(chosen.vpn, null);
  assert.equal(advisor.chooseGateway([]), null);
});

test('isTunnelInterface recognises VPN links but not LAN ones', () => {
  for (const name of ['tun0', 'wg0', 'ppp0', 'tap1', 'nordlynx']) {
    assert.equal(advisor.isTunnelInterface(name), true, `${name} is a tunnel`);
  }
  for (const name of ['eth0', 'eno1', 'wlan0', 'br0']) {
    assert.equal(advisor.isTunnelInterface(name), false, `${name} is not a tunnel`);
  }
});

test('parseGatewayRoutes still returns the single lowest-metric default', () => {
  const table = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eth0\t00000000\t0101A8C0\t0003\t0\t0\t300\t00000000\t0\t0\t0\n'
    + 'eth1\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
  assert.equal(advisor.parseGatewayRoutes(table).iface, 'eth1');
});

test('parseGatewayRoutes returns null on a missing table', () => {
  assert.equal(advisor.parseGatewayRoutes(''), null);
  assert.equal(advisor.parseGatewayRoutes(null), null);
});

/* --------------------------------------------------------------- neighbours */

const ARP_HEADER = 'IP address       HW type     Flags       HW address            Mask     Device\n';

test('parseArpTable drops incomplete and zero-hardware rows', () => {
  const table = ARP_HEADER
    + '192.168.1.110    0x1         0x2         dc:a6:32:74:7c:19     *        eno1\n'
    + '192.168.1.120    0x1         0x0         dc:a6:32:74:7c:20     *        eno1\n'
    + '192.168.1.130    0x1         0x2         00:00:00:00:00:00     *        eno1\n';
  const rows = advisor.parseArpTable(table);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ip, '192.168.1.110');
});

test('neighbourDevices hides container interfaces and keeps the LAN', () => {
  const table = ARP_HEADER
    + '172.17.0.2       0x1         0x2         02:42:ac:11:00:02     *        docker0\n'
    + '172.18.0.5       0x1         0x2         02:42:ac:12:00:05     *        br-54c288c0f16f\n'
    + '192.168.1.110    0x1         0x2         dc:a6:32:74:7c:19     *        eno1\n'
    + '192.168.1.2      0x1         0x2         b8:27:eb:11:22:33     *        eno1\n'
    + '192.168.1.97     0x1         0x2         d0:73:d5:2c:2d:95     *        eno1\n';
  const devices = advisor.neighbourDevices(table, 'eno1');
  assert.deepEqual(devices.map(d => d.ip), ['192.168.1.2', '192.168.1.97', '192.168.1.110']);
  assert.equal(devices[0].label, 'Raspberry Pi');
  assert.equal(devices[1].label, 'LIFX');
});

test('neighbourDevices falls back to every row when nothing looks like a LAN', () => {
  const table = ARP_HEADER
    + '172.17.0.2       0x1         0x2         02:42:ac:11:00:02     *        docker0\n';
  const devices = advisor.neighbourDevices(table, null);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].ip, '172.17.0.2');
});

test('neighbourDevices de-duplicates repeated addresses', () => {
  const table = ARP_HEADER
    + '192.168.1.110    0x1         0x2         dc:a6:32:74:7c:19     *        eno1\n'
    + '192.168.1.110    0x1         0x2         dc:a6:32:74:7c:19     *        eno1\n';
  assert.equal(advisor.neighbourDevices(table, 'eno1').length, 1);
});

test('isContainerInterface separates bridges from real NICs', () => {
  for (const name of ['docker0', 'br-54c288c0f16f', 'veth1a2b3c', 'virbr0', 'tailscale0', 'tun0']) {
    assert.equal(advisor.isContainerInterface(name), true, `${name} should be treated as a container link`);
  }
  for (const name of ['eno1', 'eth0', 'wlan0', 'br0', 'enp3s0']) {
    assert.equal(advisor.isContainerInterface(name), false, `${name} should be treated as a LAN link`);
  }
  assert.equal(advisor.isContainerInterface(''), true);
});

/* --------------------------------------------------------------- MAC labels */

test('vendorFor maps known prefixes and normalises punctuation', () => {
  assert.equal(vendorFor('DC-A6-32-74-7C-19'), 'Raspberry Pi');
  assert.equal(vendorFor('dca632747c19'), 'Raspberry Pi');
  assert.equal(vendorFor('02:42:ac:11:00:02'), 'Docker bridge');
  assert.equal(vendorFor('de:ad:be:ef:00:01'), null);
});

test('locally administered addresses are reported as randomised', () => {
  assert.equal(isLocallyAdministered('de:ad:be:ef:00:01'), true);
  assert.equal(isLocallyAdministered('dc:a6:32:74:7c:19'), false);
  assert.equal(describeMac('de:ad:be:ef:00:01'), 'Randomised MAC');
  assert.equal(describeMac('dc:a6:32:74:7c:19'), 'Raspberry Pi');
  assert.equal(describeMac('not-a-mac'), null);
});

test('every vendor prefix in the table is a valid OU prefix', () => {
  for (const prefix of Object.keys(VENDORS)) {
    assert.match(prefix, /^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/, `${prefix} is not a well formed OUI`);
  }
  assert.equal(normaliseMac('DC:A6:32:74:7C:19'), 'DC:A6:32:74:7C:19');
});

/* --------------------------------------------------------------------- load */

test('summariseLoad marks a busy NAS so latency is not misread', () => {
  const busy = advisor.summariseLoad('11.52 10.63 10.40 4/900/12345', 4);
  assert.equal(busy.load1, 11.52);
  assert.equal(busy.cores, 4);
  assert.equal(busy.busy, true);

  const calm = advisor.summariseLoad('0.40 0.30 0.20 1/300/999', 4);
  assert.equal(calm.busy, false);
});

test('summariseLoad survives empty input', () => {
  assert.equal(advisor.summariseLoad('', 4), null);
  assert.equal(advisor.summariseLoad('garbage', 4), null);
});

/* -------------------------------------------------------------------- paths */

test('decodePathname refuses hostile percent encoding instead of throwing', () => {
  assert.equal(advisor.decodePathname('/%zz').ok, false);
  assert.equal(advisor.decodePathname('/%E0%A4%A').ok, false);
  const ok = advisor.decodePathname('/%41');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '/A');
});

test('resolvePublicFile blocks traversal in every direction', () => {
  const root = path.resolve(__dirname, '../public');
  assert.equal(advisor.resolvePublicFile('/'), path.join(root, 'index.html'));
  assert.equal(advisor.resolvePublicFile('/app.js'), path.join(root, 'app.js'));
  assert.equal(advisor.resolvePublicFile('/../server.js'), null);
  assert.equal(advisor.resolvePublicFile('/../../etc/passwd'), null);
  // The route decodes first, then resolves; the pair is what blocks traversal.
  const decoded = advisor.decodePathname('/..%2fserver.js');
  assert.equal(decoded.ok, true);
  assert.equal(advisor.resolvePublicFile(decoded.value), null);
});

test('cleanText strips markup and control characters', () => {
  assert.equal(advisor.cleanText('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(advisor.cleanText('a\u0000b\u001fc'), 'abc');
  assert.equal(advisor.cleanText('x'.repeat(80), 10).length, 10);
  assert.equal(advisor.cleanText(undefined), '');
});

test('parseCidr accepts sane home subnets and refuses dangerous ones', () => {
  const slash24 = advisor.parseCidr('192.168.1.0/24');
  assert.equal(slash24.hosts.length, 254);
  assert.equal(slash24.hosts[0], '192.168.1.1');
  assert.equal(slash24.hosts.at(-1), '192.168.1.254');

  assert.equal(advisor.parseCidr('192.168.0.0/22').hosts.length, 1022);
  assert.equal(advisor.parseCidr('10.0.0.0/16'), null); // too wide to be a typo-proof sweep
  assert.equal(advisor.parseCidr('192.168.1.0/31'), null);
  assert.equal(advisor.parseCidr('not-a-subnet'), null);
  assert.equal(advisor.parseCidr(''), null);
});

/* ------------------------------------------------------------- HTTP surface */

test('HTTP endpoints behave under attack and normal use', async t => {
  const { server } = advisor;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('serves the dashboard with a strict content policy', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await response.text(), /Network Advisor/);
  });

  await t.test('a malformed path is refused and the server keeps serving', async () => {
    const bad = await fetch(`${base}/%zz`);
    assert.equal(bad.status, 400);
    // The regression that mattered: this used to kill the process.
    const after = await fetch(`${base}/api/pulse`);
    assert.equal(after.status, 200);
    assert.equal(server.listening, true);
  });

  await t.test('encoded traversal cannot escape the public directory', async () => {
    const response = await fetch(`${base}/%2e%2e%2fserver.js`);
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /createServer/);
  });

  await t.test('oversized JSON gets 413 rather than a growing buffer', async () => {
    const payload = JSON.stringify({ id: 'x', name: 'y'.repeat(20_000) });
    const response = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    });
    assert.equal(response.status, 413);
  });

  await t.test('registers a device and rejects a bad id', async () => {
    const ok = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'test-device-1', name: 'Test phone', connection: 'Wi-Fi', deviceType: 'iPhone', browserRttMs: 4 })
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.node.name, 'Test phone');
    assert.equal(body.node.connection, 'Wi-Fi');

    const bad = await fetch(`${base}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bad id with spaces' })
    });
    assert.equal(bad.status, 400);
  });

  await t.test('deleting a device needs the intent header', async () => {
    const blocked = await fetch(`${base}/api/nodes/test-device-1`, { method: 'DELETE' });
    assert.equal(blocked.status, 403);

    const allowed = await fetch(`${base}/api/nodes/test-device-1`, {
      method: 'DELETE',
      headers: { 'x-advisor-intent': 'delete' }
    });
    assert.equal(allowed.status, 200);
  });

  await t.test('history endpoint answers with an array', async () => {
    const response = await fetch(`${base}/api/history`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).records));
  });
});
