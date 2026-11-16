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
function summariseSummary(payload) {
  const summary = (payload && payload.queries) || {};
  const total = Number(summary.total) || 0;
  const blocked = Number(summary.blocked) || 0;
  return {
    queries: total,
    blocked,
    percentBlocked: Number(summary.percent_blocked) || (total ? Math.round((blocked / total) * 1000) / 10 : 0),
    uniqueDomains: Number(summary.unique_domains) || 0
  };
}

function summariseTopDomains(payload) {
  const list = (payload && (payload.domains || payload.top_domains)) || [];
  return list.slice(0, 5).map(entry => ({
    domain: entry.domain || entry.name || 'unknown',
    count: Number(entry.count) || 0
  }));
}

async function fetchPihole() {
  if (!configured()) return { configured: false };
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  try {
    const sid = await login();
    const [summaryRaw, blockedRaw] = await Promise.all([
      apiGet('/api/stats/summary', sid),
      apiGet('/api/stats/top_domains?blocked=true&count=5', sid).catch(() => null)
    ]);
    const value = {
      configured: true,
      ok: true,
      summary: summariseSummary(summaryRaw),
      topBlocked: summariseTopDomains(blockedRaw),
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

module.exports = { fetchPihole, lastValue, isStale, configured, configure, currentConfig, rawConfig, summariseSummary, summariseTopDomains };
