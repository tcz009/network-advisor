const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const dns = require('node:dns').promises;

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 8090);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'nodes.json');
const TARGET = process.env.CHECK_TARGET || '1.1.1.1';
const HOSTNAME = process.env.CHECK_HOSTNAME || 'cloudflare.com';
const publicDir = path.join(__dirname, 'public');
let nodes = Object.create(null);
let lastCheck = null;
let checkInFlight = null;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  Object.assign(nodes, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch { nodes = Object.create(null); }
for (const node of Object.values(nodes)) delete node.userAgent;

function saveNodes() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(nodes, null, 2));
}

function gatewayAddress() {
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    const route = lines.map(line => line.trim().split(/\s+/)).find(parts => parts[1] === '00000000' && (parseInt(parts[3], 16) & 2));
    if (!route) return null;
    const hex = route[2];
    return [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16)).reverse().join('.');
  } catch { return null; }
}

function ping(host) {
  if (!host) return Promise.resolve({ ok: false, avgMs: null, lossPct: null, error: 'No gateway found' });
  return exec('ping', ['-c', '3', '-W', '2', host], { timeout: 9000 })
    .then(({ stdout }) => parsePing(stdout))
    .catch(err => {
      // ping exits non-zero when any probes are lost; its stdout can still contain
      // valid replies and the average RTT, which should not be discarded.
      const parsed = parsePing(`${err.stdout || ''} ${err.stderr || ''}`);
      return { ...parsed, error: parsed.avgMs === null ? 'No ping reply' : (parsed.lossPct > 0 ? 'Some ping replies were lost' : null) };
    });
}

function parsePing(output) {
  const loss = output.match(/([\d.]+)% packet loss/);
  const timing = output.match(/(?:round-trip|rtt) min\/avg\/max(?:\/mdev)? = [\d.]+\/([\d.]+)\//);
  const lossPct = loss ? Number(loss[1]) : null;
  const avgMs = timing ? Number(timing[1]) : null;
  return { ok: avgMs !== null && lossPct === 0, reachable: avgMs !== null, avgMs, lossPct, error: avgMs === null ? 'No ping reply' : (lossPct > 0 ? 'Some ping replies were lost' : null) };
}

function arpDevices() {
  try {
    const rows = fs.readFileSync('/proc/net/arp', 'utf8').trim().split('\n').slice(1);
    return rows.map(row => {
      const [ip, , flags, mac, , iface] = row.trim().split(/\s+/);
      if (!mac || mac === '00:00:00:00:00:00' || parseInt(flags, 16) === 0) return null;
      return { ip, mac, iface };
    }).filter(Boolean);
  } catch { return []; }
}

function runCheck() {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const started = Date.now();
    const gateway = gatewayAddress();
    const [router, internet, dnsResult] = await Promise.all([
      ping(gateway), ping(TARGET),
      dns.lookup(HOSTNAME).then(result => ({ ok: true, address: result.address })).catch(() => ({ ok: false, address: null }))
    ]);
    lastCheck = {
      checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
      gateway, router, target: TARGET, internet, hostname: HOSTNAME, dns: dnsResult,
      arp: arpDevices(), source: 'Checks run from the NAS over its Ethernet connection.'
    };
    return lastCheck;
  })();
  return checkInFlight.finally(() => { checkInFlight = null; });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 8192) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function readRaw(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) reject(new Error('Upload limit exceeded')); });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

function cleanText(value, max = 50) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin requests are not allowed' });
    } catch { return json(res, 403, { error: 'Invalid request origin' }); }
  }
  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (!lastCheck || Date.now() - new Date(lastCheck.checkedAt).getTime() > 60000) runCheck();
    const now = Date.now();
    const activeNodes = Object.values(nodes).map(node => ({ ...node, online: now - node.lastSeen < 25000 }));
    return json(res, 200, { app: 'Network Advisor', version: '0.1.0', host: os.hostname(), gateway: gatewayAddress(), check: lastCheck, nodes: activeNodes, arp: arpDevices() });
  }
  if (url.pathname === '/api/check' && req.method === 'POST') return json(res, 200, await runCheck());
  if (url.pathname === '/api/pulse' && req.method === 'GET') return json(res, 200, { at: Date.now() });
  if (url.pathname === '/api/speed/download' && req.method === 'GET') {
    const bytes = Math.max(256 * 1024, Math.min(8 * 1024 * 1024, Number(url.searchParams.get('bytes')) || 4 * 1024 * 1024));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Encoding': 'identity', 'X-Content-Type-Options': 'nosniff' });
    const chunk = Buffer.alloc(64 * 1024);
    let remaining = bytes;
    while (remaining > 0) {
      const part = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      if (!res.write(part)) await new Promise(resolve => res.once('drain', resolve));
      remaining -= part.length;
    }
    return res.end();
  }
  if (url.pathname === '/api/speed/upload' && req.method === 'POST') {
    try {
      const started = Date.now();
      const bytes = await readRaw(req);
      return json(res, 200, { bytes, elapsedMs: Date.now() - started });
    } catch (err) { return json(res, 413, { error: err.message }); }
  }
  if (url.pathname === '/api/nodes' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = cleanText(body.id, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(res, 400, { error: 'Invalid device id' });
      const previous = Object.hasOwn(nodes, id) ? nodes[id] : {};
      const incomingSpeedCheck = typeof body.speedCheckedAt === 'string' && Number.isFinite(Date.parse(body.speedCheckedAt)) ? body.speedCheckedAt : null;
      const measured = (value, previousValue) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (previousValue ?? null);
      nodes[id] = {
        id, name: cleanText(body.name || previous.name || 'My device', 40),
        connection: ['Wi-Fi', 'Ethernet', 'Powerline', 'Unknown'].includes(body.connection) ? body.connection : (previous.connection || 'Unknown'),
        deviceType: cleanText(body.deviceType || previous.deviceType || 'Device', 30),
        lastSeen: Date.now(), browserRttMs: measured(body.browserRttMs, previous.browserRttMs),
        downMbps: measured(body.downMbps, previous.downMbps), upMbps: measured(body.upMbps, previous.upMbps),
        speedCheckedAt: incomingSpeedCheck || previous.speedCheckedAt || null,
        firstSeen: previous.firstSeen || new Date().toISOString()
      };
      saveNodes();
      return json(res, 200, { ok: true, node: nodes[id] });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (url.pathname.startsWith('/api/nodes/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/nodes/'.length));
    delete nodes[id]; saveNodes(); return json(res, 200, { ok: true });
  }

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(publicDir, requested);
  if (!file.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); res.end(data);
  });
});

server.listen(PORT, BIND_HOST, () => console.log(`Network Advisor listening on ${BIND_HOST}:${PORT}`));
