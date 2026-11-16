'use strict';

// Powerline (HomePlug AV/AV2) topology, read from `plctool -m`.
//
// Powerline adapters are invisible to an IP scan: they forward Ethernet frames
// and answer only to HomePlug management messages on ethertype 0x88e1. The
// sidecar runs plctool to fetch the network membership, which lists each station,
// the Ethernet device behind it (BDA) and the PHY rate of the link.
//
// What this cannot tell you is the physical socket an adapter is in — only that
// two adapters are bridged and how fast that bridge is.

function parsePlctool(text) {
  const source = String(text || '');
  const networks = [];
  let network = null;
  let station = null;

  const finishStation = () => {
    if (station && network) network.stations.push(station);
    station = null;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const sourceMatch = line.match(/^source address\s*=\s*([0-9A-F:]{17})/i);
    if (sourceMatch) {
      finishStation();
      if (network) networks.push(network);
      network = { nid: null, snid: null, localMac: sourceMatch[1].toUpperCase(), stations: [] };
      continue;
    }
    if (!network) continue;

    const nid = line.match(/^network->NID\s*=\s*([0-9A-F:]+)/i);
    if (nid) { network.nid = nid[1].toUpperCase(); continue; }

    const snid = line.match(/^network->SNID\s*=\s*(\d+)/i);
    if (snid) { network.snid = Number(snid[1]); continue; }

    const role = line.match(/^network->ROLE\s*=\s*0x[0-9A-F]+\s*\((\w+)\)/i);
    if (role) { network.role = role[1].toUpperCase(); continue; }

    const mac = line.match(/^station->MAC\s*=\s*([0-9A-F:]{17})/i);
    if (mac) {
      finishStation();
      station = { mac: mac[1].toUpperCase(), bda: null, tei: null, txMbps: null, rxMbps: null };
      continue;
    }
    if (!station) continue;

    const bda = line.match(/^station->BDA\s*=\s*([0-9A-F:]{17})/i);
    if (bda) { station.bda = bda[1].toUpperCase(); continue; }

    const tei = line.match(/^station->TEI\s*=\s*(\d+)/i);
    if (tei) { station.tei = Number(tei[1]); continue; }

    const tx = line.match(/^station->AvgPHYDR_TX\s*=\s*(\d+)\s*mbps/i);
    if (tx) { station.txMbps = Number(tx[1]); continue; }

    const rx = line.match(/^station->AvgPHYDR_RX\s*=\s*(\d+)\s*mbps/i);
    if (rx) { station.rxMbps = Number(rx[1]); continue; }
  }

  finishStation();
  if (network) networks.push(network);

  // The local adapter is the one issuing the request; report the bridged pairs.
  const adapters = [];
  for (const net of networks) {
    adapters.push({
      mac: net.localMac,
      bda: null,
      local: true,
      txMbps: null,
      rxMbps: null,
      nid: net.nid
    });
    for (const entry of net.stations) {
      adapters.push({
        mac: entry.mac,
        bda: entry.bda,
        local: false,
        txMbps: entry.txMbps,
        rxMbps: entry.rxMbps,
        nid: net.nid
      });
    }
  }

  // A station whose BDA matches the local adapter's own MAC is the peer we
  // already know about.
  return {
    ok: networks.length > 0,
    networks: networks.map(net => ({
      nid: net.nid,
      snid: net.snid,
      role: net.role || null,
      localMac: net.localMac,
      stationCount: net.stations.length
    })),
    adapters,
    // The fastest link determines what the powerline segment can carry.
    bestTxMbps: adapters.reduce((best, a) => Math.max(best, a.txMbps || 0), 0) || null,
    bestRxMbps: adapters.reduce((best, a) => Math.max(best, a.rxMbps || 0), 0) || null
  };
}

module.exports = { parsePlctool };
