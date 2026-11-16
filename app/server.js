'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { describeMac } = require('./oui');
const { discoverKasa } = require('./kasa');
const { classifyDevice } = require('./kinds');
const { discoverDevices } = require('./discovery');
const { parseLldpCapture, readCapture } = require('./lldp');

const exec = promisify(execFile);

const PORT = Number(process.env.PORT || 8090);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'nodes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const TARGET = process.env.CHECK_TARGET || '1.1.1.1';
const HOSTNAME = process.env.CHECK_HOSTNAME || 'cloudflare.com';
// Active discovery is opt-in: with SCAN_SUBNET unset the app stays passive and
// only reports what the NAS has recently talked to.
const SCAN_SUBNET = process.env.SCAN_SUBNET || '';
const SCAN_MIN_INTERVAL_MS = 30_000;
// Kasa plugs answer on TCP 9999 even when they ignore ICMP, so a sweep probes it.
// Set KASA_PROBE=false to leave the scan to ICMP only.
const KASA_PROBE = String(process.env.KASA_PROBE || 'true').toLowerCase() !== 'false';
// SSDP/mDNS sweep the whole segment regardless of ping, so they find devices
// that ignore ICMP. DISCOVERY=false leaves the scan to ping and 9999 only.
const DISCOVERY = String(process.env.DISCOVERY || 'true').toLowerCase() !== 'false';
// Set by the sidecar; absence just means no capture has run yet.
const LLDP_PCAP = path.join(DATA_DIR, 'lldp.pcap');
const LLDP_ENABLED = String(process.env.LLDP || 'true').toLowerCase() !== 'false';

// Host header validation exists to defeat DNS rebinding: an attacker page whose
// hostname resolves to this NAS sends its own hostname in Host, which is exactly
// what the Origin check cannot detect. IP literals and localhost are always fine;
// add any DNS names you actually use here.
// Operator notes for things the network cannot know: which hosts a hub serves,
// what a device physically is. Format: ip=note;ip=note
const DEVICE_NOTES = parseDeviceNotes(process.env.DEVICE_NOTES || '');

const ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

// Agent mode turns the same image into a vantage point that pushes its own view
// to a hub. It opens no ports, so it is safe to run beside Pi-hole or a router.
const ROLE = (process.env.ROLE || 'hub').toLowerCase();
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
// AGENT_TOKENS=MediaPi=abc,vpngate=def binds a token to a sensor name, so one
// leaked token cannot rewrite every other sensor's readings.
const AGENT_TOKENS = parseAgentTokens(process.env.AGENT_TOKENS || '');
const ADVISOR_HUB = (process.env.ADVISOR_HUB || '').replace(/\/+$/, '');
const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const AGENT_INTERVAL_MS = Math.max(15_000, Number(process.env.AGENT_INTERVAL_MS) || 30_000);
const AGENT_ONLINE_MS = 90_000;
const AGENT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_AGENTS = 32;
// A sensor that stops reporting keeps its row but stops contributing devices,
// so a decommissioned Pi cannot leave phantom "seen by" tags on the map.
const AGENT_DEVICE_TTL_MS = 10 * 60_000;

const HISTORY_LIMIT = 288;
// Browser nodes are re-created automatically when a device comes back, so old
// ones are safe to drop. Without this the device list grows without bound.
const NODE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_NODES = 200;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const CONTAINER_IFACE = /^(docker0|docker-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|lxcbr|lxdbr|podman|tun\d|tap\d|wg\d|tailscale|zt)/i;
const DOCKER_BRIDGE_IFACE = /^br-[0-9a-f]{12}$/i;
const MAX_ARP_HOSTNAME_LOOKUPS = 16;
const VERSION = require('./package.json').version;

let nodes = Object.create(null);
// mac -> room. Keyed by MAC because DHCP moves addresses around; a device with
// a randomised MAC will need its room setting again after it rotates.
let rooms = Object.create(null);
let agents = Object.create(null);
let history = [];
let lastCheck = null;
let lastScan = null;
let lastScanStartedAt = 0;
let kasaByIp = new Map();
let discoveryByIp = new Map();
let lldpCache = { mtime: 0, value: null };
let sweepResponders = new Map();
let lastSweepAt = 0;
let scanInFlight = null;
let checkInFlight = null;
let saveTimer = null;
const HOST_CACHE = new Map();

/* ------------------------------------------------------------------ helpers */

const ALLOWED_HOST_NAMES = ALLOWED_HOSTS.map(entry => entry.replace(/:\d+$/, '').replace(/\.$/, ''));

function normaliseHostName(hostHeader) {
  let name = String(hostHeader || '').trim().toLowerCase();
  if (!name) return '';
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end === -1) return '';
    name = name.slice(0, end + 1);
  } else {
    name = name.split(':')[0];
  }
  return name.replace(/\.$/, '');   // "nas.local." is the same host as "nas.local"
}

function hostAllowed(hostHeader) {
  const name = normaliseHostName(hostHeader);
  if (!name) return false;
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (/^\[[0-9a-f:.%]+\]$/.test(name)) return true;
  return ALLOWED_HOST_NAMES.includes(name);
}

