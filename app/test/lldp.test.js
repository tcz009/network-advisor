'use strict';

const test = require('node:test');
const assert = require('node:assert');

const lldp = require('../lldp.js');

function tlv(type, body) {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(((type & 0x7f) << 9) | (body.length & 0x1ff), 0);
  return Buffer.concat([header, body]);
}

function lldpPayload() {
  const chassis = Buffer.concat([Buffer.from([4]), Buffer.from('80:69:1a:ae:fa:d7'.split(':').map(h => parseInt(h, 16)))]);
  const port = Buffer.concat([Buffer.from([5]), Buffer.from('eth0')]);
  const ttl = Buffer.from([0, 120]);
  const portDesc = Buffer.from('eth0');
  const sysName = Buffer.from('TestRouter');
  const caps = Buffer.from([0x00, 0x9c, 0x00, 0x1c]);
  const mgmt = Buffer.from([5, 1, 192, 168, 1, 1, 1, 0, 0, 0, 0, 0]);
  const vlan = Buffer.concat([
    Buffer.from([0x00, 0x80, 0xc2, 3, 0x00, 0x04]), Buffer.from('eth0.4')
  ]);
  const phy = Buffer.from([0x00, 0x12, 0x0f, 1, 0x03, 0xec, 0xc1, 0x00, 0x1e]);

  return Buffer.concat([
    tlv(1, chassis), tlv(2, port), tlv(3, ttl), tlv(4, portDesc), tlv(5, sysName),
    tlv(7, caps), tlv(8, mgmt), tlv(127, vlan), tlv(127, phy), tlv(0, Buffer.alloc(0))
  ]);
}

function ethernetFrame(payload) {
  const dst = Buffer.from([0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e]);
  const src = Buffer.from([0x80, 0x69, 0x1a, 0xae, 0xfa, 0xd7]);
  const ethertype = Buffer.from([0x88, 0xcc]);
  return Buffer.concat([dst, src, ethertype, payload]);
}

function pcap(frames) {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0xa1b2c3d4, 0);      // magic, big endian
  header.writeUInt16BE(2, 4);
  header.writeUInt16BE(4, 6);
  header.writeUInt32BE(65535, 16);
  header.writeUInt32BE(1, 20);              // ethernet
  const records = frames.map(frame => {
    const meta = Buffer.alloc(16);
    meta.writeUInt32BE(0, 0);
    meta.writeUInt32BE(0, 4);
    meta.writeUInt32BE(frame.length, 8);
    meta.writeUInt32BE(frame.length, 12);
    return Buffer.concat([meta, frame]);
  });
  return Buffer.concat([header, ...records]);
}

test('an LLDP frame is decoded into upstream equipment', () => {
  const [neighbour] = lldp.parseLldpCapture(pcap([ethernetFrame(lldpPayload())]));
  assert.equal(neighbour.chassisId, '80:69:1a:ae:fa:d7');
  assert.equal(neighbour.portId, 'eth0');
  assert.equal(neighbour.systemName, 'TestRouter');
  assert.equal(neighbour.managementAddress, '192.168.1.1');
  assert.equal(neighbour.vlan, 'eth0.4 (id 4)');
  assert.equal(neighbour.speed, '1 Gb/s');
  assert.deepEqual(neighbour.capabilities, ['bridge', 'WLAN AP', 'router']);
  assert.equal(neighbour.ttlSeconds, 120);
});

test('a capture with no LLDP frames yields nothing', () => {
  const other = Buffer.concat([
    Buffer.from([0x01, 0x80, 0xc2, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]),
    Buffer.from([0x88, 0xcc]),
    Buffer.alloc(0)
  ]);
  assert.deepEqual(lldp.parseLldpCapture(pcap([other])), []);
});

test('a truncated or foreign file is rejected rather than thrown', () => {
  assert.deepEqual(lldp.parseLldpCapture(Buffer.alloc(0)), []);
  assert.deepEqual(lldp.parseLldpCapture(Buffer.from('not a pcap at all')), []);
});

test('VLAN-tagged ethernet is unwrapped', () => {
  const tagged = Buffer.concat([
    Buffer.from([0x01, 0x80, 0xc2, 0x00, 0x00, 0x0e]),
    Buffer.from([0x80, 0x69, 0x1a, 0xae, 0xfa, 0xd7]),
    Buffer.from([0x81, 0x00, 0x00, 0x04]),   // VLAN tag, id 4
    Buffer.from([0x88, 0xcc]),
    lldpPayload()
  ]);
  const frames = lldp.pcapFrames(pcap([tagged]));
  assert.equal(frames.length, 1);
  const parsed = lldp.ethernetPayload(frames[0]);
  assert.ok(parsed, 'VLAN-tagged LLDP should still be recognised');
});
