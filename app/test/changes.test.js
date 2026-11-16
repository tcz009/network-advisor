'use strict';

const test = require('node:test');
const assert = require('node:assert');

const changes = require('../changes.js');
const pihole = require('../pihole.js');

test('a new device produces a joined event', () => {
  const before = changes.snapshot([{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' }]);
  const after = changes.snapshot([
    { ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' },
    { ip: '192.168.1.11', mac: 'bb:bb:bb:bb:bb:bb', hostname: 'new-thing' }
  ]);
  const events = changes.computeChanges(before, after, 'T0');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'joined');
  assert.match(events[0].detail, /new-thing/);
});

test('a device that disappears produces a left event', () => {
  const before = changes.snapshot([{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa', hostname: 'gone' }]);
  const after = changes.snapshot([]);
  const events = changes.computeChanges(before, after, 'T0');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'left');
  assert.match(events[0].detail, /no longer visible/);
});

test('a device that changes address is reported once, as ip-changed', () => {
  const before = changes.snapshot([{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' }]);
  const after = changes.snapshot([{ ip: '192.168.1.99', mac: 'aa:aa:aa:aa:aa:aa' }]);
  const events = changes.computeChanges(before, after, 'T0');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ip-changed');
  assert.match(events[0].detail, /192\.168\.1\.10 to 192\.168\.1\.99/);
});

test('an address reused by a different device is a mac-changed event', () => {
  const before = changes.snapshot([{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' }]);
  const after = changes.snapshot([{ ip: '192.168.1.10', mac: 'cc:cc:cc:cc:cc:cc' }]);
  const events = changes.computeChanges(before, after, 'T0');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'mac-changed');
});

test('nothing changed means no events', () => {
  const devices = [{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' }];
  assert.deepEqual(changes.computeChanges(changes.snapshot(devices), changes.snapshot(devices), 'T0'), []);
});

test('the event log is capped', () => {
  const kept = changes.appendEvents([], Array.from({ length: 300 }, (_, i) => ({ at: String(i) })), 200);
  assert.equal(kept.length, 200);
  assert.equal(kept.at(-1).at, '299');
});

test('Pi-hole payloads are reduced to the numbers the dashboard shows', () => {
  const summary = pihole.summariseSummary({ queries: { total: 1000, blocked: 250, percent_blocked: 25, unique_domains: 80 } });
  assert.deepEqual(summary, { queries: 1000, blocked: 250, percentBlocked: 25, uniqueDomains: 80 });
  // Pi-hole sends a raw float; the dashboard shows one decimal.
  const raw = pihole.summariseSummary({ queries: { total: 117479, blocked: 12393, percent_blocked: 10.549118995666504 } });
  assert.equal(raw.percentBlocked, 10.5);
  const top = pihole.summariseTopDomains({ domains: [{ domain: 'ads.example', count: 12 }, { domain: 'tracker.example', count: 7 }] });
  assert.equal(top[0].domain, 'ads.example');
  assert.equal(top[1].count, 7);
});

test('Pi-hole clients are merged with their blocked counts, loopback dropped', () => {
  const allowed = { clients: [
    { ip: '192.168.1.167', name: 'laptop', count: 500 },
    { ip: '127.0.0.1', name: 'localhost', count: 400 },
    { ip: '192.168.1.14', name: 'phone', count: 300 }
  ] };
  const blocked = { clients: [{ ip: '192.168.1.167', name: 'laptop', count: 120 }] };
  const clients = pihole.mergeClients(allowed, blocked);
  assert.equal(clients.length, 2, 'loopback must be excluded');
  assert.equal(clients[0].ip, '192.168.1.167');
  assert.equal(clients[0].queries, 500);
  assert.equal(clients[0].blocked, 120);
  assert.equal(clients[1].blocked, 0);
});

test('blocked domains are counted per client from the query log', () => {
  const queries = [
    { client: { ip: '192.168.1.167' }, status: 'GRAVITY', domain: 'ads.example' },
    { client: { ip: '192.168.1.167' }, status: 'gravity', domain: 'ads.example' },
    { client: { ip: '192.168.1.167' }, status: 'FORWARDED', domain: 'good.example' },
    { client: { ip: '192.168.1.14' }, status: 'GRAVITY', domain: 'other.example' },
    { client: { ip: '192.168.1.167' }, status: 'DENIED', domain: 'tracker.example' }
  ];
  const domains = pihole.countBlockedDomains(queries, '192.168.1.167');
  assert.equal(domains.length, 2, 'only blocked rows for this client');
  assert.deepEqual(domains[0], { domain: 'ads.example', count: 2 });
  assert.deepEqual(domains[1], { domain: 'tracker.example', count: 1 });
});

test('a malformed Pi-hole payload does not throw', () => {
  assert.deepEqual(pihole.summariseSummary(null), { queries: 0, blocked: 0, percentBlocked: 0, uniqueDomains: 0 });
  assert.deepEqual(pihole.summariseTopDomains({}), []);
});
