'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyDevice } = require('../kinds.js');

test('known hostnames classify to a device kind', () => {
  const cases = {
    'blink-sync-module.communityfibre.co.uk': 'camera',
    'Blink-Mini.communityfibre.co.uk': 'camera',
    'SonosZP.communityfibre.co.uk': 'speaker',
    'LIFX-A19-2C2D95.communityfibre.co.uk': 'bulb',
    'HS100.communityfibre.co.uk': 'plug',
    'SHIELD1.communityfibre.co.uk': 'media player',
    'RMMINI-d9-10-7e.communityfibre.co.uk': 'IR blaster',
    'Watch.communityfibre.co.uk': 'watch',
    'MacBookAir.communityfibre.co.uk': 'computer',
    'iPhone.communityfibre.co.uk': 'phone'
  };
  for (const [hostname, expected] of Object.entries(cases)) {
    assert.equal(classifyDevice({ hostname })?.kind, expected, hostname);
  }
});

test('a Kasa model beats a misleading hostname', () => {
  const result = classifyDevice({ hostname: 'spare-device', model: 'KP115(UK)' });
  assert.equal(result.kind, 'plug');
  assert.match(result.evidence, /KP115/);
});

test('Kasa wall switches are told apart from plugs', () => {
  assert.equal(classifyDevice({ model: 'HS200(UK)' }).kind, 'switch');
  assert.equal(classifyDevice({ model: 'HS220(UK)' }).kind, 'switch');
  assert.equal(classifyDevice({ model: 'HS100(UK)' }).kind, 'plug');
  assert.equal(classifyDevice({ model: 'KP115(UK)' }).kind, 'plug');
});

test('rooms apply to a device even with no sweep behind it', () => {
  // The regression: annotations were skipped entirely until a sweep had run, so
  // a freshly started hub showed every device unassigned.
  const devices = [{ ip: '192.168.1.40', mac: 'B0:BE:76:D6:CC:B7', hostname: 'HS100.local' }];
  const [annotated] = advisorForNotes.annotateDevices(devices, {
    roomMap: { 'b0:be:76:d6:cc:b7': 'Loft' },
    kasaMap: new Map([['192.168.1.40', { confirmed: true, model: 'HS100(UK)', alias: 'Loft light' }]]),
    responders: new Map(),
    notes: {},
    sweepAt: 0
  });
  assert.equal(annotated.room, 'Loft');
  assert.equal(annotated.kind, 'plug');
  assert.equal(annotated.responded, undefined);
});

test('unknown devices stay unknown instead of being guessed', () => {
  assert.equal(classifyDevice({ hostname: '192-168-1-54.local' }), null);
  assert.equal(classifyDevice({ hostname: '', label: '', model: '' }), null);
  assert.equal(classifyDevice({}), null);
  // A generic vendor label must not imply a device type.
  assert.equal(classifyDevice({ label: 'TP-Link' }), null);
});

const advisorForNotes = require('../server.js');

test('device notes parse into an address-keyed map', () => {
  const notes = advisorForNotes.parseDeviceNotes(
    '192.168.1.85=Blink hub for 10 cameras; 192.168.1.113=Mini at the front door;'
  );
  assert.equal(notes['192.168.1.85'], 'Blink hub for 10 cameras');
  assert.equal(notes['192.168.1.113'], 'Mini at the front door');
});

test('malformed device notes are ignored, not guessed at', () => {
  const notes = advisorForNotes.parseDeviceNotes('nonsense;192.168.1.9=; =no ip;999.1.1.1=x');
  assert.deepEqual(Object.keys(notes), []);
});
