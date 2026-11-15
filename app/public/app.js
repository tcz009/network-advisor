const $ = (id) => document.getElementById(id);
const storageKey = 'network-advisor-device-v1';
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
function saveIdentity() {
  state.name = $('device-name').value.trim() || detectDevice();
  state.connection = $('connection-type').value;
  persistIdentity();
  postNode();
  toast('Device details saved to the NAS');
}
function persistIdentity() {
  localStorage.setItem(storageKey, JSON.stringify({ id: state.id, name: state.name, connection: state.connection, downMbps: state.downMbps, upMbps: state.upMbps, speedCheckedAt: state.speedCheckedAt }));
}
async function postNode() {
  try {
    await fetch('/api/nodes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ id: state.id, name: state.name, connection: state.connection, deviceType: detectDevice(), browserRttMs: state.rtt, downMbps: state.downMbps, upMbps: state.upMbps, speedCheckedAt: state.speedCheckedAt })
    });
  } catch { /* offline or the NAS is restarting */ }
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
  const left = sorted[0]; const right = sorted[1];
  renderMapClient('client-left', left, 'Open dashboard on phone');
  renderMapClient('client-right', right, 'Open dashboard on Mac');
  const extra = Math.max(0, sorted.length - 2);
  $('map-extra').textContent = extra ? ` · ${extra} more in device list` : '';
  $('nodes-table').innerHTML = sorted.length ? sorted.map(node => `<tr><td><div class="device-cell"><span class="device-dot">${node.deviceType?.includes('Mac') || node.deviceType?.includes('PC') ? '▱' : '▯'}</span><div><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.deviceType || 'Device')}</small></div></div></td><td>${escapeHtml(node.connection || 'Unknown')}<small class="table-secondary">Set on device</small></td><td>${fmtMs(node.browserRttMs)}<small class="table-secondary">Device-to-NAS response</small><small class="table-secondary">↓ ${fmtMbps(node.downMbps)} &nbsp; ↑ ${fmtMbps(node.upMbps)}${node.speedCheckedAt ? ` · checked ${timeAgo(new Date(node.speedCheckedAt).getTime())}` : ' · not measured'}</small></td><td>${timeAgo(node.lastSeen)}</td><td><span class="${node.online ? 'online-badge' : 'offline-badge'}">${node.online ? 'ONLINE' : 'OFFLINE'}</span></td></tr>`).join('') : '<tr><td class="empty-row" colspan="5">Open this page on your phone or MacBook to add it to the map.</td></tr>';
}
function renderMapClient(id, node, placeholder) {
  const el = $(id);
  if (!node) {
    el.querySelector('.client-name').textContent = 'Waiting for device';
    el.querySelector('.client-rtt').textContent = placeholder;
    return;
  }
  el.querySelector('.client-name').textContent = node.name;
  const speedAge = node.speedCheckedAt ? `local speed ${timeAgo(new Date(node.speedCheckedAt).getTime())}` : 'local speed not measured';
  const localSpeed = node.downMbps == null ? 'local speed not measured' : speedAge;
  el.querySelector('.client-rtt').textContent = `${node.online ? `to NAS ${fmtMs(node.browserRttMs)}` : 'Last seen'} · ${localSpeed}`;
}
function renderArp(arp) {
  const rows = arp || [];
  setMetric('seen-count', rows.length, 'devices');
  $('arp-list').innerHTML = rows.length ? rows.slice(0, 12).map((item, index) => `<div class="arp-row"><span>Unidentified device ${index + 1}</span><code>${escapeHtml(item.ip)} · ${escapeHtml(item.mac)}</code></div>`).join('') : '<p class="muted-copy">No recent neighbour entries. Devices appear here after the NAS has communicated with them.</p>';
}
function render(data) {
  $('connection-status').textContent = 'NAS ONLINE';
  $('connection-indicator').classList.remove('offline');
  renderNodes(data.nodes);
  renderArp(data.arp);
  renderFindings(data);
  const check = data.check;
  if (check) {
    setMetric('router-rtt', check.router?.avgMs == null ? '—' : Number(check.router.avgMs).toFixed(Number(check.router.avgMs) < 10 ? 1 : 0), 'ms');
    setMetric('internet-rtt', check.internet?.avgMs == null ? '—' : Number(check.internet.avgMs).toFixed(Number(check.internet.avgMs) < 10 ? 1 : 0), 'ms');
    $('router-foot').textContent = check.gateway ? `${check.gateway} · ${check.router?.lossPct ?? '—'}% packet loss` : 'No gateway detected';
    $('internet-foot').textContent = `${check.target} · response time, not throughput`;
    $('map-router').textContent = check.gateway ? `${check.gateway} · ${fmtMs(check.router?.avgMs)}` : 'Gateway not found';
    $('map-internet').textContent = check.internet?.avgMs == null ? 'No ping reply' : `${fmtMs(check.internet.avgMs)} average response`;
    $('last-check').textContent = new Date(check.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('map-footer-time').textContent = `Last NAS check ${timeAgo(new Date(check.checkedAt).getTime())}`;
  }
}
async function refresh() {
  try {
    const response = await fetch(`/api/state?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('NAS not responding');
    render(await response.json());
  } catch {
    $('connection-status').textContent = 'NAS NOT REACHABLE';
    $('connection-indicator').classList.add('offline');
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
    const [nasResponse, local] = await Promise.all([
      fetch('/api/check', { method: 'POST', cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('NAS check failed'); return response.json(); }),
      measureLocalTransfer()
    ]);
    await postNode();
    await refresh();
    toast(`Checks complete · this device ${fmtMbps(local.downMbps)} down, ${fmtMbps(local.upMbps)} up`);
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
$('save-device').addEventListener('click', saveIdentity);
$('device-name').addEventListener('keydown', event => { if (event.key === 'Enter') saveIdentity(); });
$('run-check').addEventListener('click', runChecks);
postNode();
pulse().then(refresh);
setInterval(pulse, 9000);
setInterval(refresh, 7000);
