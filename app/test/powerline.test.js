'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parsePlctool } = require('../powerline.js');

const SAMPLE = `eno1 00:B0:52:00:00:01 Fetch Network Information
eno1 DC:EF:09:66:94:40 Found 1 Network(s)

source address = DC:EF:09:66:94:40

\tnetwork->NID = A4:3C:BC:9A:18:14:0C
\tnetwork->SNID = 12
\tnetwork->TEI = 3
\tnetwork->ROLE = 0x02 (CCO)
\tnetwork->CCO_DA = DC:EF:09:66:94:40
\tnetwork->CCO_TEI = 3
\tnetwork->STATIONS = 1

\t\tstation->MAC = DC:EF:09:66:8F:A5
\t\tstation->TEI = 1
\t\tstation->BDA = 80:69:1A:AE:FA:D7
\t\tstation->AvgPHYDR_TX = 253 mbps Alternate
\t\tstation->AvgPHYDR_RX = 177 mbps Alternate
`;

test('a plctool listing yields the adapters and the link rate', () => {
  const result = parsePlctool(SAMPLE);
  assert.equal(result.ok, true);
  assert.equal(result.networks.length, 1);
  assert.equal(result.networks[0].nid, 'A4:3C:BC:9A:18:14:0C');
  assert.equal(result.networks[0].snid, 12);
  assert.equal(result.networks[0].role, 'CCO');
  assert.equal(result.adapters.length, 2, 'local adapter plus one station');

  const local = result.adapters.find(a => a.local);
  assert.equal(local.mac, 'DC:EF:09:66:94:40');

  const peer = result.adapters.find(a => !a.local);
  assert.equal(peer.mac, 'DC:EF:09:66:8F:A5');
  assert.equal(peer.bda, '80:69:1A:AE:FA:D7');
  assert.equal(peer.txMbps, 253);
  assert.equal(peer.rxMbps, 177);

  assert.equal(result.bestTxMbps, 253);
  assert.equal(result.bestRxMbps, 177);
});

test('no powerline network reports ok:false rather than throwing', () => {
  const result = parsePlctool('plctool: no local device found\n');
  assert.equal(result.ok, false);
  assert.deepEqual(result.adapters, []);
  assert.equal(result.bestTxMbps, null);
});

test('empty output is handled', () => {
  const result = parsePlctool('');
  assert.equal(result.ok, false);
  assert.deepEqual(result.networks, []);
});
