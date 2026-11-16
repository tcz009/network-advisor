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
function classifyDevice({ hostname = '', label = '', model = '' } = {}) {
  const fromModel = String(model || '');
  if (/\bHS\d{3}\b|\bKP\d{3}\b/i.test(fromModel)) return { kind: 'plug', evidence: `model ${fromModel}` };
  if (/blink/i.test(fromModel)) return { kind: 'camera', evidence: `model ${fromModel}` };

  for (const field of ['hostname', 'label']) {
    const value = field === 'hostname' ? hostname : label;
    if (!value) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(String(value))) return { kind: rule.kind, evidence: `${field} ${value}` };
    }
  }
  return null;
}

module.exports = { classifyDevice, RULES };
