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
let roomFilter = null;
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
  const powerline = data.powerline;
  if (powerline && powerline.ok && Array.isArray(powerline.adapters) && powerline.adapters.length > 1) {
    const peers = powerline.adapters.filter(adapter => !adapter.local);
    const viaPeer = peers.find(adapter => adapter.behindIp === check.gateway);
    const rate = powerline.bestTxMbps;
    if (viaPeer) {
      items.push({
        kind: 'info', icon: '≡',
        title: 'The router is reached over powerline',
        text: `The NAS reaches ${escapeHtml(check.gateway)} through a powerline adapter${rate ? ` running at ${rate} Mb/s PHY` : ''}. That is a shared mains link, not a direct cable, so local latency and throughput are limited by it.`
      });
    }
    if (rate && rate < 120) {
      items.push({
        kind: 'warning', icon: '!',
        title: 'Powerline link is slow',
        text: `The fastest powerline link is ${rate} Mb/s PHY. Check that neither adapter is on a power strip or surge protector, and that standby mode is disabled.`
      });
    }
  }
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
      // A confirmed Kasa device knows its own name; that beats any vendor guess.
      const kasa = device.kasa || null;
      const kasaName = kasa
        ? (kasa.alias || kasa.model || (kasa.confirmed ? 'Kasa device' : 'Port 9999 open'))
        : null;
      const vendor = kasaName || (device.label && device.label !== 'Randomised MAC' ? device.label : null);
      const latency = typeof device.sweepMs === 'number' ? fmtMs(device.sweepMs) : null;
      const mdnsName = device.mdns && device.mdns.name ? device.mdns.name.replace(/\.local$/, '') : null;
      const services = (device.mdns && device.mdns.services) || [];
      const upnp = device.upnp && device.upnp.server
        ? device.upnp.server.replace(/^.*?UPnP\/[\d.]+\s*/i, '').replace(/\/.*$/, '')
        : null;
      return {
        ip: device.ip,
        vendor,
        name: device.hostname || mdnsName || vendor || null,
        services,
        upnp,
        seenBy: device.seenBy || [],
        unresponsive: device.responded === false,
        kind: device.kind || null,
        room: device.room || null,
        note: device.note || null,
        latency,
        kasa: Boolean(kasa && kasa.confirmed)
      };
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
    unresponsive: entry.unresponsive,
    title: [
      entry.ip,
      entry.room,
      entry.kind,
      entry.services && entry.services.length ? `mdns: ${entry.services.slice(0, 2).join(', ')}` : null,
      entry.upnp,
      entry.vendor && entry.vendor !== entry.name ? entry.vendor : null,
      entry.note,
      entry.seenBy.length > 1 ? `seen by ${entry.seenBy.length} hosts` : null,
      entry.unresponsive ? 'did not answer the last sweep' : null
    ].filter(Boolean).join(' · '),
    lines: [
      entry.room ? entry.room : null,
      entry.ip,
      entry.unresponsive ? 'not responding' : [entry.kind, entry.latency].filter(Boolean).join(' · '),
      entry.note
    ].filter(Boolean)
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
    <div class="map-leaf ${leaf.kind}${leaf.online ? '' : ' offline'}${leaf.unresponsive ? ' unresponsive' : ''}" data-measured="${leaf.measured ? '1' : '0'}">
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

function renderRooms(devices) {
  const counts = new Map();
  let unassigned = 0;
  for (const device of devices || []) {
    const room = device.room;
    if (room) counts.set(room, (counts.get(room) || 0) + 1);
    else unassigned++;
  }
  const pills = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([room, count]) => {
      const active = roomFilter === room ? ' active' : '';
      return `<button class="room-pill${active}" data-room="${escapeHtml(room)}" type="button">${escapeHtml(room)} <b>${count}</b></button>`;
    });
  if (unassigned) {
    const active = roomFilter === '' ? ' active' : '';
    pills.push(`<button class="room-pill unassigned${active}" data-room="" type="button">unassigned <b>${unassigned}</b></button>`);
  }
  if (roomFilter !== null) pills.push('<button class="room-pill clear" data-room="__all" type="button">show all</button>');
  $('rooms-summary').innerHTML = pills.join('');
}

