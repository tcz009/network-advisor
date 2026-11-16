# Blink devices on the LAN

Blink cameras are the clearest example of a device class where "not on the map" does not mean "broken". Knowing which Blink hardware can have an IP at all saves a lot of pointless scanning.

## Only some Blink hardware holds an IP

Battery cameras talk to their **Sync Module over a sub-GHz radio**, not over Wi-Fi, so they never ask for a DHCP lease and can never appear in an IP scan:

| Hardware | Has an IP? |
|---|---|
| Sync Module 2 | **Yes** (always) |
| Blink Mini / Mini 2 | **Yes** |
| Video Doorbell | **Yes** |
| Wired Floodlight | **Yes** |
| Outdoor / XT / Indoor (battery) | **No** — sub-GHz to the sync module |
| Outdoor 4 | **No** on its own; reaches Wi-Fi only via the sync module |

Sources: [Sync Module 2 teardown](https://wiki.recessim.com/view/Blink_SyncModule_2), [Outdoor 4 FAQ](https://support.blinkforhome.com/en_US/outdoor4-camera-faq).

So if a household has a doorbell and three battery cameras, exactly **two** Blink devices will have addresses: the sync module and the doorbell (plus any Minis or a chime).

## How the four addressable types are told apart

The name is in reverse DNS, and it is descriptive:

| Reverse-DNS name | Device |
|---|---|
| `blink-sync-module…` | Sync Module |
| `Blink-Mini…` | Mini |
| `Blink-Chime…` | doorbell chime |
| `Blink-Device…` | the Video Doorbell (generic name) |
| `Blink-Device…` (another) | indistinguishable — use the power-cycle test below |

Blink firmware does **not** advertise mDNS/Bonjour or SSDP, exposes no local API, ONVIF or RTSP, and has no per-model DHCP vendor class in public sources. Endpoint fingerprints do not separate models either: all of them talk to the same Blink cloud hosts.

## If two devices still look identical

Power-cycle one for a minute and watch which address leaves. Network Advisor records this automatically — the *What changed* panel logs `left` and `joined` events, and `GET /api/events` returns them.

The same trick works for anything else on the LAN: the device that disappears is the one you unplugged.

## The lesson that mattered here

Two of four Blink devices were showing as unidentified for hours, and the cause was not Blink at all:

1. The container's resolver is not the LAN resolver — the gateway answers PTR records that the container's system DNS returns `ENOTFOUND` for. Names now fall back to an explicit query against the gateway.
2. A **cap of 16 hostname lookups per sweep** silently left every device after the sixteenth unnamed, which reads exactly like "this device has no name".

Both are fixed, and the second is a reminder worth keeping: a silent cap on an enrichment step looks identical to absence of data.