// Keys are normalised the same way a report's name is, so "Media Pi" in the
// config matches the "Media-Pi" that arrives on the wire.
function sanitiseAgentName(value) {
  return cleanText(value, 40).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseDeviceNotes(raw) {
  const map = Object.create(null);
  for (const part of String(raw || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const split = trimmed.indexOf('=');
    if (split < 2) continue;
    const ip = trimmed.slice(0, split).trim();
    const note = trimmed.slice(split + 1).trim();
    // Deliberately not isIpv4(): this parses at module load, before IPV4 is
    // initialised, so depending on it threw a TDZ error on a configured host.
    const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255);
    if (looksLikeIp && note) map[ip] = note.slice(0, 120);
  }
  return map;
}

function parseAgentTokens(raw) {
  const map = Object.create(null);
  for (const part of String(raw || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    const name = sanitiseAgentName(trimmed.slice(0, split));
    const token = trimmed.slice(split + 1).trim();
    if (name && token) map[name] = token;
  }
  return map;
}

function cleanText(value, max = 50) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

// Decoding a hostile path such as /%zz throws URIError. Left unguarded that
// rejection escaped the request handler and took the whole process down.
function decodePathname(rawPath) {
  try {
    return { ok: true, value: decodeURIComponent(rawPath) };
  } catch {
    return { ok: false, value: null };
  }
}

function resolvePublicFile(requested) {
  const name = requested === '/' ? 'index.html' : String(requested).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, name);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return null;
  return file;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      raw += chunk;
      if (raw.length > limit) {
        // Stop buffering immediately and drain, otherwise a client can keep
        // growing memory after we have already decided to refuse the request.
        settled = true;
        reject(httpError('Request too large', 413));
        req.resume();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(httpError('Invalid JSON', 400)); }
    });
    req.on('error', err => { if (!settled) { settled = true; reject(err); } });
  });
}

function readRaw(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(httpError('Upload limit exceeded', 413));
        req.resume();
      }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(bytes); } });
    req.on('error', err => { if (!settled) { settled = true; reject(err); } });
  });
}

/* --------------------------------------------------------- parsing helpers */

function parsePing(output) {
  const text = String(output || '');
  const loss = text.match(/([\d.]+)% packet loss/);
  const timing = text.match(/(?:round-trip|rtt) min\/avg\/max(?:\/mdev)? = [\d.]+\/([\d.]+)\//);
  const lossPct = loss ? Number(loss[1]) : null;
  const avgMs = timing ? Number(timing[1]) : null;
  return {
    ok: avgMs !== null && lossPct === 0,
    reachable: avgMs !== null,
    avgMs,
    lossPct,
    error: avgMs === null ? 'No ping reply' : (lossPct > 0 ? 'Some ping replies were lost' : null)
  };
}

// /proc/net/route columns:
// Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
// Destination 00000000 is the default route; the gateway is little-endian hex.
function parseGatewayRouteList(table) {
  const rows = String(table || '').trim().split('\n').slice(1);
  const found = [];
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const [iface, destination, gateway, flagsHex, , , metricRaw] = parts;
    if (destination !== '00000000') continue;
    const flags = parseInt(flagsHex, 16);
    if (!Number.isFinite(flags)) continue;
    if (!(flags & 0x1) || !(flags & 0x2)) continue; // RTF_UP | RTF_GATEWAY
    const octets = [0, 2, 4, 6].map(i => parseInt(gateway.slice(i, i + 2), 16));
    if (octets.length !== 4 || octets.some(n => !Number.isFinite(n) || n < 0 || n > 255)) continue;
    const address = octets.reverse().join('.');
    found.push({ address, iface, metric: Number.isFinite(Number(metricRaw)) ? Number(metricRaw) : Number.MAX_SAFE_INTEGER });
  }
  return found.sort((a, b) => a.metric - b.metric);
}

function parseGatewayRoutes(table) {
  return parseGatewayRouteList(table)[0] || null;
}

// Prefer the lowest-metric default that is not a tunnel. The tunnel is only
// reported separately when there is also a LAN default to compare against,
// otherwise the same address would be described twice.
function chooseGateway(routes) {
  if (!routes.length) return null;
  const tunnel = routes.find(route => isTunnelInterface(route.iface)) || null;
  const lan = routes.find(route => !isTunnelInterface(route.iface)) || null;
  const primary = lan || tunnel;
  return {
    address: primary.address,
    iface: primary.iface,
    metric: primary.metric,
    isTunnel: isTunnelInterface(primary.iface),
    vpn: lan && tunnel ? { address: tunnel.address, iface: tunnel.iface } : null
  };
}

function parseArpTable(table) {
  return String(table || '').trim().split('\n').slice(1).map(row => {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const [ip, , flags, mac, , iface] = parts;
    if (!mac || mac === '00:00:00:00:00:00') return null;
    if (parseInt(flags, 16) === 0) return null;
    return { ip, mac, iface };
  }).filter(Boolean);
}

// A host running a VPN often has its default route pointed at the tunnel, so
// "gateway" is then a VPN peer rather than the LAN router. Keep the two apart.
const TUNNEL_IFACE = /^(tun\d|tap\d|wg\d|ppp\d|ipsec\d|sit\d|gre\d|nordlynx|proton)/i;

function isTunnelInterface(name) {
  return TUNNEL_IFACE.test(String(name || ''));
}

function isContainerInterface(name) {
  if (!name) return true;
  return CONTAINER_IFACE.test(name) || DOCKER_BRIDGE_IFACE.test(name);
}

// Docker and Tailscale interfaces show up in the host neighbour table once the
// container shares the host network namespace. Reporting them as devices made
// the map mostly containers, so they are dropped unless nothing else is left.
function neighbourDevices(table, gatewayIface) {
  const rows = parseArpTable(table);
  const onLan = rows.filter(row => !isContainerInterface(row.iface));
  const pool = onLan.length ? onLan : rows;
  const onGatewayIf = gatewayIface ? pool.filter(row => row.iface === gatewayIface) : [];
  const chosen = onGatewayIf.length ? onGatewayIf : pool;
  const seen = new Set();
  const devices = [];
  for (const row of chosen) {
    if (seen.has(row.ip)) continue;
    seen.add(row.ip);
    devices.push({ ...row, label: describeMac(row.mac) });
  }
  return devices.sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
}