function renderPowerline(powerline) {
  const el = $('powerline-line');
  if (!el) return;
  if (!powerline || powerline.ok !== true || !powerline.adapters || !powerline.adapters.length) {
    el.textContent = '';
    return;
  }
  const peers = powerline.adapters.filter(adapter => !adapter.local);
  const rate = powerline.bestTxMbps
    ? `${powerline.bestTxMbps}/${powerline.bestRxMbps ?? '?'} Mb/s`
    : 'rate unknown';
  const described = peers.map(adapter => adapter.behindLabel || adapter.bda || adapter.mac).join(', ');
  const trend = (powerline.trend || []).map(point => point.tx);
  const spark = trend.length > 1 ? sparklineSvg(trend, 46, 12) : '';
  el.innerHTML = `<span class="upstream-dot"></span>Powerline: ${powerline.adapters.length} adapters · link ${escapeHtml(rate)}${described ? ` · bridging ${escapeHtml(described)}` : ''} ${spark}`;
}

function renderChanges(events) {
  const list = events || [];
  $('changes-count').textContent = String(list.length);
  if (!list.length) {
    $('changes-list').innerHTML = '<p class="muted-copy">Nothing has joined, left or moved since the dashboard started watching.</p>';
    return;
  }
  $('changes-list').innerHTML = list.slice(0, 8).map(event => {
    const stamp = event.at ? new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return `<div class="change-row ${escapeHtml(event.type || '')}"><span class="change-time">${escapeHtml(stamp)}</span><span class="change-detail">${escapeHtml(event.detail || event.type || '')}</span></div>`;
  }).join('');
}

function renderPihole(pihole) {
  const body = $('pihole-body');
  if (!pihole || pihole.configured === false) {
    body.innerHTML = '<p class="muted-copy">Pi-hole is not configured yet. Paste an app password from Pi-hole → Settings → API.</p>';
    $('pihole-open').hidden = false;
    return;
  }
  if (pihole.ok === false) {
    body.innerHTML = `<p class="muted-copy">Pi-hole did not answer${pihole.error ? ` (${escapeHtml(pihole.error)})` : ''}.</p>`;
    return;
  }
  $('pihole-open').hidden = false;
  const summary = pihole.summary || {};
  const top = (pihole.topBlocked || [])[0];
  body.innerHTML = `
    <div class="dns-figure"><strong>${escapeHtml(String(summary.percentBlocked ?? 0))}%</strong><span>of queries blocked</span></div>
    <div class="dns-rows">
      <div><span>Queries today</span><b>${escapeHtml(Number(summary.queries || 0).toLocaleString())}</b></div>
      <div><span>Blocked</span><b>${escapeHtml(Number(summary.blocked || 0).toLocaleString())}</b></div>
      ${top ? `<div><span>Top blocked</span><b title="${escapeHtml(top.domain)}">${escapeHtml(String(top.domain).slice(0, 22))}</b></div>` : ''}
    </div>`;
}

function renderUpstream(lldp) {
  const el = $('upstream');
  const neighbours = (lldp && lldp.neighbours) || [];
  if (!neighbours.length) {
    el.textContent = lldp && lldp.error === 'no capture file'
      ? 'Upstream equipment: no LLDP capture yet'
      : 'Upstream equipment: nothing advertising LLDP';
    return;
  }
  el.innerHTML = neighbours.slice(0, 3).map(neighbour => {
    const bits = [
      neighbour.systemName || neighbour.systemDescription || neighbour.chassisId || neighbour.source,
      neighbour.portDescription || neighbour.portId ? `port ${neighbour.portDescription || neighbour.portId}` : null,
      neighbour.vlan ? `VLAN ${neighbour.vlan}` : null,
      neighbour.speed,
      neighbour.capabilities.length ? neighbour.capabilities.join(', ') : null
    ].filter(Boolean);
    return `<span class="upstream-item"><span class="upstream-dot"></span>${escapeHtml(bits.join(' · '))}</span>`;
  }).join('');
}

function ipSort(a, b) {
  const toNumber = ip => ip.split('.').reduce((total, part) => total * 256 + Number(part || 0), 0);
  return toNumber(a.ip) - toNumber(b.ip);
}

