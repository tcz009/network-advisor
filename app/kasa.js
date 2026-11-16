'use strict';

// Minimal TP-Link Kasa discovery.
//
// Kasa plugs (HS100/HS110/KP115 and friends) speak a small JSON protocol over
// TCP 9999: a 4-byte big-endian length followed by AES-128-CBC ciphertext in
// autokey mode, with the key and IV both md5(16 bytes of 0x2b).
//
// Two levels of confidence are reported, because being wrong is worse than being
// vague:
//   portOpen  - something accepted a connection on 9999
//   confirmed - the device answered a get_sysinfo request with a valid system
//               block, so we know it is a Kasa device rather than a coincidental
//               listener on that port.

const net = require('node:net');
const crypto = require('node:crypto');

const KEY = crypto.createHash('md5').update(Buffer.alloc(16, 0x2b)).digest();
const IV = KEY;
const MAX_BODY = 8 * 1024;

function blockCipher(data, key, iv, decrypt) {
  const cipher = decrypt
    ? crypto.createDecipheriv('aes-128-cbc', key, iv)
    : crypto.createCipheriv('aes-128-cbc', key, iv);
  // Kasa pads with zero bytes itself; PKCS#7 padding would add a whole block.
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function padTo16(buffer) {
  const remainder = buffer.length % 16;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(16 - remainder)]);
}

// Autokey mode: each block is CBC'd with the previous ciphertext block as IV.
function encryptPayload(plain) {
  const padded = padTo16(Buffer.from(plain, 'utf8'));
  const blocks = [];
  let previous = IV;
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = blockCipher(padded.subarray(offset, offset + 16), KEY, previous, false);
    blocks.push(block);
    previous = block;
  }
  return Buffer.concat(blocks);
}

function decryptPayload(cipherText) {
  if (cipherText.length < 16 || cipherText.length % 16 !== 0) throw new Error('bad cipher length');
  const blocks = [];
  let previous = IV;
  for (let offset = 0; offset < cipherText.length; offset += 16) {
    const block = cipherText.subarray(offset, offset + 16);
    blocks.push(blockCipher(block, KEY, previous, true));
    previous = block;
  }
  return Buffer.concat(blocks).toString('utf8').replace(/\0+$/, '');
}

function frame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

const REQUEST = frame(encryptPayload(JSON.stringify({ system: { get_sysinfo: {} } })));

// Returns {portOpen, confirmed, model, alias, error}. Never rejects.
function probeKasa(ip, { timeout = 900, port = 9999 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let portOpen = false;
    const socket = new net.Socket();

    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ portOpen, confirmed: false, model: null, alias: null, error: null, ...result });
    };

    socket.setTimeout(timeout);
    socket.once('timeout', () => finish({ error: portOpen ? 'timeout' : 'connect timeout' }));
    socket.once('error', err => finish({ error: err.code || err.message }));
    socket.once('connect', () => {
      portOpen = true;
      socket.write(REQUEST);
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length <= 0 || length > MAX_BODY || length % 16 !== 0) return finish({ error: 'unexpected framing' });
      if (buffer.length < 4 + length) return;
      try {
        const payload = JSON.parse(decryptPayload(buffer.subarray(4, 4 + length)));
        const sysinfo = payload && payload.system && payload.system.get_sysinfo;
        if (sysinfo) {
          finish({
            confirmed: true,
            model: typeof sysinfo.model === 'string' ? sysinfo.model.slice(0, 40) : null,
            alias: typeof sysinfo.alias === 'string' ? sysinfo.alias.slice(0, 60) : null
          });
        } else {
          finish({ error: 'no system block' });
        }
      } catch {
        finish({ error: 'undecryptable reply' });
      }
    });
    socket.connect(port, ip);
  });
}

async function discoverKasa(hosts, { concurrency = 32, timeout = 900, port = 9999 } = {}) {
  const queue = [...hosts];
  const found = [];
  const worker = async () => {
    while (queue.length) {
      const ip = queue.shift();
      const result = await probeKasa(ip, { timeout, port });
      if (result.confirmed || result.portOpen) {
        found.push({
          ip,
          confirmed: result.confirmed,
          model: result.model,
          alias: result.alias,
          label: result.confirmed
            ? (result.alias || result.model || 'Kasa device')
            : 'TCP 9999 open (unconfirmed)'
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length || 1) }, worker));
  return found;
}

module.exports = { probeKasa, discoverKasa, encryptPayload, decryptPayload, frame };
