'use strict';

// Pi-hole v6 read-only client.
//
// Answers the question the map otherwise cannot: what is this device *doing*.
// Uses the v6 API (app password -> session id), reads the summary, the blocked
// top domains and the query history, and caches the result. It never changes
// anything in Pi-hole.

// Seeded from the environment, but changeable at runtime from the dashboard.
let config = {
  base: (process.env.PIHOLE_URL || '').replace(/\/+$/, ''),
  token: process.env.PIHOLE_TOKEN || ''
};
const CACHE_MS = 60_000;

let cache = { at: 0, value: null };
let session = { id: null, at: 0 };

// Applies new credentials and forgets any cached session or result.
function configure(next = {}) {
  config = {
    base: String(next.base || '').replace(/\/+$/, ''),
    token: String(next.token || '')
  };
  cache = { at: 0, value: null };
  session = { id: null, at: 0 };
}

function currentConfig() {
  return { base: config.base, tokenSet: Boolean(config.token) };
}

// Server-side only: the raw credentials, for reverting a failed change.
function rawConfig() {
  return { base: config.base, token: config.token };
}

function configured() {
  return Boolean(config.base && config.token);
}

async function login() {
  // Sessions are cheap but not free; reuse one for a few minutes.
  if (session.id && Date.now() - session.at < 4 * 60_000) return session.id;
  const response = await fetch(`${config.base}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.token }),
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error(`auth ${response.status}`);
  const body = await response.json();
  const id = body && body.session && body.session.sid;
  if (!id) throw new Error('no session id');
  session = { id, at: Date.now() };
  return id;
}

async function apiGet(path, sid) {
  const response = await fetch(`${config.base}${path}`, {
    headers: { 'X-FTL-SID': sid },
    signal: AbortSignal.timeout(6000)
  });
  if (response.status === 401) {
    session = { id: null, at: 0 };
    throw new Error('session rejected');
  }
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

// Shapes the Pi-hole payload into the few numbers the dashboard shows.
function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function summariseSummary(payload) {
  const summary = (payload && payload.queries) || {};
  const total = Number(summary.total) || 0;
  const blocked = Number(summary.blocked) || 0;
  return {
    queries: total,
    blocked,
    // Always one decimal: Pi-hole returns a raw float (10.549118995666504).
    percentBlocked: round1(Number(summary.percent_blocked) || (total ? (blocked / total) * 100 : 0)),
    uniqueDomains: Number(summary.unique_domains) || 0
  };
}

// Merges the allowed and blocked client lists so each device carries both
// counts. Pi-hole's own loopback entries are dropped: they are not devices.
function mergeClients(allowedPayload, blockedPayload) {
  const skip = new Set(['127.0.0.1', '::1', '::', 'pi.hole']);
  const blockedByIp = new Map(
    ((blockedPayload && blockedPayload.clients) || []).map(c => [c.ip, Number(c.count) || 0])
  );
  const seen = new Map();
  for (const client of (allowedPayload && allowedPayload.clients) || []) {
    if (!client || skip.has(client.ip)) continue;
    seen.set(client.ip, {
      ip: client.ip,
      name: client.name || null,
      queries: Number(client.count) || 0,
      blocked: blockedByIp.get(client.ip) || 0
    });
  }
  // A client can appear as blocked without being in the allowed top list.
  for (const client of (blockedPayload && blockedPayload.clients) || []) {
    if (!client || skip.has(client.ip) || seen.has(client.ip)) continue;
    seen.set(client.ip, {
      ip: client.ip,
      name: client.name || null,
      queries: Number(client.count) || 0,
      blocked: Number(client.count) || 0
    });
  }
  return [...seen.values()].sort((a, b) => b.queries - a.queries).slice(0, 8);
}

function summariseTopDomains(payload) {
  const list = (payload && (payload.domains || payload.top_domains)) || [];
  return list.slice(0, 5).map(entry => ({
    domain: entry.domain || entry.name || 'unknown',
    count: Number(entry.count) || 0
  }));
}

// Pi-hole's own client filters are ignored by the stats endpoints, so the only
// reliable way to answer "what is this device being blocked from" is to read the
// recent query log and count locally.
const BLOCKED_STATUS = new Set([
  'GRAVITY', 'DENIED', 'REGEX', 'EXTERNAL_BLOCKED_IP', 'EXTERNAL_BLOCKED_NULL',
  'EXTERNAL_BLOCKED_NXRA', 'GRAVITY_CNAME', 'REGEX_CNAME', 'DENIED_CNAME'
]);

function countBlockedDomains(queries, ip, limit = 8) {
  const counts = new Map();
  for (const row of queries || []) {
    const clientIp = row && row.client && row.client.ip;
    if (!clientIp || clientIp !== ip) continue;
    if (!BLOCKED_STATUS.has(String(row.status || '').toUpperCase())) continue;
    const domain = row.domain || '(unknown)';
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function clientBlockedDomains(ip) {
  if (!configured() || !ip) return { ok: false, error: 'not configured' };
  try {
    const sid = await login();
    const payload = await apiGet('/api/queries?length=2000', sid);
    const domains = countBlockedDomains(payload && payload.queries, ip);
    return { ok: true, ip, domains, sampled: (payload && payload.queries || []).length };
  } catch (err) {
    return { ok: false, error: err.message || 'unreachable' };
  }
}

async function fetchPihole() {
  if (!configured()) return { configured: false };
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  try {
    const sid = await login();
    const [summaryRaw, blockedRaw, clientsRaw, blockedClientsRaw] = await Promise.all([
      apiGet('/api/stats/summary', sid),
      apiGet('/api/stats/top_domains?blocked=true&count=5', sid).catch(() => null),
      apiGet('/api/stats/top_clients?count=10', sid).catch(() => null),
      apiGet('/api/stats/top_clients?count=10&blocked=true', sid).catch(() => null)
    ]);
    const value = {
      configured: true,
      ok: true,
      summary: summariseSummary(summaryRaw),
      topBlocked: summariseTopDomains(blockedRaw),
      clients: mergeClients(clientsRaw, blockedClientsRaw),
      checkedAt: new Date().toISOString()
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const value = { configured: true, ok: false, error: err.message || 'unreachable' };
    // Don't cache failures for long: Pi-hole restarts are common.
    cache = { at: Date.now() - CACHE_MS + 15_000, value };
    return value;
  }
}

// Synchronous view of the last result, for the /api/state payload.
function lastValue() {
  if (cache.value) return cache.value;
  return { configured: configured(), ok: false, pending: true };
}

function isStale() {
  return !cache.value || Date.now() - cache.at >= CACHE_MS;
}

module.exports = {
  fetchPihole, lastValue, isStale, configured, configure, currentConfig, rawConfig,
  mergeClients, countBlockedDomains, clientBlockedDomains, summariseSummary, summariseTopDomains
};
