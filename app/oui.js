'use strict';

// A deliberately small, curated OUI table.
//
// It is not the IEEE registry. It covers vendors a home LAN actually tends to
// contain, so a neighbour entry can say "Raspberry Pi" instead of "Unidentified
// device 1". Anything not listed stays unidentified rather than being guessed at.
// Extend it as you meet new hardware.

const VENDORS = {
  // Single-board computers
  'B8:27:EB': 'Raspberry Pi',
  'DC:A6:32': 'Raspberry Pi',
  'E4:5F:01': 'Raspberry Pi',
  'D8:3A:DD': 'Raspberry Pi',
  '2C:CF:67': 'Raspberry Pi',

  // Phones, tablets, laptops
  '00:1B:63': 'Apple',
  '00:1E:C2': 'Apple',
  '00:23:DF': 'Apple',
  '04:0C:CE': 'Apple',
  '3C:07:54': 'Apple',
  '7C:D1:C3': 'Apple',
  '8C:85:90': 'Apple',
  'A4:83:E7': 'Apple',
  'DC:A9:04': 'Apple',
  'F0:18:98': 'Apple',
  '00:1B:21': 'Intel',
  '3C:97:0E': 'Intel',
  '8C:16:45': 'Intel',
  'A4:BB:6D': 'Intel',
  '00:12:FB': 'Samsung',
  '5C:0A:5B': 'Samsung',
  '8C:77:12': 'Samsung',
  '78:1D:FA': 'Samsung',
  'E8:50:8B': 'Samsung',
  '50:8F:4C': 'Xiaomi',
  '64:09:80': 'Xiaomi',
  '78:11:DC': 'Xiaomi',
  '8C:BE:BE': 'Xiaomi',

  // Smart home and streaming
  '00:0E:58': 'Sonos',
  '48:A6:B8': 'Sonos',
  '5C:AA:FD': 'Sonos',
  '78:28:CA': 'Sonos',
  '94:9F:3E': 'Sonos',
  'B8:E9:37': 'Sonos',
  '00:17:88': 'Philips Hue',
  'D0:73:D5': 'LIFX',
  '74:58:F3': 'Blink',     // confirmed by a Blink-Mini camera on the LAN
  '64:D8:1B': 'Vestel',    // builds Toshiba/JVC/Telefunken TVs for Europe
  'DC:71:44': 'Samsung',   // confirmed by a Samsung set on the LAN
  '3C:61:05': 'Shelly',
  'C8:2B:96': 'Shelly',
  'E8:DB:84': 'Shelly',
  '10:D5:61': 'Tuya smart device',
  '18:69:D8': 'Tuya smart device',
  '68:57:2D': 'Tuya smart device',
  'D8:1F:12': 'Tuya smart device',
  '44:65:0D': 'Amazon',
  '68:37:E9': 'Amazon',
  '74:C2:46': 'Amazon',
  'F0:27:2D': 'Amazon',
  '3C:5A:B4': 'Google',
  '94:EB:2C': 'Google',
  'F4:F5:D8': 'Google',
  '54:60:09': 'Google',
  'DA:A1:19': 'Google',
  '00:04:1F': 'Sony',
  '00:19:C1': 'Sony',
  '70:9E:29': 'Sony',
  '00:09:BF': 'Nintendo',
  '98:B6:E9': 'Nintendo',
  '58:BD:A3': 'Nintendo',

  // Network gear
  '00:09:5B': 'NETGEAR',
  '20:4E:7F': 'NETGEAR',
  '2C:30:33': 'NETGEAR',
  'A0:40:A0': 'NETGEAR',
  'C0:3F:0E': 'NETGEAR',
  '50:C7:BF': 'TP-Link',
  '60:32:B1': 'TP-Link',
  '98:DA:C4': 'TP-Link',
  'EC:08:6B': 'TP-Link',
  'A4:2B:B0': 'TP-Link',
  'C0:4A:00': 'TP-Link',
  '14:CC:20': 'TP-Link',
  'B0:BE:76': 'TP-Link',   // confirmed by an HS100 plug on the LAN
  '24:5A:4C': 'Ubiquiti',
  '44:D9:E7': 'Ubiquiti',
  '68:D7:9A': 'Ubiquiti',
  '74:AC:B9': 'Ubiquiti',
  '78:8A:20': 'Ubiquiti',
  'B4:FB:E4': 'Ubiquiti',
  'DC:9F:DB': 'Ubiquiti',
  'E0:63:DA': 'Ubiquiti',
  '00:1F:C6': 'ASUSTek',
  '08:60:6E': 'ASUSTek',
  '2C:56:DC': 'ASUSTek',
  '50:46:5D': 'ASUSTek',
  '00:1B:11': 'D-Link',
  '1C:7E:E5': 'D-Link',
  '00:11:32': 'Synology',
  '90:09:D0': 'Synology',
  '00:80:77': 'Brother',
  '00:E0:FC': 'Huawei',
  '20:F3:A3': 'Huawei',

  // Chipsets and virtualisation, useful for spotting containers
  '00:E0:4C': 'Realtek NIC',
  '24:0A:C4': 'Espressif',
  '24:6F:28': 'Espressif',
  '30:AE:A4': 'Espressif',
  '5C:CF:7F': 'Espressif',
  '84:CC:A8': 'Espressif',
  '84:F3:EB': 'Espressif',
  'A4:CF:12': 'Espressif',
  'DC:4F:22': 'Espressif',
  'EC:FA:BC': 'Espressif',
  '02:42:AC': 'Docker bridge',
  '52:54:00': 'QEMU/KVM virtual',
  '08:00:27': 'VirtualBox virtual',
  '00:0C:29': 'VMware virtual',
  '00:50:56': 'VMware virtual'
};

function normaliseMac(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

// Bit 1 of the first octet marks a locally administered address. Phones rotate
// these on purpose, so an unknown vendor is expected rather than suspicious.
function isLocallyAdministered(mac) {
  const hex = normaliseMac(mac);
  if (!hex) return false;
  return (parseInt(hex.slice(0, 2), 16) & 0x02) === 0x02;
}

function vendorFor(mac) {
  const hex = normaliseMac(mac);
  if (!hex) return null;
  const prefix = hex.slice(0, 8);
  if (VENDORS[prefix]) return VENDORS[prefix];
  // Docker allocates from 02:42:xx and changes the third octet per network.
  if (hex.startsWith('02:42:')) return 'Docker bridge';
  return null;
}

function describeMac(mac) {
  const vendor = vendorFor(mac);
  if (vendor) return vendor;
  if (isLocallyAdministered(mac)) return 'Randomised MAC';
  return null;
}

module.exports = { VENDORS, normaliseMac, isLocallyAdministered, vendorFor, describeMac };