function ipToNumber(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function numberToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// A /22 is 1024 addresses; refuse anything wider so a typo cannot turn into a
// huge ICMP blast.
function parseCidr(cidr) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!match) return null;
  const octets = match[1].split('.').map(Number);
  const prefix = Number(match[2]);
  if (octets.some(o => !Number.isFinite(o) || o < 0 || o > 255)) return null;
  if (prefix < 22 || prefix > 30) return null;
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  const total = 2 ** (32 - prefix);
  const hosts = [];
  for (let i = 1; i < total - 1; i++) hosts.push(numberToIp((network + i) >>> 0));
  return { network: numberToIp(network), prefix, hosts };
}

function summariseLoad(loadText, cores) {
  const first = String(loadText || '').trim().split(/\s+/)[0];
  if (!first) return null;
  const load1 = Number(first);
  if (!Number.isFinite(load1) || !cores) return null;
  const ratio = load1 / cores;
  return {
    load1: Math.round(load1 * 100) / 100,
    cores,
    ratio: Math.round(ratio * 100) / 100,
    // Above roughly one runnable task per core, ping timings start reflecting
    // CPU queueing rather than the wire.
    busy: ratio >= 0.9
  };
}

/* ------------------------------------------------------------ host readings */

// Every address this host holds, so a map can tell a sensor's own entries in the
// neighbour table apart from a different device on the same LAN. A Pi behind a
// VPN has several, and its LAN address is the one other hosts will see.
function localAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

function readGateway() {
  try {
    return chooseGateway(parseGatewayRouteList(fs.readFileSync('/proc/net/route', 'utf8')));
  } catch {
    return null;
  }
}

function readArpTable() {
  try {
    return fs.readFileSync('/proc/net/arp', 'utf8');
  } catch {
    return '';
  }
}

function readLoad() {
  try {
    return summariseLoad(fs.readFileSync('/proc/loadavg', 'utf8'), os.cpus().length);
  } catch {
    return null;
  }
}

function ping(host) {
  if (!host) return Promise.resolve({ ok: false, reachable: false, avgMs: null, lossPct: null, error: 'No gateway found' });
  return exec('ping', ['-c', '3', '-W', '2', host], { timeout: 9000 })
    .then(({ stdout }) => parsePing(stdout))
    .catch(err => {
      // A missing or unusable ping binary is not a network fault, and reporting
      // it as one made every host look down.
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        return { ok: false, reachable: false, avgMs: null, lossPct: null, error: `ping unavailable (${err.code})` };
      }
      // An installed ping that cannot open a socket exits 2 with a permission
      // message; reporting that as "no reply" blames the network.
      if (/operation not permitted|permission denied/i.test(String(err.stderr || ''))) {
        return { ok: false, reachable: false, avgMs: null, lossPct: null, error: 'ping unavailable (EPERM)' };
      }
      // ping exits non-zero when any probe is lost, and its stdout can still
      // hold valid replies worth keeping.
      const parsed = parsePing(`${err.stdout || ''} ${err.stderr || ''}`);
      return {
        ...parsed,
        error: parsed.avgMs === null
          ? 'No ping reply'
          : (parsed.lossPct > 0 ? 'Some ping replies were lost' : null)
      };
    });
}

function hostnameFor(ip) {
  const cached = HOST_CACHE.get(ip);
  const now = Date.now();
  if (cached && now - cached.at < 10 * 60_000) return Promise.resolve(cached.name);
  return Promise.race([
    dns.promises.reverse(ip),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 700).unref())
  ]).then(names => {
    const name = names && names.length ? String(names[0]).replace(/\.$/, '') : null;
    HOST_CACHE.set(ip, { name, at: now });
    return name;
  }).catch(() => {
    HOST_CACHE.set(ip, { name: null, at: now });
    return null;
  });
}

async function enrichDevices(devices) {
  const targets = devices.slice(0, MAX_ARP_HOSTNAME_LOOKUPS);
  const names = await Promise.all(targets.map(device => hostnameFor(device.ip)));
  const byIp = new Map(targets.map((device, index) => [device.ip, names[index]]));
  return devices.map(device => ({ ...device, hostname: byIp.get(device.ip) || null }));
}

async function pingSweep(hosts, concurrency = 32) {
  let cursor = 0;
  let fatal = null;
  const responders = new Map();   // ip -> round-trip ms
  const worker = async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++];
      try {
        const { stdout } = await exec('ping', ['-c', '1', '-W', '1', host], { timeout: 1500 });
        const parsed = parsePing(stdout);
        responders.set(host, parsed.avgMs);
      } catch (err) {
        // No reply is the normal case. A missing or unusable binary is not,
        // and used to be reported as "the subnet is empty".
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          fatal = `ping unavailable (${err.code})`;
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return { answered: responders.size, responders, error: fatal };
}

/* ------------------------------------------------------------------ storage */

function writeJsonAtomic(file, value) {
  const payload = JSON.stringify(value, null, 2);
  const tmp = `${file}.tmp`;
  // Write, flush, then rotate. A crash mid-write leaves either the old file or
  // the .tmp, never a truncated original.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.bak`);
  } catch (err) {
    console.error(`Could not rotate ${file}: ${err.message}`);
  }
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return { ok: true, value: JSON.parse(fs.readFileSync(candidate, 'utf8')), from: candidate };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      console.error(`Could not read ${candidate}: ${err.message}`);
    }
  }
  return { ok: false, value: null, from: null };
}

function flushState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(DATA_FILE, nodes);
    writeJsonAtomic(AGENTS_FILE, agents);
  } catch (err) {
    console.error('Could not save state:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushState();
  }, 500);
  saveTimer.unref?.();
}

function saveRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(ROOMS_FILE, rooms);
  } catch (err) {
    console.error('Could not save rooms:', err.message);
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(HISTORY_FILE, history);
  } catch (err) {
    console.error('Could not save history:', err.message);
  }
}

function trimAgents(map, { now = Date.now(), ttlMs = AGENT_TTL_MS, max = MAX_AGENTS } = {}) {
  for (const agent of Object.values(map)) {
    if (!agent.lastSeen || now - agent.lastSeen > ttlMs) delete map[agent.name];
  }
  const entries = Object.values(map);
  if (entries.length > max) {
    entries
      .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0))
      .slice(0, entries.length - max)
      .forEach(agent => { delete map[agent.name]; });
  }
  return map;
}

function loadState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Could not create data directory:', err.message);
  }

  const loadedNodes = readJsonFile(DATA_FILE);
  if (loadedNodes.ok) {
    for (const [key, node] of Object.entries(loadedNodes.value || {})) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      if (typeof node.id !== 'string' || !node.id) node.id = key;
      delete node.userAgent;
      if (typeof node.lastSeen !== 'number') node.lastSeen = 0;
      nodes[node.id] = node;
    }
  } else if (loadedNodes.from === null) {
    console.warn(`${DATA_FILE} missing or unreadable; starting with no devices`);
  }

  const loadedAgents = readJsonFile(AGENTS_FILE);
  if (loadedAgents.ok) {
    for (const [key, agent] of Object.entries(loadedAgents.value || {})) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
      if (typeof agent.name !== 'string' || !agent.name) agent.name = key;
      if (typeof agent.label !== 'string' || !agent.label) agent.label = agent.name;
      if (typeof agent.lastSeen !== 'number') agent.lastSeen = 0;
      agents[agent.name] = agent;
    }
  }

  trimNodes();
  trimAgents(agents);

  const loadedRooms = readJsonFile(ROOMS_FILE);
  if (loadedRooms.ok) {
    for (const [mac, room] of Object.entries(loadedRooms.value || {})) {
      if (typeof room !== 'string' || !room) continue;
      rooms[mac.toLowerCase()] = room.slice(0, 40);
    }
  }

  const loadedHistory = readJsonFile(HISTORY_FILE);
  if (loadedHistory.ok && Array.isArray(loadedHistory.value)) {
    history = loadedHistory.value
      .filter(record => record && typeof record === 'object' && !Array.isArray(record))
      .slice(-HISTORY_LIMIT);
  }
}

function pruneNodes(map, { now = Date.now(), ttlMs = NODE_TTL_MS, max = MAX_NODES } = {}) {
  const cutoff = now - ttlMs;
  for (const node of Object.values(map)) {
    if (!node.lastSeen || node.lastSeen < cutoff) delete map[node.id];
  }
  const entries = Object.values(map);
  if (entries.length > max) {
    entries
      .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0))
      .slice(0, entries.length - max)
      .forEach(node => { delete map[node.id]; });
  }
  return map;
}

function trimNodes() {
  pruneNodes(nodes);
}

/* ------------------------------------------------------------------- checks */

// One reading of this host: used both by a hub check and by an agent report so
// the two never drift apart.
// Parsed from the sidecar's pcap, cached by file mtime.
function lldpNeighbours() {
  if (!LLDP_ENABLED) return { enabled: false, neighbours: [] };
  const capture = readCapture(LLDP_PCAP);
  if (!capture.ok) return { enabled: true, neighbours: [], error: capture.error };
  if (lldpCache.mtime === capture.mtime && lldpCache.value) return lldpCache.value;
  const value = {
    enabled: true,
    neighbours: parseLldpCapture(capture.buffer),
    capturedAt: new Date(capture.mtime).toISOString()
  };
  lldpCache = { mtime: capture.mtime, value };
  return value;
}

function hubHost() {
  if (!ADVISOR_HUB) return null;
  try {
    return new URL(ADVISOR_HUB).hostname || null;
  } catch {
    return null;
  }
}

async function collectReadings() {
  const gateway = readGateway();
  const target = hubHost();
  const [router, internet, dnsResult, hubPing] = await Promise.all([
    ping(gateway?.address), ping(TARGET),
    dns.promises.lookup(HOSTNAME)
      .then(result => ({ ok: true, address: result.address }))
      .catch(() => ({ ok: false, address: null })),
    target ? ping(target) : Promise.resolve(null)
  ]);
  const devices = await enrichDevices(neighbourDevices(readArpTable(), gateway?.iface));
  return {
    addresses: localAddresses(),
    gateway: gateway?.address || null,
    iface: gateway?.iface || null,
    tunnel: Boolean(gateway?.isTunnel),
    vpn: gateway?.vpn || null,
    router,
    internet,
    dns: dnsResult,
    hub: hubPing ? { host: target, ...hubPing } : null,
    load: readLoad(),
    devices
  };
}

function runCheck() {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const started = Date.now();
    const readings = await collectReadings();
    lastCheck = {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      gateway: readings.gateway,
      iface: readings.iface,
      tunnel: readings.tunnel,
      vpn: readings.vpn,
      router: readings.router,
      target: TARGET,
      internet: readings.internet,
      hostname: HOSTNAME,
      dns: readings.dns,
      load: readings.load,
      arp: readings.devices,
      source: 'Checks run from the NAS over its Ethernet connection.'
    };
    history.push({
      at: lastCheck.checkedAt,
      routerMs: readings.router.avgMs,
      routerLoss: readings.router.lossPct,
      internetMs: readings.internet.avgMs,
      internetLoss: readings.internet.lossPct,
      dnsOk: Boolean(readings.dns.ok),
      load1: readings.load?.load1 ?? null,
      devices: readings.devices.length
    });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    saveHistory();
    return lastCheck;
  })();
  return checkInFlight.finally(() => { checkInFlight = null; });
}

