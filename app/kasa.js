'use strict';

// TP-Link Kasa discovery over the legacy local protocol on TCP 9999.
//
// Framing: a 4-byte big-endian length, then the payload XOR-encrypted with a
// rolling key seeded at 171. Verified against python-kasa's XorEncryption
// (kasa/transports/xortransport.py):
//
//   encrypt: key = 171; for b in plain: key ^= b; out.append(key)
//   decrypt: key = 171; for b in cipher: out.append(key ^ b); key = b
//
// (An earlier version of this file implemented an AES autokey scheme; that is a
// different protocol and the device simply ignored it.)
//
// Two levels of confidence are reported, because being wrong is worse than being
// vague:
//   portOpen  - something accepted a connection on 9999
//   confirmed - the device answered get_sysinfo with a valid system block

const net = require('node:net');

const INITIAL_VECTOR = 171;
const MAX_BODY = 8 * 1024;

function encryptPayload(plain) {
  const input = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const output = Buffer.alloc(input.length);
  let key = INITIAL_VECTOR;
  for (let i = 0; i < input.length; i++) {
    key ^= input[i];
    output[i] = key;
  }
  return output;
}

function decryptPayload(cipherText) {
  const output = Buffer.alloc(cipherText.length);
  let key = INITIAL_VECTOR;
  for (let i = 0; i < cipherText.length; i++) {
    output[i] = key ^ cipherText[i];
    key = cipherText[i];
  }
  return output.toString('utf8').replace(/\0+$/, '');
}

// The length covers the plaintext, which is the same size as the ciphertext.
function frame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : encryptPayload(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

const REQUEST = frame(JSON.stringify({ system: { get_sysinfo: {} } }));

// Returns {portOpen, confirmed, model, alias, error}. Never rejects.
function probeKasa(ip, { timeout = 900, port = 9999 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let portOpen = false;
    const socket = new net.Socket();

    // A socket timeout does not fire while a connect is still pending, so a
    // dead host used to hang the probe (and therefore the whole sweep) forever.
    const deadline = setTimeout(() => finish({ error: portOpen ? 'no reply' : 'connect timeout' }), timeout);

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve({ portOpen, confirmed: false, model: null, alias: null, error: null, ...result });
    };

    socket.once('error', err => finish({ error: err.code || err.message }));
    socket.once('connect', () => {
      portOpen = true;
      socket.write(REQUEST);
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length <= 0 || length > MAX_BODY) return finish({ error: 'unexpected framing' });
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
