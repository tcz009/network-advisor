# Integrating Network Advisor into Control Centre — handover spec

**Status:** proposal only. Nothing in this document has been applied to Control Centre.
Network Advisor (NA) lives in this repository and is maintained separately; the CC
owner implements any integration on their side.

Written against NA `0.2.0` on `main`. Point CC at `main` rather than a branch.

## What changed since the first version of this document

The endpoint still returns one `/api/state` payload, but a device now carries much
more than an address, and there are new routes:

| Change | Detail |
|---|---|
| `ip`, `mac`, `hostname`, `label`, `seenBy` | unchanged |
| **`kind`** | device type: `camera`, `plug`, `switch`, `speaker`, `bulb`, `media player`, `IR blaster`, `watch`, `phone`, `computer`, `printer`, `NAS`, `DNS server`, `access point`, `router`, or `null` |
| **`room`** | operator-assigned room, or `null` |
| **`responded` / `sweepMs`** | whether the last sweep got a reply, and its round-trip in ms; absent until a sweep has run |
| **`kasa`** | `{confirmed, model, alias}` for TP-Link Kasa devices found on TCP 9999 |
| **`mdns` / `upnp`** | broadcast identity: mDNS name and service types, SSDP server string |
| **`note`** | operator note (`DEVICE_NOTES`) |
| **`PUT /api/rooms`** | writes a room, `{key, room}` where key is a MAC or an address |

Read-only consumers can ignore all of it; the fields are additive. A sweep now
takes about 11 seconds rather than 8, because it also probes TCP 9999 and listens
for SSDP/mDNS.

---

## 1. What NA is

A read-only LAN dashboard that runs on the NAS (`network-advisor` container, host
networking, port 8090) and answers "is the local network healthy, and what is on it".

It reads its own `/proc/net/route` and `/proc/net/arp`, pings its default gateway and a
public target, resolves one hostname, and merges neighbour tables reported by small
agents on three Raspberry Pis. It stores device labels and a rolling check history in a
Docker volume. It has **no authentication and no TLS** and is intended for a trusted LAN
only. It never writes outside its own data volume.

---

## 2. The endpoint CC would call

CC runs host-networked on the same NAS, so loopback is enough:

```
GET http://127.0.0.1:8090/api/state
```

Route methods matter — the table below marks the ones that change state:

| Route | Purpose |
|---|---|
| `/api/state` | Everything below in one payload; triggers a background check if the last one is older than 60 s |
| `/api/agents` | Sensors only |
| `/api/history` | Rolling check records (max 288) |
| `/api/pulse` | `{"at": <epoch ms>}` — cheap liveness probe, no side effects |
| `/api/scan` | `POST`, active ICMP sweep of `SCAN_SUBNET` if enabled; returns 200 with `enabled:false` when off |
| `/api/check` | `POST`, runs a check and returns it |
| `/api/nodes` | `POST`, registers a browser device |
| `/api/nodes/<id>` | `DELETE`, requires an `x-advisor-intent: delete` header |
| `/api/agents/report` | `POST`, agent intake, token required |
| `/api/rooms` | `GET` returns `{mac-or-ip: room}`; `PUT` sets one, requires `x-advisor-intent: write` |

Recommended for a collector: `/api/state`, polled every 60 s with a **20 s timeout**. A
sweep takes about 11 s, so anything under 15 s will time out on the polls that follow one.

---

## 3. Response contract

Only the fields CC is likely to use are listed. Everything is JSON; no field is ever
omitted, but nested values may be `null`.

