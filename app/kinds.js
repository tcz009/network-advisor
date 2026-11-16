'use strict';

// Classify a LAN device from what the network actually tells us: its hostname,
// the vendor label from the MAC table, or a Kasa model string. Nothing here is
// inferred from traffic patterns, and anything unrecognised stays null rather
// than being guessed at.

const RULES = [
  { kind: 'camera', pattern: /blink|wyze|reolink|hikvision|dahua|arlo|ring-?cam/i },
  { kind: 'doorbell', pattern: /doorbell/i },
  { kind: 'plug', pattern: /\bhs1\d\d\b|\bkp1\d\d\b|kasa|tapo|shelly|smart ?plug|wemo/i },
  { kind: 'bulb', pattern: /lifx|hue|tradfri|bulb|lamp/i },
  { kind: 'speaker', pattern: /sonos|homepod|echo|alexa/i },
  { kind: 'media player', pattern: /shield|roku|fire ?tv|chromecast|apple ?tv|kodi/i },
  { kind: 'IR blaster', pattern: /rmmini|rm ?mini|broadlink/i },
  { kind: 'watch', pattern: /watch/i },
  { kind: 'phone', pattern: /iphone|android|pixel|galaxy|oneplus/i },
  { kind: 'computer', pattern: /macbook|imac|mac ?mini|thinkpad|desktop|laptop/i },
  { kind: 'printer', pattern: /printer|brother|hp-?officejet|epson/i },
  { kind: 'nas', pattern: /nas|synology|qnap|openmediavault/i },
  { kind: 'sensor', pattern: /sensor|thermostat|hive|nest/i },
  { kind: 'router', pattern: /router|gateway|hub|community01670/i }
];

// Ordered checks: a Kasa model beats a hostname guess, and a hostname beats the
// vendor label (a TP-Link MAC could be a plug or a router).
const SERVICE_KINDS = [
  { kind: 'speaker', pattern: /airplay|raop|sonos/i },
  { kind: 'media player', pattern: /googlecast|dial/i },
  { kind: 'printer', pattern: /ipp|ipps|printer/i },
  { kind: 'camera', pattern: /camera|rtsp/i },
  { kind: 'hub', pattern: /hue|homekit|hap/i }
];

function classifyDevice({ hostname = '', label = '', model = '', services = [], upnpServer = '' } = {}) {
  const fromModel = String(model || '');
  // Kasa numbering: HS1xx and KP1xx are plugs, HS2xx are wall switches.
  if (/\bHS2\d{2}\b/i.test(fromModel)) return { kind: 'switch', evidence: `model ${fromModel}` };
  if (/\bHS1\d{2}\b|\bKP1\d{2}\b/i.test(fromModel)) return { kind: 'plug', evidence: `model ${fromModel}` };
  if (/blink/i.test(fromModel)) return { kind: 'camera', evidence: `model ${fromModel}` };

  for (const field of ['hostname', 'label']) {
    const value = field === 'hostname' ? hostname : label;
    if (!value) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(String(value))) return { kind: rule.kind, evidence: `${field} ${value}` };
    }
  }
  // Broadcast hints are the most trustworthy signal left: a device that says
  // "Sonos" over SSDP is a speaker regardless of its hostname.
  const server = String(upnpServer || '');
  if (/sonos/i.test(server)) return { kind: 'speaker', evidence: 'ssdp Sonos' };
  if (/printer|cups|ipp/i.test(server)) return { kind: 'printer', evidence: 'ssdp printer' };

  const announced = (services || []).map(service => String(service).toLowerCase());
  for (const rule of SERVICE_KINDS) {
    const hit = announced.find(service => rule.pattern.test(service));
    if (hit) return { kind: rule.kind, evidence: `mdns ${hit}` };
  }
  return null;
}

module.exports = { classifyDevice, RULES };
