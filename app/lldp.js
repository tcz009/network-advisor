'use strict';

// LLDP over a pcap file captured by the sidecar container.
//
// The hub itself never opens a raw socket: a small sidecar runs tcpdump with
// NET_RAW and writes /data/lldp.pcap, and this module parses it. That keeps the
// dashboard's own process unprivileged.
//
// Only the TLVs that help identify upstream equipment are decoded: chassis, port,
// system name/description, capabilities, management address, VLAN and link speed.

const fs = require('node:fs');

const LLDP_ETHERTYPE = 0x88cc;
const VLAN_ETHERTYPE = 0x8100;
const MAX_PCAP_SEARCH = 4096;   // reasonable ceiling on records examined

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readUInt16(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

// Returns the raw ethernet frames in a capture, or [] for anything unreadable.
function pcapFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return [];
  const magic = buffer.readUInt32BE(0);
  let littleEndian;
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) littleEndian = false;
  else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) littleEndian = true;
  else return [];

  const frames = [];
  let offset = 24;
  for (let i = 0; i < MAX_PCAP_SEARCH && offset + 16 <= buffer.length; i++) {
    const includedLength = readUInt32(buffer, offset + 8, littleEndian);
    offset += 16;
    if (includedLength <= 0 || offset + includedLength > buffer.length) break;
    frames.push(buffer.subarray(offset, offset + includedLength));
    offset += includedLength;
  }
  return frames;
}

function ethernetPayload(frame) {
  if (frame.length < 14) return null;
  let offset = 12;
  let ethertype = frame.readUInt16BE(offset);
  offset += 2;
  while (ethertype === VLAN_ETHERTYPE && offset + 4 <= frame.length) {
    ethertype = frame.readUInt16BE(offset + 2);
    offset += 4;
  }
  if (ethertype !== LLDP_ETHERTYPE) return null;
  return { source: [...frame.subarray(6, 12)].map(b => b.toString(16).padStart(2, '0')).join(':'), payload: frame.subarray(offset) };
}

function macFromBytes(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(':');
}

function printable(bytes) {
  return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '').trim();
}

const CAPABILITY_FLAGS = [
  [0x0001, 'other'], [0x0002, 'repeater'], [0x0004, 'bridge'], [0x0008, 'WLAN AP'],
  [0x0010, 'router'], [0x0020, 'telephone'], [0x0040, 'DOCSIS'], [0x0080, 'station'],
  [0x0100, 'C-VLAN'], [0x0200, 'S-VLAN'], [0x0400, 'two-port MAC relay']
];

const MAU_SPEEDS = {
  0x001e: '1 Gb/s',
  0x001d: '100 Mb/s',
  0x001b: '10 Mb/s'
};

function decodeLldp(payload, source) {
  const neighbour = {
    source,
    chassisId: null,
    portId: null,
    portDescription: null,
    systemName: null,
    systemDescription: null,
    managementAddress: null,
    capabilities: [],
    vlan: null,
    speed: null,
    ttlSeconds: null
  };

  let offset = 0;
  while (offset + 2 <= payload.length) {
    const header = payload.readUInt16BE(offset);
    const type = (header >> 9) & 0x7f;
    const length = header & 0x1ff;
    const start = offset + 2;
    const end = start + length;
    if (end > payload.length) break;
    const value = payload.subarray(start, end);

    if (type === 0) break;                       // end of LLDPDU
    if (type === 1 && length >= 2) {             // chassis id
      const subtype = value[0];
      if (subtype === 4 && length >= 7) neighbour.chassisId = macFromBytes(value.subarray(1, 7));
      else neighbour.chassisId = printable(value.subarray(1));
    } else if (type === 2 && length >= 2) {      // port id
      const subtype = value[0];
      if (subtype === 3 && length >= 7) neighbour.portId = macFromBytes(value.subarray(1, 7));
      else neighbour.portId = printable(value.subarray(1));
    } else if (type === 3 && length === 2) {
      neighbour.ttlSeconds = value.readUInt16BE(0);
    } else if (type === 4) {
      neighbour.portDescription = printable(value);
    } else if (type === 5) {
      neighbour.systemName = printable(value);
    } else if (type === 6) {
      neighbour.systemDescription = printable(value);
    } else if (type === 7 && length >= 4) {
      const caps = value.readUInt16BE(2);
      neighbour.capabilities = CAPABILITY_FLAGS.filter(([bit]) => caps & bit).map(([, name]) => name);
    } else if (type === 8 && length >= 6) {
      const subtype = value[1];
      if (subtype === 1 && length >= 6) neighbour.managementAddress = [...value.subarray(2, 6)].join('.');
    } else if (type === 127 && length >= 4) {
      const oui = value.readUIntBE(0, 3);
      const sub = value[3];
      if (oui === 0x0080c2 && sub === 3 && length >= 6) {
        const vlanId = value.readUInt16BE(4);
        const name = printable(value.subarray(6));
        neighbour.vlan = name ? `${name} (id ${vlanId})` : `id ${vlanId}`;
      }
      if (oui === 0x00120f && sub === 1 && length >= 9) {
        // [0..2] OUI, [3] subtype, [4] autoneg status, [5..6] PMD caps, [7..8] MAU type
        const mau = value.readUInt16BE(7);
        neighbour.speed = MAU_SPEEDS[mau] || null;
      }
    }
    offset = end;
  }
  return neighbour;
}

function parseLldpCapture(buffer) {
  const neighbours = new Map();
  for (const frame of pcapFrames(buffer)) {
    const link = ethernetPayload(frame);
    if (!link) continue;
    const decoded = decodeLldp(link.payload, link.source);
    if (!decoded.chassisId) continue;
    neighbours.set(decoded.chassisId, decoded);   // a later advertisement wins
  }
  return [...neighbours.values()];
}

// Reads an on-disk capture, remembering the last result per mtime.
function readCapture(file) {
  try {
    const stat = fs.statSync(file);
    return { ok: true, buffer: fs.readFileSync(file), mtime: stat.mtimeMs };
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'no capture file' : err.message };
  }
}

module.exports = { parseLldpCapture, decodeLldp, pcapFrames, ethernetPayload, readCapture };
