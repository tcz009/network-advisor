const $ = (id) => document.getElementById(id);

// AbortSignal.timeout is newer than some browsers people actually use. Fall
// back to a controller so a missing API cannot stop every fetch.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
const storageKey = 'network-advisor-device-v1';
let latest = null;
const state = { id: null, name: '', connection: 'Unknown', rtt: null, downMbps: null, upMbps: null, speedCheckedAt: null, checkBusy: false };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'MacBook';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Computer';
  return 'This device';
}
function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `device-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state.id = saved.id || makeId();
    state.name = saved.name || detectDevice();
    state.connection = saved.connection || 'Unknown';
    state.downMbps = typeof saved.downMbps === 'number' ? saved.downMbps : null;
    state.upMbps = typeof saved.upMbps === 'number' ? saved.upMbps : null;
    state.speedCheckedAt = saved.speedCheckedAt || null;
  } catch { state.id = makeId(); state.name = detectDevice(); state.connection = 'Unknown'; }
  $('device-name').value = state.name;
  $('connection-type').value = state.connection;
}
async function saveIdentity() {
  state.name = $('device-name').value.trim() || detectDevice();
  state.connection = $('connection-type').value;
  persistIdentity();
  const saved = await postNode();
  toast(saved ? 'Device details saved to the NAS' : 'Saved on this device only — the NAS did not answer');
}
function persistIdentity() {
  localStorage.setItem(storageKey, JSON.stringify({ id: state.id, name: state.name, connection: state.connection, downMbps: state.downMbps, upMbps: state.upMbps, speedCheckedAt: state.speedCheckedAt }));
}
async function postNode() {
  try {
    const response = await fetch('/api/nodes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ id: state.id, name: state.name, connection: state.connection, deviceType: detectDevice(), browserRttMs: state.rtt, downMbps: state.downMbps, upMbps: state.upMbps, speedCheckedAt: state.speedCheckedAt }),
      signal: timeoutSignal(8000)
    });
    return response.ok;
  } catch { return false; }   // offline or the NAS is restarting
}
async function measureLocalTransfer() {
  const downloadBytes = 4 * 1024 * 1024;
  const dlStart = performance.now();
  const response = await fetch(`/api/speed/download?bytes=${downloadBytes}&t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Download check failed');
  await response.arrayBuffer();
  const dlSeconds = Math.max((performance.now() - dlStart) / 1000, .01);
  const upBytes = new Uint8Array(1024 * 1024);
  const upStart = performance.now();
  const upload = await fetch(`/api/speed/upload?t=${Date.now()}`, { method: 'POST', body: upBytes, cache: 'no-store' });
  if (!upload.ok) throw new Error('Upload check failed');
  await upload.json();
  const upSeconds = Math.max((performance.now() - upStart) / 1000, .01);
  state.downMbps = downloadBytes * 8 / dlSeconds / 1e6;
  state.upMbps = upBytes.byteLength * 8 / upSeconds / 1e6;
  state.speedCheckedAt = new Date().toISOString();
  persistIdentity();
  return { downMbps: state.downMbps, upMbps: state.upMbps };
}
async function pulse() {
  const started = performance.now();
  try {
    const response = await fetch(`/api/pulse?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Offline');
    await response.json();
    state.rtt = Math.round(performance.now() - started);
    await postNode();
  } catch { state.rtt = null; }
}
function fmtMs(n) { return n == null ? '—' : `${Number(n).toFixed(Number(n) < 10 ? 1 : 0)} ms`; }
function fmtMbps(n) { return n == null ? '—' : `${Number(n) >= 100 ? Number(n).toFixed(0) : Number(n).toFixed(1)} Mbps`; }
function timeAgo(timestamp) {
  if (!timestamp) return 'Not yet seen';
  const delta = Math.max(0, Date.now() - Number(timestamp));
  if (delta < 5000) return 'Just now';
  if (delta < 60000) return `${Math.round(delta / 1000)} sec ago`;
  if (delta < 3600000) return `${Math.floor(delta / 60000)} min ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function setMetric(id, value, unit) {
  $(id).innerHTML = `${escapeHtml(value)}<span class="metric-unit"> ${unit}</span>`;
}
function renderFindings(data) {
  const check = data.check;
  const items = [];
  if (!check) {
    $('findings').innerHTML = '<div class="empty-finding"><span class="finding-icon">✳</span><div><strong>Building your picture</strong><p>Run a check to test the NAS connection. Open this page on your other devices to add them to the map.</p></div></div>';
    return;
  }
  if (!check.gateway) items.push({ kind: 'warning', icon: '!', title: 'Router not identified', text: 'The NAS could not read a default gateway. Check that it is connected to the home router and that Docker is using host networking.' });
  else if (check.router?.lossPct > 0) items.push({ kind: 'warning', icon: '!', title: 'Router replies were missed', text: `${check.router.lossPct}% packet loss was measured between the NAS and router. This points to the local wired link or router; run another check to confirm.` });
  else if (check.router?.avgMs != null && check.router.avgMs > 10) items.push({ kind: 'warning', icon: '!', title: 'Local response is slower than expected', text: `The router replied in ${fmtMs(check.router.avgMs)} from the NAS. This check is over Ethernet, so it does not measure Wi-Fi quality.` });
  else if (check.router?.avgMs != null) items.push({ kind: 'good', icon: '✓', title: 'NAS-to-router link looks responsive', text: `The router replied in ${fmtMs(check.router.avgMs)} with ${check.router.lossPct ?? 0}% reported packet loss.` });
  if (data.load?.busy) items.push({ kind: 'info', icon: '·', title: 'The NAS is busy', text: `Load is ${data.load.load1} across ${data.load.cores} cores, so ping timings include CPU queueing. Treat the numbers above as an upper bound until the NAS is idle.` });
  if (check.internet?.avgMs == null) items.push({ kind: 'info', icon: 'i', title: 'Internet test point did not reply to ping', text: `The NAS did not receive a ping reply from ${escapeHtml(check.target)}. Some networks filter ping, so this alone does not prove the internet is down.` });
  else if (check.internet.lossPct > 0) items.push({ kind: 'warning', icon: '!', title: 'Some internet test packets were lost', text: `${check.internet.lossPct}% of pings to ${escapeHtml(check.target)} were unanswered. Repeat the check to see whether this is persistent.` });
  else items.push({ kind: 'good', icon: '✓', title: 'Internet test point replied', text: `Average response was ${fmtMs(check.internet.avgMs)} from the NAS. This is latency, not an internet download-speed test.` });
  if (!check.dns?.ok) items.push({ kind: 'warning', icon: '!', title: 'DNS lookup failed', text: `The NAS could not look up ${escapeHtml(check.hostname)} during this check.` });
  const offline = (data.nodes || []).filter(node => !node.online).length;
  if (offline) items.push({ kind: 'info', icon: '·', title: `${offline} saved device${offline === 1 ? '' : 's'} not reporting now`, text: 'A device is marked offline when its browser has not checked in recently. It may simply have closed the dashboard.' });
  $('findings').innerHTML = items.map(item => `<div class="finding ${item.kind}"><span class="finding-icon">${item.icon}</span><div><strong>${item.title}</strong><p>${item.text}</p></div></div>`).join('');
}
function renderNodes(nodes) {
  const sorted = [...(nodes || [])].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  const online = sorted.filter(node => node.online).length;
  setMetric('online-count', online, 'devices');
  $('device-foot').textContent = online ? `${online} reporting from this dashboard` : 'Open the page on another device to add a node';
  $('nodes-total').textContent = String(sorted.length);
  const offlineCount = sorted.filter(node => !node.online).length;
  const clearButton = $('clear-offline');
  clearButton.hidden = offlineCount === 0;
  clearButton.textContent = `Clear offline (${offlineCount})`;
  const focusedId = document.activeElement?.dataset?.nodeId || null;
  $('nodes-table').innerHTML = sorted.length ? sorted.map(node => `<tr><td><div class="device-cell"><span class="device-dot">${node.deviceType?.includes('Mac') || node.deviceType?.includes('PC') ? '▱' : '▯'}</span><div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.deviceType || 'Device')}</small></div></div></td><td>${escapeHtml(node.connection || 'Unknown')}<small class="table-secondary">Set on device</small></td><td>${fmtMs(node.browserRttMs)}<small class="table-secondary">Device-to-NAS response</small><small class="table-secondary">↓ ${fmtMbps(node.downMbps)} &nbsp; ↑ ${fmtMbps(node.upMbps)}${node.speedCheckedAt ? ` · checked ${timeAgo(new Date(node.speedCheckedAt).getTime())}` : ' · not measured'}</small></td><td>${timeAgo(node.lastSeen)}</td><td><span class="${node.online ? 'online-badge' : 'offline-badge'}">${node.online ? 'ONLINE' : 'OFFLINE'}</span></td><td class="row-actions"><button class="row-delete" data-node-id="${escapeHtml(node.id)}" title="Forget this device" aria-label="Forget ${escapeHtml(node.name)}">×</button></td></tr>`).join('') : '<tr><td class="empty-row" colspan="6">Open this page on your phone or MacBook to add it to the map.</td></tr>';
  // The poll rebuilds this table every 7 s; without this a keyboard user loses
  // their place in it each time.
  if (focusedId) {
    [...document.querySelectorAll('.row-delete')]
      .find(button => button.dataset.nodeId === focusedId)
      ?.focus();
  }
}
function mapLeaves(data) {
  const sensors = (data.agents || []).map(agent => {
    const tunnelOnly = Boolean(agent.tunnel) || (!agent.gateway && Boolean(agent.vpn));
    const hop = agent.gateway || agent.vpn?.address || null;
    const hopIface = agent.iface || agent.vpn?.iface || null;
    const toHub = agent.hub && agent.hub.avgMs != null ? fmtMs(agent.hub.avgMs) : null;
    const lines = [
      hop ? `${hop}${hopIface ? ` ${hopIface}` : ''}${tunnelOnly ? ' · VPN' : ''}` : 'no default route'
    ];
    // A host can have both a LAN default route and a VPN one; say so instead of
    // tagging the LAN hop as if the traffic went through the tunnel.
    if (agent.gateway && agent.vpn) lines.push(`VPN ${agent.vpn.address} ${agent.vpn.iface || ''}`.trim());
    lines.push(`to hub ${toHub || 'not measured'}`);
    return {
      kind: 'sensor',
      addresses: Array.isArray(agent.addresses) ? agent.addresses : [],
      name: agent.label || agent.name,
      online: Boolean(agent.online),
      measured: Boolean(agent.online) && (agent.hub?.avgMs != null || agent.router?.avgMs != null),
      lines
    };
  }).sort((a, b) => Number(b.online) - Number(a.online));

  const allBrowsers = data.nodes || [];
  const browsers = allBrowsers
    .filter(node => node.online)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(node => ({
      kind: 'browser',
      name: node.name || 'Device',
      online: Boolean(node.online),
      measured: Boolean(node.online) && node.browserRttMs != null,
      lines: [`to NAS ${fmtMs(node.browserRttMs)}`, node.connection && node.connection !== 'Unknown' ? node.connection : (node.deviceType || 'device')]
    }));

  // Everything else the NAS has seen, so the picture is the network and not
  // just the hosts that happen to run a browser. Devices with no name are
  // grouped, because a dozen identical "unidentified" chips is noise.
  const known = new Set();
  for (const leaf of sensors) for (const address of leaf.addresses) known.add(address);
  for (const address of data.addresses || []) known.add(address);
  if (data.gateway) known.add(data.gateway);   // the Router node already represents it

  const entries = (data.devices || [])
    .filter(device => !known.has(device.ip))
    .map(device => {
      const vendor = device.label && device.label !== 'Randomised MAC' ? device.label : null;
      return { ip: device.ip, vendor, name: device.hostname || vendor || null, seenBy: device.seenBy || [] };
    });

  // mDNS names carry the router's domain; the first label is what a person says.
  const shortLabel = value => {
    const text = String(value || '');
    const cut = text.indexOf('.');
    return cut > 0 ? text.slice(0, cut) : text;
  };

  const named = entries.filter(entry => entry.name).map(entry => ({
    kind: 'device',
    name: shortLabel(entry.name),
    online: true,
    measured: false,
    title: `${entry.ip}${entry.vendor && entry.vendor !== entry.name ? ` · ${entry.vendor}` : ''}${entry.seenBy.length > 1 ? ` · seen by ${entry.seenBy.length} hosts` : ''}`,
    lines: [entry.ip]
  }));

  const unnamed = entries.filter(entry => !entry.name);
  const grouped = unnamed.length
    ? [{
        kind: 'device',
        name: `${unnamed.length} unidentified`,
        online: true,
        measured: false,
        title: unnamed.map(entry => `${entry.ip}${entry.vendor ? ` (${entry.vendor})` : ''}`).join('  '),
        lines: [unnamed.slice(0, 3).map(entry => entry.ip).join(', ') + (unnamed.length > 3 ? ` +${unnamed.length - 3}` : '')]
      }]
    : [];

  const others = [...named, ...grouped];

  const powerline = browsers.filter(leaf => leaf.lines[1] === 'Powerline');
  const offline = allBrowsers.filter(node => !node.online).length;
  return { sensors, browsers, others, powerline, offline };
}

function measureInStage(element) {
  const stage = $('map-stage');
  const box = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - box.left,
    top: rect.top - box.top,
    width: rect.width,
    height: rect.height,
    cx: rect.left - box.left + rect.width / 2,
    bottom: rect.top - box.top + rect.height
  };
}

function drawMapLines() {
  const stage = $('map-stage');
  const svg = $('map-fan');
  if (!stage || !svg) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) {
    svg.innerHTML = '';
    return;
  }
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const parts = [];
  const line = (x1, y1, x2, y2, dim) =>
    parts.push(`<path class="fan-line${dim ? ' fan-line-dim' : ''}" d="M${x1} ${y1} L${x2} ${y2}"/>`);

  const internet = document.querySelector('.label-internet');
  const router = document.querySelector('.label-router');
  const nasLabel = document.querySelector('.label-nas');
  if (!internet || !router || !nasLabel) {
    svg.innerHTML = '';
    return;
  }
  const i = measureInStage(internet);
  const r = measureInStage(router);
  const n = measureInStage(nasLabel);
  line(i.cx, i.bottom, r.cx, r.top, false);
  line(r.cx, r.bottom, n.cx, n.top, false);

  // Group leaves into visual rows, then run a bus above each row and a trunk
  // down the centre. This keeps every host connected however many rows it takes.
  const leaves = [...document.querySelectorAll('#map-leaves .map-leaf[data-measured]')]
    .map(el => ({ el, box: measureInStage(el), measured: el.dataset.measured === '1' }));
  const rows = [];
  for (const leaf of leaves) {
    const row = rows.find(candidate => Math.abs(candidate.top - leaf.box.top) <= 6);
    if (row) {
      row.items.push(leaf);
      row.top = Math.min(row.top, leaf.box.top);
    } else {
      rows.push({ top: leaf.box.top, items: [leaf] });
    }
  }
  rows.sort((a, b) => a.top - b.top);

  // Must stay smaller than the row gap in CSS, or the bus lands inside the row above.
  const BUS_GAP = 12;
  // Rows connect through a spine down the left edge. A centre trunk would run
  // straight through the row above, which is what made the first attempt look
  // like the cards were strung on a wire.
  // Derived from the cards rather than fixed: a full row starts further left
  // than a short one, and a fixed spine ended up inside the leftmost card.
  const leftMost = Math.min(...rows.flatMap(row => row.items.map(leaf => leaf.box.left)), n.cx);
  const SPINE_X = Math.max(4, Math.round(leftMost) - 10);
  const buses = rows.map(row => ({
    top: row.top,
    y: row.top - BUS_GAP,
    items: row.items,
    right: Math.max(...row.items.map(leaf => leaf.box.cx), n.cx)
  }));

  if (buses.length) {
    line(n.cx, n.bottom, n.cx, buses[0].y, false);
    buses.forEach((bus, index) => {
      line(SPINE_X, bus.y, bus.right, bus.y, false);
      if (index > 0) line(SPINE_X, buses[index - 1].y, SPINE_X, bus.y, false);
      for (const leaf of bus.items) {
        line(leaf.box.cx, bus.y, leaf.box.cx, leaf.box.top, !leaf.measured);
      }
    });
  }
  svg.innerHTML = parts.join('');
}

function renderMap(data) {
  const { sensors, browsers, others, powerline, offline } = mapLeaves(data);
  const stage = $('map-stage');
  const width = stage ? stage.clientWidth : 900;
  // Hard ceiling only; rows are laid out and wired up by drawMapLines.
  const perRow = Math.max(1, Math.floor((width - 30) / 142));
  const capacity = Math.max(perRow, Math.min(30, perRow * 6));
  const leaves = [...sensors, ...browsers, ...others];
  const shown = leaves.slice(0, capacity);
  const hidden = leaves.length - shown.length;

  $('map-leaves').innerHTML = shown.map(leaf => `
    <div class="map-leaf ${leaf.kind}${leaf.online ? '' : ' offline'}" data-measured="${leaf.measured ? '1' : '0'}">
      <span class="leaf-icon">${leaf.kind === 'sensor' ? '◈' : leaf.kind === 'browser' ? '▯' : '·'}</span>
      <span class="leaf-name" title="${escapeHtml(leaf.title || leaf.name)}">${escapeHtml(leaf.name)}</span>
      ${leaf.lines.map(line => `<span class="leaf-sub">${escapeHtml(line)}</span>`).join('')}
    </div>`).join('') + (hidden > 0 ? `<div class="map-leaf more"><span class="leaf-name">+${hidden} more</span><span class="leaf-sub">see the tables below</span></div>` : '');

  $('map-extra').textContent = '';
  const base = powerline.length
    ? 'The horizontal lines stand in for the shared LAN segment. A device reports a powerline link, but the adapters themselves are not mapped.'
    : 'The horizontal lines stand in for the shared LAN segment. Cards were measured directly; chips were only seen, never measured.';
  $('map-caption-text').textContent = offline
    ? `${base} ${offline} saved device${offline === 1 ? '' : 's'} ${offline === 1 ? 'is' : 'are'} not reporting and ${offline === 1 ? 'is' : 'are'} listed below.`
    : base;

  requestAnimationFrame(drawMapLines);
}

function renderArp(devices) {
  const rows = devices || [];
  setMetric('seen-count', rows.length, 'devices');
  $('arp-list').innerHTML = rows.length ? rows.slice(0, 12).map(item => {
    const title = item.hostname || item.label || 'Unidentified device';
    const detail = [item.ip, item.mac].filter(Boolean).join(' · ');
    const vendor = item.hostname && item.label ? item.label : null;
    const seenBy = Array.isArray(item.seenBy) && item.seenBy.length > 1
      ? `seen by ${item.seenBy.join(' + ')}` : '';
    const secondary = [vendor, seenBy].filter(Boolean).join(' · ');
    return `<div class="arp-row"><span>${escapeHtml(title)}</span><code>${escapeHtml(detail)}</code>${secondary ? `<small class="table-secondary">${escapeHtml(secondary)}</small>` : ''}</div>`;
  }).join('') : '<p class="muted-copy">No recent neighbour entries. Devices appear here after the NAS has communicated with them.</p>';
}

function renderAgents(agents) {
  const rows = agents || [];
  $('agents-total').textContent = String(rows.length);
  $('agents-table').innerHTML = rows.length ? rows.map(agent => {
    const load = agent.load ? `${agent.load.load1} / ${agent.load.cores}` : '—';
    const hopAddress = agent.gateway || agent.vpn?.address || null;
    const hopIface = agent.iface || agent.vpn?.iface || null;
    const tunnelOnly = Boolean(agent.tunnel) || (!agent.gateway && Boolean(agent.vpn));
    const vpnNote = agent.gateway && agent.vpn
      ? `<small class="table-secondary">VPN also up: ${escapeHtml(agent.vpn.address)}</small>`
      : '';
    const hop = hopAddress
      ? `${escapeHtml(hopAddress)}${tunnelOnly ? ' <em>VPN</em>' : ''}<small class="table-secondary">${escapeHtml(hopIface || '')}</small>${vpnNote}`
      : 'no default route';
    const toHub = agent.hub && agent.hub.avgMs != null ? fmtMs(agent.hub.avgMs) : '—';
    return `<tr><td><div class="device-cell"><span class="device-dot">◈</span><div><strong>${escapeHtml(agent.label || agent.name)}</strong><small>${escapeHtml(agent.platform || 'sensor')}</small></div></div></td><td>${hop}</td><td>${toHub}</td><td>${Number(agent.deviceCount || 0)}</td><td>${escapeHtml(load)}${agent.load?.busy ? '<small class="table-secondary">busy</small>' : ''}</td><td>${timeAgo(agent.lastSeen)}</td><td><span class="${agent.online ? 'online-badge' : 'offline-badge'}">${agent.online ? 'ONLINE' : 'OFFLINE'}</span></td></tr>`;
  }).join('') : '<tr><td class="empty-row" colspan="7">No sensors reporting yet. Run an agent on a Pi with ROLE=agent and point it at this hub.</td></tr>';
}

function drawSparkline(elementId, values) {
  const svg = $(elementId);
  const points = (values || []).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (points.length < 2) {
    svg.innerHTML = '';
    return false;
  }
  const width = 240;
  const height = 44;
  const pad = 4;
  const max = Math.max(...points, 1);
  const stepX = width / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = index * stepX;
    const y = height - pad - (value / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `M0,${height} L${coords.join(' L')} L${width},${height} Z`;
  svg.innerHTML = `<path class="spark-area" d="${area}"></path><polyline class="spark-line" points="${coords.join(' ')}"></polyline>`;
  return true;
}

function renderTrend(history, scan) {
  const records = Array.isArray(history) ? history : [];
  const scanNote = scan && scan.enabled ? `Active discovery sweeps ${scan.subnet} when you run a check.` : null;
  const drewRouter = drawSparkline('trend-router', records.map(record => record.routerMs));
  const drewInternet = drawSparkline('trend-internet', records.map(record => record.internetMs));
  const latestRecord = records[records.length - 1];
  $('trend-router-now').textContent = latestRecord && latestRecord.routerMs != null ? fmtMs(latestRecord.routerMs) : '—';
  $('trend-internet-now').textContent = latestRecord && latestRecord.internetMs != null ? fmtMs(latestRecord.internetMs) : '—';
  if (!drewRouter && !drewInternet) {
    $('trend-note').textContent = records.length
      ? 'Not enough successful checks yet to draw a line.'
      : 'Two checks are needed before a line can be drawn.';
  } else if (scanNote) {
    $('trend-note').textContent = scanNote;
  } else {
    $('trend-note').textContent = `Last ${records.length} checks, newest on the right.`;
  }
}
function render(data) {
  latest = data;
  $('connection-status').textContent = 'NAS ONLINE';
  $('connection-indicator').classList.remove('offline');
  document.body.classList.remove('data-stale');
  renderNodes(data.nodes);
  renderAgents(data.agents);
  renderMap(data);
  renderTrend(data.history, data.scan);
  renderArp(data.devices || data.arp);
  renderFindings(data);
  const check = data.check;
  if (check) {
    setMetric('router-rtt', check.router?.avgMs == null ? '—' : Number(check.router.avgMs).toFixed(Number(check.router.avgMs) < 10 ? 1 : 0), 'ms');
    setMetric('internet-rtt', check.internet?.avgMs == null ? '—' : Number(check.internet.avgMs).toFixed(Number(check.internet.avgMs) < 10 ? 1 : 0), 'ms');
    $('router-foot').textContent = check.gateway ? `${check.gateway} · ${check.router?.lossPct ?? '—'}% packet loss` : 'No gateway detected';
    $('internet-foot').textContent = `${check.target} · response time, not throughput`;
    $('map-router').textContent = check.gateway ? `${check.gateway} · ${fmtMs(check.router?.avgMs)}` : 'Gateway not found';
    const iface = data.iface || '';
    $('map-nas-sub').textContent = /^(eth|en|eno|enp|ens)/.test(iface) ? `Ethernet ${iface} · advisor host` : iface ? `${iface} · advisor host` : 'advisor host';
    $('map-internet').textContent = check.internet?.avgMs == null ? 'No ping reply' : `${fmtMs(check.internet.avgMs)} average response`;
    $('last-check').textContent = new Date(check.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('map-footer-time').textContent = `Last NAS check ${timeAgo(new Date(check.checkedAt).getTime())}`;
  }
}
let refreshInFlight = false;
let lastGoodRender = 0;

async function refresh() {
  if (refreshInFlight) return;          // a slow poll must not stack up
  refreshInFlight = true;
  try {
    const response = await fetch(`/api/state?t=${Date.now()}`, {
      cache: 'no-store', signal: timeoutSignal(8000)
    });
    if (!response.ok) throw new Error('NAS not responding');
    const data = await response.json();
    render(data);
    lastGoodRender = Date.now();
  } catch {
    const age = lastGoodRender
      ? new Date(lastGoodRender).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : null;
    $('connection-status').textContent = age ? `NAS NOT REACHABLE · DATA FROM ${age}` : 'NAS NOT REACHABLE';
    $('connection-indicator').classList.add('offline');
    document.body.classList.add('data-stale');
  } finally {
    refreshInFlight = false;
  }
}
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
async function runChecks() {
  if (state.checkBusy) return;
  state.checkBusy = true;
  const button = $('run-check'); button.disabled = true; button.textContent = 'Checking network…';
  try {
    const nasCheck = fetch('/api/check', { method: 'POST', cache: 'no-store', signal: timeoutSignal(20000) })
      .then(response => { if (!response.ok) throw new Error('NAS check failed'); return response.json(); });
    const localTransfer = measureLocalTransfer().catch(() => null);
    const [nasResponse, local] = await Promise.all([nasCheck, localTransfer]);
    let discovery = '';
    if (latest?.scan?.enabled) {
      try {
        const scanResponse = await fetch('/api/scan', { method: 'POST', cache: 'no-store' });
        if (scanResponse.ok) {
          const scan = await scanResponse.json();
          discovery = ` · ${scan.devices} devices discovered`;
        }
      } catch { /* discovery is best effort and must not fail the check */ }
    }
    await postNode();
    await refresh();
    toast(local
      ? `Checks complete · this device ${fmtMbps(local.downMbps)} down, ${fmtMbps(local.upMbps)} up${discovery}`
      : `Checks complete${discovery} · this device's speed test did not finish`);
  } catch (err) {
    await pulse(); await refresh();
    toast(`Some checks could not finish: ${err.message}`);
  } finally {
    state.checkBusy = false; button.disabled = false; button.innerHTML = '<span class="button-spark">✳</span> Run network check <span class="button-arrow">↗</span>';
  }
}

loadIdentity();
$('nav-map').addEventListener('click', () => {
  document.querySelectorAll('.rail-button').forEach(button => { button.classList.toggle('active', button.id === 'nav-map'); button.removeAttribute('aria-current'); });
  $('nav-map').setAttribute('aria-current', 'page');
  $('map-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('nav-devices').addEventListener('click', () => {
  document.querySelectorAll('.rail-button').forEach(button => { button.classList.toggle('active', button.id === 'nav-devices'); button.removeAttribute('aria-current'); });
  $('nav-devices').setAttribute('aria-current', 'page');
  document.querySelector('.devices-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
async function forgetNode(id) {
  try {
    const response = await fetch(`/api/nodes/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'x-advisor-intent': 'delete' }, cache: 'no-store'
    });
    return response.ok;
  } catch { return false; }
}

$('nodes-table').addEventListener('click', async event => {
  const button = event.target.closest('.row-delete');
  if (!button) return;
  const id = button.dataset.nodeId;
  if (id === state.id && !confirm('This browser is the device you are using. Forget it anyway?')) return;
  button.disabled = true;
  if (await forgetNode(id)) { toast('Device forgotten'); await refresh(); }
  else { toast('Could not forget that device'); button.disabled = false; }
});

$('clear-offline').addEventListener('click', async () => {
  const offline = (latest?.nodes || []).filter(node => !node.online);
  if (!offline.length) return;
  if (!confirm(`Forget ${offline.length} device${offline.length === 1 ? '' : 's'} that are not reporting? They will come back if you open the dashboard on them again.`)) return;
  let removed = 0;
  for (const node of offline) {
    if (await forgetNode(node.id)) removed++;
  }
  toast(`Forgot ${removed} device${removed === 1 ? '' : 's'}`);
  await refresh();
});

$('save-device').addEventListener('click', saveIdentity);
$('device-name').addEventListener('keydown', event => { if (event.key === 'Enter') saveIdentity(); });
$('run-check').addEventListener('click', runChecks);
if (typeof ResizeObserver === 'function') {
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (latest) drawMapLines(); }, 120);
  }).observe($('map-stage'));
}
window.addEventListener('orientationchange', () => { if (latest) drawMapLines(); });

postNode();
pulse().then(refresh);
setInterval(pulse, 9000);
setInterval(refresh, 7000);