function renderArp(devices) {
  const all = devices || [];
  setMetric('seen-count', all.length, 'devices');
  renderRooms(all);

  // Roomed devices first, grouped by room; unassigned last, each group by IP.
  const filtered = roomFilter === null
    ? all
    : all.filter(item => (roomFilter === '' ? !item.room : item.room === roomFilter));
  const rows = [...filtered].sort((a, b) => {
    const roomA = a.room || '\uffff';
    const roomB = b.room || '\uffff';
    return roomA.localeCompare(roomB) || ipSort(a, b);
  });

  $('arp-list').innerHTML = rows.length ? rows.slice(0, 30).map(item => {
    const fullName = item.hostname || item.label || 'Unidentified device';
    // Same shortening as the map chips: the first label is what a person says.
    const dot = fullName.indexOf('.');
    const title = dot > 0 ? fullName.slice(0, dot) : fullName;
    const detail = [item.ip, item.mac].filter(Boolean).join(' · ');
    const vendor = item.hostname && item.label ? item.label : null;
    const seenBy = Array.isArray(item.seenBy) && item.seenBy.length > 1
      ? `seen by ${item.seenBy.join(' + ')}` : '';
    const liveness = item.responded === false ? 'not responding to the last sweep' : '';
    const latency = typeof item.sweepMs === 'number' ? fmtMs(item.sweepMs) : '';
    const secondary = [item.kind, vendor, latency, item.note, seenBy, liveness].filter(Boolean).join(' · ');
    return `<div class="arp-row"><span title="${escapeHtml(fullName)}">${escapeHtml(title)}</span><code>${escapeHtml(detail)}</code><input class="room-input" data-key="${escapeHtml(item.mac || item.ip)}"" value="${escapeHtml(item.room || '')}" placeholder="room" aria-label="Room for ${escapeHtml(title)}">${secondary ? `<small class="table-secondary">${escapeHtml(secondary)}</small>` : ''}</div>`;
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

function sparklineSvg(values, width = 54, height = 14) {
  const points = (values || []).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (points.length < 2) return '';
  const max = Math.max(...points, 1);
  const stepX = width / (points.length - 1);
  const coords = points.map((value, index) => {
    const x = (index * stepX).toFixed(1);
    const y = (height - 2 - (value / max) * (height - 4)).toFixed(1);
    return `${x},${y}`;
  });
  return `<svg class="row-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><polyline class="spark-line" points="${coords.join(' ')}"></polyline></svg>`;
}

function renderSlowest(devices) {
  const el = $('slowest-list');
  if (!el) return;
  const ranked = (devices || [])
    .filter(device => typeof device.sweepMs === 'number' && device.responded !== false)
    .sort((a, b) => b.sweepMs - a.sweepMs)
    .slice(0, 6);
  if (!ranked.length) {
    el.innerHTML = '<p class="muted-copy">No sweep results yet.</p>';
    return;
  }
  el.innerHTML = ranked.map(device => {
    const name = device.hostname || device.label || device.ip;
    const room = device.room ? ` · ${device.room}` : '';
    return `<div class="slow-row">${sparklineSvg(device.trend, 48, 12)}<span class="slow-name" title="${escapeHtml(name)}">${escapeHtml(String(name).slice(0, 18))}${escapeHtml(room)}</span><b>${escapeHtml(fmtMs(device.sweepMs))}</b></div>`;
  }).join('');
}

function renderTrendMeta(data) {
  const meta = $('trend-meta');
  if (!meta) return;
  const records = Array.isArray(data.history) ? data.history : [];
  const latest = records[records.length - 1] || {};
  const bits = [];
  if (data.publicIp) bits.push(`public IP ${data.publicIp}`);
  if (typeof latest.routerJitter === 'number') bits.push(`router jitter ${fmtMs(latest.routerJitter)}`);
  if (typeof latest.routerLoss === 'number' && latest.routerLoss > 0) bits.push(`router loss ${latest.routerLoss}%`);
  if (typeof latest.internetLoss === 'number' && latest.internetLoss > 0) bits.push(`internet loss ${latest.internetLoss}%`);
  meta.textContent = bits.join(' · ');
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
  renderUpstream(data.lldp);
  renderChanges(data.changes);
  renderPihole(data.pihole);
  renderPowerline(data.powerline);
  renderTrend(data.history, data.scan);
  renderTrendMeta(data);
  renderSlowest(data.devices);
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
  } catch (err) {
    if (err) console.error('Refresh or render failed:', err && err.message ? err.message : err);
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

function setStateLabel(id, isSet, extra = '') {
  const el = $(id);
  if (el) el.textContent = isSet ? `Set${extra ? ` · ${extra}` : ''}` : 'Not set';
}

async function openSettings() {
  const dialog = $('settings-dialog');
  dialog.showModal();
  $('settings-result').textContent = '';
  try {
    const settings = await (await fetch('/api/settings', { cache: 'no-store' })).json();
    $('settings-agent-token').value = '';
    $('settings-agent-tokens').value = '';
    $('settings-webhook').value = '';
    $('settings-pihole-token').value = '';
    $('settings-pihole-url').value = settings.pihole?.url || '';
    $('settings-subnet').value = settings.discovery?.scanSubnet || '';
    $('settings-public-ip').checked = Boolean(settings.privacy?.publicIpCheck);

    setStateLabel('settings-shared-state', settings.sensors?.sharedTokenSet);
    setStateLabel('settings-per-sensor-state', Boolean(settings.sensors?.names?.length), (settings.sensors?.names || []).join(', '));
    setStateLabel('settings-webhook-state', settings.alerts?.webhookSet, settings.alerts?.webhookHost || '');
    setStateLabel('settings-pihole-state', settings.pihole?.tokenSet, settings.pihole?.ok ? 'working' : 'saved, not answering');
    $('settings-fixed').textContent = `LLDP on ${settings.fixed?.lldpIface || 'eno1'} (${settings.fixed?.lldp ? 'on' : 'off'}), powerline capture on, change these with the container environment.`;
  } catch (err) {
    $('settings-result').textContent = `Could not read settings: ${err.message}`;
  }
}

$('open-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const body = {
    scanSubnet: $('settings-subnet').value.trim(),
    publicIpCheck: $('settings-public-ip').checked,
    piholeUrl: $('settings-pihole-url').value.trim() || null
  };
  const shared = $('settings-agent-token').value.trim();
  const perSensor = $('settings-agent-tokens').value.trim();
  const webhook = $('settings-webhook').value.trim();
  const piholeKey = $('settings-pihole-token').value.trim();
  if (shared) body.agentToken = shared;
  if (perSensor) body.agentTokens = perSensor;
  if (webhook) body.alertWebhook = webhook;
  if (piholeKey) body.piholeToken = piholeKey;

  const result = $('settings-result');
  result.textContent = 'Saving…';
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-advisor-intent': 'write' },
      cache: 'no-store',
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    result.textContent = 'Saved.';
    toast('Settings saved');
    await refresh();
    setTimeout(() => $('settings-dialog').close(), 600);
  } catch (err) {
    result.textContent = err.message;
    toast(`Could not save: ${err.message}`);
  }
});

$('pihole-open').addEventListener('click', openSettings);
$('pihole-cancel').addEventListener('click', () => { $('pihole-form').hidden = true; });

$('pihole-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch('/api/settings/pihole', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-advisor-intent': 'write' },
      cache: 'no-store',
      body: JSON.stringify({ url: $('pihole-url').value.trim(), token: $('pihole-token').value.trim() })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    $('pihole-token').value = '';
    $('pihole-form').hidden = true;
    toast(result.ok ? 'Pi-hole connected' : `Key saved, but Pi-hole said: ${(result.pihole && (result.pihole.error || 'no answer'))}`);
    await refresh();
  } catch (err) {
    toast(`Could not save the key: ${err.message}`);
  } finally {
    button.disabled = false;
  }
});

$('rooms-summary').addEventListener('click', event => {
  const pill = event.target.closest('.room-pill');
  if (!pill) return;
  const room = pill.dataset.room;
  roomFilter = room === '__all' ? null : (roomFilter === room ? null : room);
  if (latest) renderArp(latest.devices || latest.arp);
});

$('arp-list').addEventListener('change', async event => {
  const input = event.target.closest('.room-input');
  if (!input) return;
  const key = input.dataset.key;
  const room = input.value.trim();
  try {
    const response = await fetch('/api/rooms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-advisor-intent': 'write' },
      body: JSON.stringify({ key, room }),
      signal: timeoutSignal(8000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    toast(room ? `Saved ${room}` : 'Room cleared');
    await refresh();
  } catch {
    toast('Could not save that room');
  }
});

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
