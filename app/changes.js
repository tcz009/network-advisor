'use strict';

// Device change detection: what joined, what left, and what moved.
//
// A map you have to look at is a picture; a map that tells you when something
// new appeared is a monitor. This module is pure so the rules are testable
// without a network.

const MAX_EVENTS = 200;

function identity(device) {
  // MAC is stable across DHCP changes; fall back to the address for devices
  // that only broadcast discovery saw.
  return (device && (device.mac || device.ip)) || null;
}

function snapshot(devices) {
  const map = new Map();
  for (const device of devices || []) {
    const key = identity(device);
    if (!key) continue;
    map.set(key, {
      ip: device.ip,
      mac: device.mac || null,
      label: device.label || null,
      hostname: device.hostname || null,
      kind: device.kind || null
    });
  }
  return map;
}

function describe(device) {
  if (!device) return 'unknown device';
  const name = device.hostname || device.label || null;
  return name ? `${name} (${device.ip})` : device.ip;
}

// Returns events newest-last. `at` is passed in so tests are deterministic.
function computeChanges(previous, current, at = new Date().toISOString()) {
  const events = [];
  const before = previous instanceof Map ? previous : snapshot(previous);
  const after = current instanceof Map ? current : snapshot(current);
  const beforeByIp = new Map([...before.values()].filter(d => d.ip).map(d => [d.ip, d]));
  const reusedIps = new Set();

  for (const [key, device] of after) {
    const old = before.get(key);
    if (old) {
      if (old.ip && device.ip && old.ip !== device.ip) {
        events.push({ at, type: 'ip-changed', key, ip: device.ip, mac: device.mac, detail: `${describe(device)} moved from ${old.ip} to ${device.ip}` });
      }
      continue;
    }
    // The same address now belongs to a different MAC: DHCP reuse, not a new
    // device, so report it as one event rather than a departure and arrival.
    const previousAtIp = beforeByIp.get(device.ip);
    if (previousAtIp && previousAtIp.mac && device.mac && previousAtIp.mac !== device.mac) {
      reusedIps.add(device.ip);
      events.push({ at, type: 'mac-changed', key, ip: device.ip, mac: device.mac, detail: `${device.ip} is now a different device (${previousAtIp.mac} → ${device.mac})` });
      continue;
    }
    events.push({ at, type: 'joined', key, ip: device.ip, mac: device.mac, detail: `${describe(device)} joined the network` });
  }

  for (const [key, device] of before) {
    if (after.has(key) || reusedIps.has(device.ip)) continue;
    events.push({ at, type: 'left', key, ip: device.ip, mac: device.mac, detail: `${describe(device)} is no longer visible` });
  }

  return events;
}

function appendEvents(existing, events, limit = MAX_EVENTS) {
  const combined = [...(existing || []), ...(events || [])];
  return combined.slice(-limit);
}

module.exports = { snapshot, computeChanges, appendEvents, describe, MAX_EVENTS };