async function runScan() {
  const parsed = parseCidr(SCAN_SUBNET);
  if (!parsed) {
    return { enabled: false, error: SCAN_SUBNET ? 'SCAN_SUBNET must be a CIDR between /22 and /30' : 'Active discovery is off' };
  }
  // Concurrent callers used to start one sweep each: the cooldown only consulted
  // a timestamp written after the sweep finished. One sweep at a time now.
  if (scanInFlight) return scanInFlight;
  if (lastScan && Date.now() - lastScanStartedAt < SCAN_MIN_INTERVAL_MS) {
    return { ...lastScan, cached: true };
  }
  const started = Date.now();
  lastScanStartedAt = started;
  scanInFlight = (async () => {
    const sweep = await pingSweep(parsed.hosts);
    const gateway = readGateway();
    const devices = await enrichDevices(neighbourDevices(readArpTable(), gateway?.iface));

    // Broadcast discovery: devices that never answer ping still announce
    // themselves over SSDP or mDNS, and some of them are not in ARP at all.
    let discovered = [];
    if (DISCOVERY) {
      try {
        const result = await discoverDevices({ timeout: 2000 });
        discovered = result.hosts;
        discoveryByIp = result.byIp;
        for (const entry of discovered) {
          if (!devices.some(device => device.ip === entry.ip)) {
            devices.push({
              ip: entry.ip,
              mac: null,
              iface: null,
              label: null,
              hostname: entry.mdns ? entry.mdns.name : null,
              discovered: true
            });
          }
        }
      } catch (err) {
        console.error('Discovery failed:', err.message);
      }
    }

    // Probe the Kasa port on anything that answered, plus anything the neighbour
    // table knows about but cannot name — that is where plugs hide.
    let kasa = [];
    if (KASA_PROBE) {
      const named = new Set(devices.filter(device => device.label || device.hostname).map(device => device.ip));
      const targets = [...new Set([
        ...sweep.responders.keys(),
        ...devices.filter(device => !named.has(device.ip)).map(device => device.ip)
      ])].slice(0, 512);
      kasa = await discoverKasa(targets);
      for (const entry of kasa) kasaByIp.set(entry.ip, entry);
    }

    sweepResponders = sweep.responders;
    lastSweepAt = Date.now();
    lastScanStartedAt = Date.now();   // the pause counts from the end of a sweep
    lastScan = {
      enabled: true,
      error: sweep.error,
      subnet: `${parsed.network}/${parsed.prefix}`,
      probed: parsed.hosts.length,
      answered: sweep.answered,
      devices: devices.length,
      kasa,
      discovered: discovered.length,
      arp: devices.map(device => ({
        ...device,
        responded: sweep.responders.has(device.ip),
        sweepMs: sweep.responders.get(device.ip) ?? null,
        kind: classifyDevice({ hostname: device.hostname, label: device.label })?.kind || null,
        note: DEVICE_NOTES[device.ip] || null,
        room: rooms[String(device.mac || '').toLowerCase()] || null,
        kasa: kasaByIp.get(device.ip) || null
      })),
      tookMs: Date.now() - started,
      finishedAt: Date.now()
    };
    return lastScan;
  })();
  return scanInFlight.finally(() => { scanInFlight = null; });
}

/* ------------------------------------------------------------------- agents */

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function isIpv4(value) {
  return IPV4.test(String(value || '')) && String(value).split('.').every(part => Number(part) <= 255);
}

// Constant-time comparison so a token cannot be discovered by timing responses.
function agentTokenMatches(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanPingValue(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, reachable: false, avgMs: null, lossPct: null, error: 'Not measured' };
  }
  const numeric = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) / 1000 : null);
  const avgMs = numeric(value.avgMs);
  return {
    ok: Boolean(value.ok),
    reachable: typeof value.reachable === 'boolean' ? value.reachable : avgMs !== null,
    avgMs,
    lossPct: numeric(value.lossPct),
    error: value.error ? cleanText(value.error, 60) : null
  };
}

function cleanDeviceList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 512).map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const ip = String(entry.ip || '').trim();
    if (!isIpv4(ip)) return null;
    const mac = String(entry.mac || '').toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
    return {
      ip,
      mac,
      iface: cleanText(entry.iface, 20) || null,
      // Trust our own table over whatever the agent labelled it.
      label: describeMac(mac) || (entry.label ? cleanText(entry.label, 40) : null),
      hostname: entry.hostname ? cleanText(entry.hostname, 80) : null
    };
  }).filter(Boolean);
}

function sanitiseReport(body) {
  if (!body || typeof body !== 'object') throw new Error('Invalid report');
  const rawName = cleanText(body.name, 40) || 'agent';
  const load = body.load && typeof body.load === 'object'
    ? summariseLoad(String(body.load.load1 ?? ''), Number(body.load.cores) || os.cpus().length)
    : null;
  return {
    name: rawName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent',
    label: rawName,
    version: cleanText(body.version, 20) || null,
    platform: cleanText(body.platform, 40) || null,
    addresses: Array.isArray(body.addresses) ? body.addresses.filter(isIpv4).slice(0, 8) : [],
    gateway: isIpv4(body.gateway) ? body.gateway : null,
    iface: cleanText(body.iface, 20) || null,
    tunnel: Boolean(body.tunnel),
    vpn: body.vpn && isIpv4(body.vpn.address)
      ? { address: body.vpn.address, iface: cleanText(body.vpn.iface, 20) || null }
      : null,
    hub: body.hub && typeof body.hub === 'object'
      ? { host: cleanText(body.hub.host, 60) || null, ...cleanPingValue(body.hub) }
      : null,
    router: cleanPingValue(body.router),
    internet: cleanPingValue(body.internet),
    dns: { ok: Boolean(body.dns && body.dns.ok), address: isIpv4(body.dns?.address) ? body.dns.address : null },
    load,
    devices: cleanDeviceList(body.devices),
    uptimeSec: typeof body.uptimeSec === 'number' && body.uptimeSec >= 0 ? Math.round(body.uptimeSec) : null
  };
}

