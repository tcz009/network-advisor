# Powerline (HomePlug) — what Network Advisor can and cannot see

Powerline adapters are the one part of a home network that an IP scanner can never find. This document records how the dashboard reads them, what each field means, and what the hardware will not give up.

## Why they are invisible

A powerline adapter forwards Ethernet frames between two wall sockets. It has no IP address, does not answer ARP or ICMP, and advertises nothing over mDNS or SSDP. Its management channel is a **HomePlug management message (MME)** carried in broadcast Ethernet frames with ethertype **0x88e1** — a layer below IP.

So anything ICMP-based will never see it, and `ping 192.168.1.x` across the subnet will tell you nothing about whether powerline exists.

## How it is read

Capturing those frames needs a raw socket, and the hub deliberately runs unprivileged (`no-new-privileges`, read-only rootfs). The **sidecar** does the privileged work:

| Component | Role |
|---|---|
| `network-advisor-lldp` container | Runs as root with only `CAP_NET_RAW`; owns `plctool` and `tcpdump` |
| `plctool -i $IFACE -m` | Every 60 s, fetches network membership |
| `/lldp/powerline.txt` | Its own volume, written atomically, mounted **read-only** in the hub |
| `powerline.js` in the hub | Parses that text; the hub never opens a raw socket |
| `powerline-history.json` | Link rate per capture, capped at 240 samples |

`plctool` comes from Alpine's `open-plc-utils` package.

## What the tool reports

```
source address = DC:EF:09:66:94:40        <- the adapter on this host's interface
network->NID  = A4:3C:BC:9A:18:14:0C      <- powerline network id (shared NMK)
network->SNID = 12
network->ROLE = 0x02 (CCO)                <- central coordinator

station->MAC = DC:EF:09:66:8F:A5          <- the far adapter
station->BDA = 80:69:1A:AE:FA:D7          <- the Ethernet device behind it
station->AvgPHYDR_TX = 253 mbps Alternate
station->AvgPHYDR_RX = 177 mbps Alternate
```

- **BDA** is the bridge address: which Ethernet device hangs off that adapter. That is how the dashboard can say *"bridging the gateway"* rather than just "an adapter exists".
- **AvgPHYDR** is the average PHY rate of the link. It is not throughput. Real TCP will be well under half of it, and it fluctuates with mains noise.
- **"Alternate"** indicates the modem is running in its alternate (non-default) modulation profile.

### The shape exposed at `/api/state`

```json
"powerline": {
  "ok": true,
  "networks": [{ "nid": "A4:3C:BC:9A:18:14:0C", "snid": 12, "role": "CCO",
                 "localMac": "DC:EF:09:66:94:40", "stationCount": 1 }],
  "adapters": [
    { "mac": "DC:EF:09:66:94:40", "local": true, "txMbps": null, "rxMbps": null,
      "bda": null, "behindLabel": null, "behindIp": null },
    { "mac": "DC:EF:09:66:8F:A5", "local": false, "txMbps": 253, "rxMbps": 177,
      "bda": "80:69:1A:AE:FA:D7", "behindLabel": "_gateway", "behindIp": "192.168.1.1" }
  ],
  "bestTxMbps": 253,
  "bestRxMbps": 177,
  "trend": [{ "at": 1794856491681, "tx": 244, "rx": 209 }]
}
```

`ok: false` with an `error` means no capture exists or the interface is wrong — not that there is no powerline. A network with adapters but no response is reported as `ok: false`, since there is no way to distinguish "absent" from "unwilling".

## This installation's hardware

| | |
|---|---|
| Model | NETGEAR **PL1200** (Powerline 1200, HomePlug AV2 **MIMO**, QCA7500) — both ends identical |
| Firmware | `2.0.0.375-03-20141016` — the final release; NETGEAR shipped no update |
| NMK | random, so the segment is encrypted |
| DAK | readable on the local adapter; **all zeros (secret) on the peer** |

### What the device refuses

`plctool -I` returns the PIB header (DAK, NMK, NID, model). Anything deeper is refused without the device's DAK:

```
plctool -i eno1 -n /tmp/nvm.bin local
  Module not available in NVM or Memory (0x32): Device refused request
```

So configuration writes to the **far** adapter are not possible from the NAS side, and both ends would need to agree for most settings anyway. That is why the practical route for changing settings is a vendor utility on a PC.

## Settings that are worth touching

1. **Standby / sleep mode.** NETGEAR's FAQ says it cannot be disabled, but the Zyxel powerline utility (and TRENDnet's PowerPacket utility) drives the same QCA7500 chipset and exposes the flag. Reported to fix dropouts on PL1200/PLP1200. This is the single biggest lever: a sleeping adapter re-negotiates, which shows up as latency spikes and a rate that wanders.
2. **Socket placement.** Directly into a wall socket — not a power strip or surge protector, and not next to a motor, dimmer or large PSU.
3. **QoS.** The chip supports 802.1p classification rules; defaults are sane. Only change for a specific gaming/VoIP need.
4. **Firmware.** Nothing to do: 2.0.0.375 is final.

## Limits, stated plainly

- The rate is a **PHY average**, not a speed test and not your internet speed.
- The dashboard reports the **bridge and its speed**, never a physical room — adapters do not know where they are.
- If a device plugs into the same adapter, it appears as an ordinary IP device; only the adapter itself is visible here.
- Rates are sampled once a minute, so a brief dropout between samples is missed.