```jsonc
{
  "app": "Network Advisor",
  "version": "0.2.0",
  "host": "thinkomv",
  "addresses": ["192.168.1.179"],          // hub's own IPv4 addresses
  "gateway": "192.168.1.1",                // LAN default route, null if none
  "iface": "eno1",
  "load": { "load1": 2.29, "cores": 4, "ratio": 0.57, "busy": false },

  // Beside the payload, not inside it: `check` stays null until a result exists.
  "checkMeta": { "ageMs": 4200, "stale": false, "running": false },
  "sweep": { "startedAt": 1794831940811, "finishedAt": 1794831950811, "running": false, "enabled": true },

  "check": {                               // null until the first check completes
    "checkedAt": "2026-11-16T08:37:59.334Z",   // ISO-8601 UTC — use this for data age
    "durationMs": 2049,
    "gateway": "192.168.1.1",
    "iface": "eno1",
    "tunnel": false,
    "vpn": null,                           // {"address","iface"} when a LAN and a tunnel default both exist
    "router":   { "ok": true, "reachable": true, "avgMs": 8.058, "lossPct": 0, "error": null },
    "internet": { "ok": true, "reachable": true, "avgMs": 10.534, "lossPct": 0, "error": null },
    "target": "1.1.1.1",
    "hostname": "cloudflare.com",
    "dns": { "ok": true, "address": "104.16.132.229" },
    "load": { "load1": 2.29, "cores": 4, "ratio": 0.57, "busy": false },
    "arp": [ { "ip": "192.168.1.2", "mac": "b8:27:eb:50:e4:11", "iface": "eno1", "label": "Raspberry Pi", "hostname": "pi.hole" } ],
    "source": "Checks run from the NAS over its Ethernet connection."
  },

  "agents": [                              // one per reporting sensor
    {
      "name": "MediaPi",
      "label": "MediaPi",
      "version": "0.2.0",
      "platform": "Linux arm64",
      "addresses": ["192.168.1.110", "172.17.0.1"],
      "gateway": "192.168.1.2",
      "iface": "eth0",
      "tunnel": false,
      "vpn": null,
      "hub":    { "host": "192.168.1.179", "ok": true, "reachable": true, "avgMs": 28.51, "lossPct": 0, "error": null },
      "router": { "ok": true, "reachable": true, "avgMs": 0.541, "lossPct": 0, "error": null },
      "internet": { "ok": true, "reachable": true, "avgMs": 222.112, "lossPct": 0, "error": null },
      "dns": { "ok": true, "address": "104.16.132.229" },
      "load": { "load1": 0.17, "cores": 4, "ratio": 0.04, "busy": false },
      "uptimeSec": 31349,
      "firstSeen": "2026-11-16T00:31:32.885Z",
      "lastSeen": 1794818460091,           // epoch ms
      "deviceCount": 9,
      "online": true                       // lastSeen within 90 s
    }
  ],

  "devices": [                             // merged across vantage points, deduped by IP
    {
      "ip": "192.168.1.40",
      "mac": "b0:be:76:d6:cc:b7",
      "iface": "eno1",
      "label": "TP-Link",                  // curated MAC vendor, or "Randomised MAC", or null
      "hostname": null,                    // reverse DNS, may be null
      "seenBy": ["thinkomv", "MediaPi"],
      "kind": "plug",                      // inferred type, or null
      "room": "Loft",                      // operator-assigned, or null
      "note": null,                        // operator note, or null
      "responded": true,                   // last sweep got a reply (absent if no sweep yet)
      "sweepMs": 22.4,                     // round-trip from that sweep
      "kasa": { "confirmed": true, "model": "HS100(UK)", "alias": "Loft light" },
      "mdns": null,
      "upnp": null
    },
    {
      "ip": "192.168.1.80",
      "mac": "78:28:ca:cc:50:8c",
      "label": "Sonos",
      "hostname": "SonosZP.communityfibre.co.uk",
      "seenBy": ["thinkomv"],
      "kind": "speaker",
      "room": null,
      "note": null,
      "responded": true,
      "sweepMs": 19.5,
      "kasa": null,
      "mdns": { "name": "SonosZP", "services": ["sonos", "spotify-connect"] },
      "upnp": { "server": "Linux UPnP/1.0 Sonos/98.0-82170 (ZPS13)", "location": "http://192.168.1.80:1400/xml/device_description.xml", "serviceTypes": ["urn:schemas-upnp-org:device:ZonePlayer:1"] }
    }
  ],

  "nodes": [                               // browsers that opened the dashboard
    { "id": "…", "name": "Matt's MacBook", "connection": "Wi-Fi", "deviceType": "MacBook",
      "lastSeen": 1794818460091, "browserRttMs": 22, "downMbps": null, "upMbps": null,
      "speedCheckedAt": null, "firstSeen": "2026-11-16T00:31:32.885Z", "online": false }
  ],

  "history": [                             // newest last; /api/state returns the last 60
                                            // (GET /api/history has up to 288)
    { "at": "2026-11-16T08:37:59.334Z", "routerMs": 8.058, "routerLoss": 0,
      "internetMs": 10.534, "internetLoss": 0, "dnsOk": true, "load1": 2.29, "devices": 24 }
  ],

  "scan": { "enabled": true, "subnet": "192.168.1.0/24" }
}
```

---

## 4. Suggested CC mapping

| CC concept | Value from NA |
|---|---|
| Source key | `network_advisor` |
| Label | `Network` |
| Group | the existing network/DNS group (`/api/group/network`) |
| Tile | wherever the designer puts network sources; no new tile required |

Suggested metrics:

- **Sensors** — `agents.filter(a => a.online).length` + " / " + `agents.length`
- **NAS → router** — `check.router.avgMs` and `check.router.lossPct`
- **NAS → internet** — `check.internet.avgMs` and `check.internet.lossPct`
- **Devices seen** — `devices.length`
- **DNS** — `check.dns.ok`

Suggested verdict:

