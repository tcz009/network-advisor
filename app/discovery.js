'use strict';

// SSDP and mDNS discovery: the two broadcast protocols almost every consumer
// device answers. They exist here because plenty of hardware ignores ICMP
// entirely — a sleeping phone, a printer, a TV in standby — yet still announces
// itself over multicast.
//
// Both functions are self-contained and always resolve: a silent network is a
// normal result, not an error.

const dgram = require('node:dgram');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

/* ------------------------------------------------------------------- SSDP */

function parseSsdpHeaders(text) {
  const headers = Object.create(null);
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const split = line.indexOf(':');
    if (split < 1) continue;
    headers[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
  }
  return headers;
}

function ssdpDiscover({ timeout = 2000 } = {}) {
  return new Promise(resolve => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()].map(entry => ({ ...entry, serviceTypes: [...entry.serviceTypes] })));
    };

    socket.on('error', finish);
    socket.on('message', (message, rinfo) => {
      const text = message.toString('utf8');
      if (!/^HTTP\/1\.1 200/i.test(text)) return;
      const headers = parseSsdpHeaders(text);
      const entry = found.get(rinfo.address) || {
        ip: rinfo.address,
        server: null,
        location: null,
        serviceTypes: new Set()
      };
      if (headers.server) entry.server = headers.server.slice(0, 120);
      if (headers.location) entry.location = headers.location.slice(0, 200);
      if (headers.st) entry.serviceTypes.add(headers.st.slice(0, 120));
      found.set(rinfo.address, entry);
    });

    socket.bind(() => {
      const query = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n'
      );
      const send = () => {
        try { socket.send(query, SSDP_PORT, SSDP_ADDRESS, () => {}); } catch { /* closing */ }
      };
      send();
      setTimeout(send, 350);
      setTimeout(send, 900);
    });

    setTimeout(finish, timeout);
  });
}

/* ------------------------------------------------------------------- mDNS */

const MDNS_QUERIES = [
  '_services._dns-sd._udp.local',
  '_http._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_googlecast._tcp.local',
  '_ipp._tcp.local',
  '_sonos._tcp.local',
  '_hap._tcp.local'
];

function encodeDnsName(name) {
  const parts = String(name).split('.').filter(Boolean);
  const buffers = parts.map(part => {
    const label = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([label.length]), label]);
  });
  return Buffer.concat([...buffers, Buffer.from([0])]);
}

function buildMdnsQuery(names) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);                    // id 0 for mDNS
  header.writeUInt16BE(0, 2);                    // flags: standard query
  header.writeUInt16BE(names.length, 4);         // qdcount
  const questions = names.map(name => {
    const encoded = encodeDnsName(name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(12, 0);                   // PTR
    tail.writeUInt16BE(1, 2);                    // class IN
    return Buffer.concat([encoded, tail]);
  });
  return Buffer.concat([header, ...questions]);
}

function readDnsName(buffer, offset) {
  const labels = [];
  let position = offset;
  let jumps = 0;
  let next = null;
  while (position < buffer.length) {
    const length = buffer[position];
    if (length === 0) { position += 1; break; }
    if ((length & 0xc0) === 0xc0) {
      if (next === null) next = position + 2;
      position = ((length & 0x3f) << 8) | buffer[position + 1];
      if (++jumps > 8) break;
      continue;
    }
    labels.push(buffer.subarray(position + 1, position + 1 + length).toString('utf8'));
    position += 1 + length;
  }
  return { name: labels.join('.'), next: next === null ? position : next };
}

// Parses the answer section well enough to recover service types and addresses.
function parseMdnsResponse(buffer) {
  if (buffer.length < 12) return null;
  const questions = buffer.readUInt16BE(4);
  const answers = buffer.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questions; i++) {
    const { next } = readDnsName(buffer, offset);
    offset = next + 4;
    if (offset > buffer.length) return null;
  }
  const records = [];
  for (let i = 0; i < answers; i++) {
    const { name, next } = readDnsName(buffer, offset);
    offset = next;
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 8);
    const dataStart = offset + 10;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break;
    let value = null;
    if (type === 12) value = readDnsName(buffer, dataStart).name;          // PTR
    else if (type === 1 && length === 4) value = [...buffer.subarray(dataStart, dataEnd)].join('.');
    else if (type === 33) value = readDnsName(buffer, dataStart + 6).name; // SRV target
    else if (type === 16) value = buffer.subarray(dataStart, dataEnd).toString('utf8');
    records.push({ name, type, value });
    offset = dataEnd;
  }
  return records;
}

function mdnsDiscover({ timeout = 2000 } = {}) {
  return new Promise(resolve => {
    const byIp = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const note = (ip, field, value) => {
      const entry = byIp.get(ip) || { ip, services: new Set(), name: null };
      if (field === 'service' && value) entry.services.add(value);
      if (field === 'name' && value && !entry.name) entry.name = value;
      byIp.set(ip, entry);
    };

    const finish = () => {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve([...byIp.values()].map(entry => ({
        ip: entry.ip,
        name: entry.name,
        services: [...entry.services]
      })));
    };

    socket.on('error', finish);
    socket.on('message', (message, rinfo) => {
      const records = parseMdnsResponse(message);
      if (!records) return;
      for (const record of records) {
        if (record.type === 12 && record.value) {
          // "_http._tcp.local" -> "http"
          const service = record.value.replace(/\.local\.?$/, '').replace(/^_/, '').replace(/\._(tcp|udp)$/, '');
          if (service && !service.includes('_services')) note(rinfo.address, 'service', service);
        }
        if (record.type === 1 && record.value) note(rinfo.address, 'ip', record.value);
        if ((record.type === 33 || record.type === 12) && record.name && !record.name.includes('_')) {
          note(rinfo.address, 'name', record.name.replace(/\.local\.?$/, ''));
        }
      }
    });

    socket.bind(() => {
      const query = buildMdnsQuery(MDNS_QUERIES);
      try {
        socket.setMulticastTTL(255);
        socket.addMembership(MDNS_ADDRESS);
      } catch { /* not fatal: we still send queries */ }
      const send = () => {
        try { socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {}); } catch { /* closing */ }
      };
      send();
      setTimeout(send, 500);
    });

    setTimeout(finish, timeout);
  });
}

/* --------------------------------------------------------------- combined */

// Runs both protocols and returns { byIp: Map<ip, {upnp, mdns}>, hosts: [...] }.
async function discoverDevices({ timeout = 2000 } = {}) {
  const [ssdp, mdns] = await Promise.all([
    ssdpDiscover({ timeout }).catch(() => []),
    mdnsDiscover({ timeout }).catch(() => [])
  ]);

  const byIp = new Map();
  for (const entry of ssdp) {
    byIp.set(entry.ip, { ip: entry.ip, upnp: { server: entry.server, location: entry.location, serviceTypes: entry.serviceTypes }, mdns: null });
  }
  for (const entry of mdns) {
    const existing = byIp.get(entry.ip) || { ip: entry.ip, upnp: null, mdns: null };
    existing.mdns = { name: entry.name, services: entry.services };
    byIp.set(entry.ip, existing);
  }
  return { byIp, hosts: [...byIp.values()] };
}

module.exports = {
  ssdpDiscover,
  mdnsDiscover,
  discoverDevices,
  parseSsdpHeaders,
  parseMdnsResponse,
  buildMdnsQuery,
  encodeDnsName,
  readDnsName
};