function recordAgent(report) {
  const previous = agents[report.name] || {};
  agents[report.name] = {
    ...report,
    firstSeen: previous.firstSeen || new Date().toISOString(),
    lastSeen: Date.now()
  };
  trimAgents(agents);
  scheduleSave();
  return agents[report.name];
}

function activeAgents() {
  const now = Date.now();
  return Object.values(agents)
    .map(agent => ({
      ...agent,
      deviceCount: (agent.devices || []).length,
      devices: undefined,
      online: now - agent.lastSeen < AGENT_ONLINE_MS
    }))
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
}

// Every vantage point sees a different slice of the LAN. Merging by address
// shows one device with all the places that saw it, instead of duplicates.
function mergeDevices(nasDevices, agentMap, { now = Date.now(), ttlMs = AGENT_DEVICE_TTL_MS } = {}) {
  const byIp = new Map();
  const add = (device, source) => {
    if (!device || !device.ip) return;
    const existing = byIp.get(device.ip);
    if (!existing) {
      byIp.set(device.ip, { ...device, seenBy: [source] });
      return;
    }
    if (!existing.seenBy.includes(source)) existing.seenBy.push(source);
    if (!existing.hostname && device.hostname) existing.hostname = device.hostname;
    if (!existing.label && device.label) existing.label = device.label;
  };
  for (const device of nasDevices || []) add(device, os.hostname());
  for (const agent of Object.values(agentMap || {})) {
    if (!agent || now - (agent.lastSeen || 0) > ttlMs) continue;
    for (const device of agent.devices || []) add(device, agent.label || agent.name);
  }
  return [...byIp.values()].sort((a, b) => ipToNumber(a.ip) - ipToNumber(b.ip));
}

// Everything the dashboard knows about a device, applied in one place so rooms,
// types and notes work even before a sweep has run.
function annotateDevices(devices, {
  roomMap = rooms,
  kasaMap = kasaByIp,
  discoveryMap = discoveryByIp,
  responders = sweepResponders,
  notes = DEVICE_NOTES,
  sweepAt = lastSweepAt
} = {}) {
  return (devices || []).map(device => {
    const kasa = kasaMap.get(device.ip) || null;
    const broadcast = discoveryMap.get(device.ip) || null;
    const classified = classifyDevice({
      hostname: device.hostname,
      label: device.label,
      model: kasa && kasa.model,
      services: (broadcast && broadcast.mdns && broadcast.mdns.services) || [],
      upnpServer: (broadcast && broadcast.upnp && broadcast.upnp.server) || '',
      upnpServices: (broadcast && broadcast.upnp && broadcast.upnp.serviceTypes) || []
    });
    const annotated = {
      ...device,
      room: roomMap[String(device.mac || '').toLowerCase()] || roomMap[device.ip] || null,
      kasa,
      mdns: broadcast ? broadcast.mdns : null,
      upnp: broadcast ? broadcast.upnp : null,
      note: notes[device.ip] || device.note || null,
      kind: classified ? classified.kind : null,
      kindEvidence: classified ? classified.evidence : null
    };
    if (responders.size) {
      annotated.responded = responders.has(device.ip);
      annotated.sweepMs = responders.get(device.ip) ?? null;
      annotated.lastSweepAt = sweepAt;
    }
    return annotated;
  });
}

function mergedDevices() {
  // The sweep snapshot is fresher than the last check's, and it carries the
  // liveness and Kasa annotations, so use whichever ran most recently.
  const checkAt = lastCheck ? new Date(lastCheck.checkedAt).getTime() : 0;
  const scanAt = lastScan ? lastScan.finishedAt : 0;
  const base = scanAt > checkAt ? lastScan.arp : (lastCheck?.arp || []);
  return annotateDevices(mergeDevices(base, agents));
}

