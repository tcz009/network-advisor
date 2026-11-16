'use strict';

const test = require('node:test');
const assert = require('node:assert');

const discovery = require('../discovery.js');
const { classifyDevice } = require('../kinds.js');

const SSDP_REPLY =
  'HTTP/1.1 200 OK\r\n' +
  'CACHE-CONTROL: max-age=1800\r\n' +
  'LOCATION: http://192.168.1.80:1400/xml/device_description.xml\r\n' +
  'SERVER: Linux UPnP/1.0 Sonos/70.2-40160\r\n' +
  'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n' +
  'USN: uuid:RINCON_000E58A1B2C3::urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n';

test('an SSDP reply is parsed into headers', () => {
  const headers = discovery.parseSsdpHeaders(SSDP_REPLY);
  assert.match(headers.server, /Sonos/);
  assert.equal(headers.st, 'urn:schemas-upnp-org:device:ZonePlayer:1');
  assert.match(headers.location, /device_description\.xml$/);
});

function dnsName(name) {
  return discovery.encodeDnsName(name);
}

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function record(name, type, rdata) {
  return Buffer.concat([dnsName(name), u16(type), u16(1), u32(120), u16(rdata.length), rdata]);
}

function mdnsResponse(records) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}

test('an mDNS response yields service and address records', () => {
  const packet = mdnsResponse([
    record('_http._tcp.local', 12, dnsName('SonosZP._http._tcp.local')),
    record('SonosZP._http._tcp.local', 1, Buffer.from([192, 168, 1, 80]))
  ]);
  const records = discovery.parseMdnsResponse(packet);
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 12);
  assert.equal(records[0].value, 'SonosZP._http._tcp.local');
  assert.equal(records[1].type, 1);
  assert.equal(records[1].value, '192.168.1.80');
});

test('a compressed name is followed correctly', () => {
  // Build a packet where the second name is a pointer back to the first.
  const firstName = dnsName('_ipp._tcp.local');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);

  const first = Buffer.concat([
    firstName,
    u16(12), u16(1), u32(120),
    u16(2),                                        // rdata is just the pointer
    Buffer.from([0xc0, 0x0c])                      // pointer to offset 12
  ]);

  const records = discovery.parseMdnsResponse(Buffer.concat([header, first]));
  assert.equal(records[0].value, '_ipp._tcp.local');
});

test('garbage does not throw', () => {
  assert.equal(discovery.parseMdnsResponse(Buffer.alloc(0)), null);
  assert.doesNotThrow(() => discovery.parseMdnsResponse(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])));
});

test('a query packet encodes the names it asks for', () => {
  const packet = discovery.buildMdnsQuery(['_http._tcp.local']);
  assert.ok(packet.length > 12);
  assert.equal(packet.readUInt16BE(4), 1);   // one question
  const { name } = discovery.readDnsName(packet, 12);
  assert.equal(name, '_http._tcp.local');
});

test('broadcast hints classify devices that ping would miss', () => {
  assert.equal(classifyDevice({ upnpServer: 'Linux UPnP/1.0 Sonos/70.2' }).kind, 'speaker');
  assert.equal(classifyDevice({ services: ['googlecast'] }).kind, 'media player');
  assert.equal(classifyDevice({ services: ['ipp'] }).kind, 'printer');
  assert.equal(classifyDevice({ services: ['airplay'] }).kind, 'speaker');
  assert.equal(classifyDevice({ services: ['unknown-service'] }), null);
});
