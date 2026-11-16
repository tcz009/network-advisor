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

test('unknown devices stay unknown instead of being guessed', () => {
  assert.equal(classifyDevice({ hostname: '192-168-1-54.local' }), null);
  assert.equal(classifyDevice({ hostname: '', label: '', model: '' }), null);
  assert.equal(classifyDevice({}), null);
  // A generic vendor label must not imply a device type.
  assert.equal(classifyDevice({ label: 'TP-Link' }), null);
});