async function startAgent() {
  if (!ADVISOR_HUB) {
    console.error('ROLE=agent needs ADVISOR_HUB pointing at the hub, for example http://192.168.1.179:8090');
    process.exit(1);
  }
  const report = async () => {
    try {
      const readings = await collectReadings();
      const payload = {
        name: AGENT_NAME,
        version: VERSION,
        platform: `${os.type()} ${os.arch()}`,
        addresses: readings.addresses,
        gateway: readings.gateway,
        iface: readings.iface,
        tunnel: readings.tunnel,
        vpn: readings.vpn,
        hub: readings.hub,
        router: readings.router,
        internet: readings.internet,
        dns: readings.dns,
        load: readings.load,
        devices: readings.devices,
        uptimeSec: Math.round(os.uptime())
      };
      const response = await fetch(`${ADVISOR_HUB}/api/agents/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-advisor-token': AGENT_TOKEN },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`hub replied ${response.status} ${detail.slice(0, 120)}`);
      }
      console.log(`[agent] reported ${readings.devices.length} devices to ${ADVISOR_HUB}`);
    } catch (err) {
      console.error('[agent] report failed:', err.message);
    }
  };
  console.log(`Network Advisor agent "${AGENT_NAME}" reporting to ${ADVISOR_HUB} every ${Math.round(AGENT_INTERVAL_MS / 1000)}s`);
  await report();
  setInterval(report, AGENT_INTERVAL_MS);
}

/* ------------------------------------------------------------------ routing */

async function handle(req, res) {
  if (!hostAllowed(req.headers.host)) {
    return json(res, 421, { error: 'Host not allowed; set ALLOWED_HOSTS for DNS names' });
  }
  let reqUrl;
  try {
    reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 421, { error: 'Malformed Host header' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        return json(res, 403, { error: 'Cross-origin requests are not allowed' });
      }
    } catch {
      return json(res, 403, { error: 'Invalid request origin' });
    }
  }

  if (reqUrl.pathname === '/api/state' && req.method === 'GET') {
    if (!lastCheck || Date.now() - new Date(lastCheck.checkedAt).getTime() > 60_000) {
      runCheck().catch(err => console.error('Background check failed:', err.message));
    }
    const now = Date.now();
    const checkAgeMs = lastCheck ? now - new Date(lastCheck.checkedAt).getTime() : null;
    const activeNodes = Object.values(nodes).map(node => ({ ...node, online: now - node.lastSeen < 25_000 }));
    const gateway = readGateway();
    const subnet = parseCidr(SCAN_SUBNET);
    return json(res, 200, {
      app: 'Network Advisor',
      version: VERSION,
      host: os.hostname(),
      addresses: localAddresses(),
      gateway: gateway?.address || null,
      iface: gateway?.iface || null,
      load: readLoad(),
      check: lastCheck,
      // `check` stays null until the first result, so freshness lives beside it
      // rather than inside it: consumers can tell "previous result while a new
      // check runs" from "a check is in progress" without date arithmetic.
      checkMeta: {
        ageMs: checkAgeMs,
        stale: checkAgeMs === null || checkAgeMs > 60_000,
        running: Boolean(checkInFlight)
      },
      sweep: {
        startedAt: lastScanStartedAt || null,
        finishedAt: lastScan ? lastScan.finishedAt : null,
        running: Boolean(scanInFlight),
        enabled: Boolean(parseCidr(SCAN_SUBNET))
      },
      lldp: lldpNeighbours(),
      nodes: activeNodes,
      agents: activeAgents(),
      devices: mergedDevices(),
      arp: lastCheck?.arp || neighbourDevices(readArpTable(), gateway?.iface),
      history: history.slice(-60),
      scan: { enabled: Boolean(subnet), subnet: subnet ? `${subnet.network}/${subnet.prefix}` : null }
    });
  }

  if (reqUrl.pathname === '/api/check' && req.method === 'POST') {
    return json(res, 200, await runCheck());
  }

  if (reqUrl.pathname === '/api/scan' && req.method === 'POST') {
    return json(res, 200, await runScan());
  }

  if (reqUrl.pathname === '/api/rooms' && req.method === 'GET') {
    return json(res, 200, { rooms });
  }

  if (reqUrl.pathname === '/api/rooms' && req.method === 'PUT') {
    if (req.headers['x-advisor-intent'] !== 'write') {
      return json(res, 403, { error: 'Missing x-advisor-intent header' });
    }
    try {
      const body = await readBody(req);
      // A device seen only by broadcast discovery has no MAC, so an address is
      // accepted as the key too.
      const key = String(body.key || body.mac || '').trim().toLowerCase();
      const isMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(key);
      const isAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(key);
      if (!isMac && !isAddress) return json(res, 400, { error: 'Invalid mac or address' });
      const room = cleanText(body.room, 40);
      if (room) rooms[key] = room; else delete rooms[key];
      saveRooms();
      return json(res, 200, { ok: true, key, room: room || null });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
  }

  if (reqUrl.pathname === '/api/history' && req.method === 'GET') {
    return json(res, 200, { records: history, limit: HISTORY_LIMIT });
  }

  if (reqUrl.pathname === '/api/agents' && req.method === 'GET') {
    const intake = Boolean(AGENT_TOKEN) || Object.keys(AGENT_TOKENS).length > 0;
    return json(res, 200, { agents: activeAgents(), onlineWindowMs: AGENT_ONLINE_MS, intake });
  }

  if (reqUrl.pathname === '/api/agents/report' && req.method === 'POST') {
    const perAgent = Object.keys(AGENT_TOKENS).length > 0;
    if (!AGENT_TOKEN && !perAgent) {
      return json(res, 403, { error: 'Agent intake is disabled; set AGENT_TOKEN or AGENT_TOKENS on the hub' });
    }
    try {
      const body = await readBody(req, 512 * 1024);
      const claimed = sanitiseAgentName(body && body.name);
      const expected = perAgent ? AGENT_TOKENS[claimed] : AGENT_TOKEN;
      if (!expected || (!perAgent && !agentTokenMatches(req.headers['x-advisor-token'], expected)) ||
          (perAgent && !agentTokenMatches(req.headers['x-advisor-token'], expected))) {
        return json(res, 403, { error: 'Invalid agent token' });
      }
      const report = sanitiseReport(body);
      recordAgent(report);
      return json(res, 200, { ok: true, name: report.name, devices: report.devices.length });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
  }

  if (reqUrl.pathname === '/api/pulse' && req.method === 'GET') {
    return json(res, 200, { at: Date.now() });
  }

  if (reqUrl.pathname === '/api/speed/download' && req.method === 'GET') {
    const bytes = Math.max(256 * 1024, Math.min(8 * 1024 * 1024, Number(reqUrl.searchParams.get('bytes')) || 4 * 1024 * 1024));
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Encoding': 'identity',
      'X-Content-Type-Options': 'nosniff'
    });
    const chunk = Buffer.alloc(64 * 1024);
    let remaining = bytes;
    while (remaining > 0) {
      if (res.destroyed || res.writableEnded) return;
      const part = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      if (!res.write(part)) {
        // Wait for drain, but give up if the client walks away: the old
        // await-forever held the handler open indefinitely.
        const alive = await new Promise(resolve => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            resolve(!res.destroyed);
          };
          res.once('drain', finish);
          res.once('close', finish);
        });
        if (!alive) return;
      }
      remaining -= part.length;
    }
    return res.end();
  }

  if (reqUrl.pathname === '/api/speed/upload' && req.method === 'POST') {
    try {
      const started = Date.now();
      const bytes = await readRaw(req);
      return json(res, 200, { bytes, elapsedMs: Date.now() - started });
    } catch (err) {
      return json(res, 413, { error: err.message });
    }
  }

  if (reqUrl.pathname === '/api/nodes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = cleanText(body.id, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(res, 400, { error: 'Invalid device id' });
      const previous = Object.hasOwn(nodes, id) ? nodes[id] : {};
      const incomingSpeedCheck = typeof body.speedCheckedAt === 'string' && Number.isFinite(Date.parse(body.speedCheckedAt))
        ? body.speedCheckedAt : null;
      const measured = (value, previousValue) => typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value : (previousValue ?? null);
      nodes[id] = {
        id,
        name: cleanText(body.name || previous.name || 'My device', 40),
        connection: ['Wi-Fi', 'Ethernet', 'Powerline', 'Unknown'].includes(body.connection) ? body.connection : (previous.connection || 'Unknown'),
        deviceType: cleanText(body.deviceType || previous.deviceType || 'Device', 30),
        lastSeen: Date.now(),
        browserRttMs: measured(body.browserRttMs, previous.browserRttMs),
        downMbps: measured(body.downMbps, previous.downMbps),
        upMbps: measured(body.upMbps, previous.upMbps),
        speedCheckedAt: incomingSpeedCheck || previous.speedCheckedAt || null,
        firstSeen: previous.firstSeen || new Date().toISOString()
      };
      trimNodes();
      scheduleSave();
      return json(res, 200, { ok: true, node: nodes[id] });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
  }

  if (reqUrl.pathname.startsWith('/api/nodes/') && req.method === 'DELETE') {
    // A custom header cannot be set cross-origin without a preflight, which
    // browsers then block, so this doubles as CSRF protection for the one
    // destructive endpoint on an otherwise unauthenticated dashboard.
    if (req.headers['x-advisor-intent'] !== 'delete') {
      return json(res, 403, { error: 'Missing x-advisor-intent header' });
    }
    const decoded = decodePathname(reqUrl.pathname.slice('/api/nodes/'.length));
    if (!decoded.ok || !/^[A-Za-z0-9_-]{1,80}$/.test(decoded.value)) {
      return json(res, 400, { error: 'Invalid device id' });
    }
    delete nodes[decoded.value];
    scheduleSave();
    return json(res, 200, { ok: true });
  }

  const decodedPath = decodePathname(reqUrl.pathname);
  if (!decodedPath.ok) return json(res, 400, { error: 'Malformed request path' });

  const file = resolvePublicFile(decodedPath.value);
  if (!file) return json(res, 403, { error: 'Forbidden' });

  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
  const type = MIME[path.extname(file)] || 'text/html';
  const headers = { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' };
  if (type === 'text/html') {
    // Everything is served from disk, so a strict policy costs nothing.
    headers['Content-Security-Policy'] = "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  }
  res.writeHead(200, headers);
  res.end(data);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    // Never let one bad request become a dead dashboard.
    console.error('Request failed:', err && err.stack ? err.stack : err);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    else res.destroy();
  });
});

/* -------------------------------------------------------------------- start */

// Bound slow clients: nothing else limits how long a response may take.
server.setTimeout(30_000);
server.maxConnections = 256;

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      flushState();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

async function selfTestPing() {
  const result = await ping('127.0.0.1');
  if (result.avgMs === null) {
    console.error(`[startup] ping self-test failed (${result.error}). Every timing and sweep will be empty; check CAP_NET_RAW / net.ipv4.ping_group_range.`);
  }
}

if (require.main === module) {
  try {
    loadState();
  } catch (err) {
    console.error('State load failed, starting empty:', err.message);
  }
  if (ROLE === 'agent') {
    startAgent().catch(err => {
      console.error('Agent could not start:', err.message);
      process.exit(1);
    });
  } else {
    server.listen(PORT, BIND_HOST, () => console.log(`Network Advisor listening on ${BIND_HOST}:${PORT}`));
    selfTestPing().catch(() => {});
    if (!AGENT_TOKEN && !Object.keys(AGENT_TOKENS).length) {
      console.warn('Agent intake is disabled (no AGENT_TOKEN / AGENT_TOKENS).');
    } else if (AGENT_TOKEN && !Object.keys(AGENT_TOKENS).length) {
      console.warn('Using one shared AGENT_TOKEN: any holder can change any sensor. Prefer AGENT_TOKENS=name=token,...');
    } else if (AGENT_TOKEN && Object.keys(AGENT_TOKENS).length) {
      console.warn('Both AGENT_TOKEN and AGENT_TOKENS are set: AGENT_TOKEN is ignored, each sensor needs its own entry.');
    }
  }
}

module.exports = {
  server,
  parsePing,
  parseGatewayRoutes,
  parseGatewayRouteList,
  chooseGateway,
  isTunnelInterface,
  parseArpTable,
  neighbourDevices,
  pruneNodes,
  trimAgents,
  writeJsonAtomic,
  readJsonFile,
  hostAllowed,
  parseDeviceNotes,
  parseAgentTokens,
  isContainerInterface,
  cleanText,
  decodePathname,
  resolvePublicFile,
  parseCidr,
  summariseLoad,
  ipToNumber,
  runCheck,
  runScan,
  localAddresses,
  loadState,
  sanitiseReport,
  cleanDeviceList,
  agentTokenMatches,
  recordAgent,
  activeAgents,
  mergeDevices,
  annotateDevices,
  mergedDevices,
  lldpNeighbours,
  discoveryByIp,
  collectReadings
};