| Condition | Result |
|---|---|
| Endpoint unreachable, or `check === null` | `unknown` (not `warning`) |
| `check.checkedAt` older than 10 min | carry the payload but mark the age, per CC's stale-row rule |
| Any `agents[].online === false` | `warning` |
| `check.router.lossPct > 0` | `warning` |
| `check.router.avgMs > NETWORK_ADVISOR_ROUTER_WARN_MS` (default 20) | `warning` |
| any device with `responded === false` | **not** a warning by itself; a battery camera or sleeping phone is expected to miss a sweep |
| `checkMeta.stale` | carry the payload but mark its age, per CC's stale-row rule |

`checkMeta.stale` is true when no check exists yet or the last one is older than 60 s — the
same threshold that triggers a background refresh. `checkMeta.running` says a check is in
flight now, and `sweep.startedAt`/`running` does the same for a discovery sweep.
| `check.dns.ok === false` | `warning` |
| `load.busy === true` | **`ok` with an info note, never a warning** — see caveat 2 |

---

## 5. Environment

| Variable | Default | Meaning |
|---|---|---|
| `NETWORK_ADVISOR_URL` | `http://127.0.0.1:8090` | Base URL |
| `NETWORK_ADVISOR_POLL` | `60` | Seconds between polls |
| `NETWORK_ADVISOR_TIMEOUT` | `5` | Per-request timeout |
| `NETWORK_ADVISOR_ROUTER_WARN_MS` | `20` | Router RTT that counts as slow |

If CC wants the source optional from day one, add `network_advisor` to
`CC_OPTIONAL_SOURCES` so a missing container does not drag the verdict down.

---

## 6. Implementation sketch (CC side)

A collector modelled on `chatbot_health.py` — same read-only shape, same "published
snapshot" pattern:

```python
class NetworkAdvisorCollector(BaseCollector):
    key = "network_advisor"

    def collect(self, context: CollectorContext) -> dict:
        response = context.http_get(f"{self.base_url}/api/state", timeout=self.timeout)
        if response.status_code != 200:
            raise SourceFailure("unreachable", f"status {response.status_code}")
        try:
            state = response.json()
        except ValueError:
            raise SourceFailure("bad_payload", "not JSON")
        if not isinstance(state, dict) or "check" not in state:
            raise SourceFailure("bad_payload", "unexpected shape")
        ...
```

Then register the key in `aggregator.py` alongside the other source labels and add it to
whichever tile/group network sources roll into. No shell or `static/` change is implied.

---

## 7. Tests worth having

1. Fixture payload → expected metric dict.
2. Unreachable endpoint → `unknown`, collector does not raise past the runner.
3. `check: null` (hub just started) → `unknown`, source itself alive.
4. Non-JSON body → `SourceFailure("bad_payload")`.
5. One agent `online: false` → `warning`.
6. `load.busy: true` → `ok` + note, proving it is not treated as a fault.

---

## 8. Caveats that will bite

1. **The check is on demand.** `/api/state` starts a background check if the last one is
   older than 60 s, then returns the *previous* result. After a quiet night the first
   poll can carry a `checkedAt` hours old and the second is fresh. Use `checkedAt` for
   data age; do not read a stale `checkedAt` as "down".
2. **`load.busy` is about the NAS, not the network.** When the NAS is running something
   heavy, its own ping timings inflate — I measured 133 ms to a gateway that answers in
   1 ms when idle. NA flags this deliberately. Treat it as context for the latency
   numbers, not as a fault.
3. **`agents[].online` uses a 90 s window**; agents report every 30 s. Don't flap on a
   single missed report.
4. **Two sensors sit behind VPN default routes** (`tunnel: true`). Their "first hop" is a
   tunnel peer, so `router.avgMs` can be `null` even when the sensor is perfectly healthy.
   Use `hub.avgMs` (sensor → NAS) as the comparable number across sensors.
5. **`devices[]` is an observation, not an inventory.** It only contains hosts the NAS or
   a sensor has recently talked to; entries go stale, and `label` is a guess from a small
   curated MAC table.
6. **No auth, no TLS.** Do not proxy it to anything public. If CC ever needs a
   credential, NA does not currently offer one — that would be a change on the NA side,
   requested separately.

---

## 9. Zero-code alternative

If CC's owner wants this in navigation only, `SERVICE_LINKS` already exists:

```
SERVICE_LINKS=…,Network Advisor=http://192.168.1.179:8090
```

That costs no code and no rebuild, and is reversible by editing `.env`.

---

## 10. What this document does not ask for

- No changes to CC's shell, `templates/` or `static/` — the designer owns those.
- No write actions from CC into NA; every NA route CC needs is `GET` (plus optional
  `POST /api/scan`, which is the sweep and can be ignored).
- No new containers, mounts, ports or credentials on the NAS.
