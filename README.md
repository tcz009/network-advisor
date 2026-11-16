# Network Advisor

Network Advisor is an early self-hosted dashboard that builds a picture of a home network from an OpenMediaVault (OMV) NAS and the browsers that connect to it. It shows which checks were run, where they ran, and which parts of the network are still unknown.

> **Status:** early development. The diagram is approximate; this version does not discover every device or map the path through Wi-Fi access points, switches, or powerline adapters.

## What it does

- Tests the NAS's wired connection to its default router and to a public ping destination.
- Checks DNS lookup from the NAS.
- Lets a phone, Mac, or other browser register as a device node, with a name and a connection type you choose.
- Measures browser response time and a small upload/download transfer between that device and the NAS.
- Shows IP and MAC addresses in the NAS's ARP neighbour cache when available, with hostnames where the LAN provides them and a vendor guess from a small curated MAC table.
- Optionally sweeps your own subnet so devices that never talk to the NAS still appear.
- Accepts reports from small **agents** on other hosts (a Raspberry Pi, a second NAS), so one map can show what several vantage points see.
- Draws one node per reporting host — the NAS, each sensor, each browser — joined by what was actually measured, with a response-time trend from recent checks.
- Records the NAS's load, because a busy NAS inflates its own ping timings.
- Keeps device labels, agent reports, and recent measurements in a persistent Docker volume on the NAS.

## What the measurements mean

The NAS's public test is a **latency check**, not an internet speed test. A failed ping can mean ICMP is filtered; it does not by itself prove the internet is down.

The browser upload/download check measures the path between that device and the NAS. It can help compare a phone's local connection with a Mac's, but it is not the device's internet speed or Wi-Fi radio link rate. The browser cannot run a true ICMP ping or trace route from the device.

The ARP list is passive and can be incomplete or stale. With `SCAN_SUBNET` unset it is not a scan at all: it only holds hosts the NAS has recently spoken to. Active discovery (see below) improves coverage but still only proves that an address answered one ICMP echo. Connection type (Wi-Fi, Ethernet, or Powerline) is selected by the user; browsers cannot reliably discover it. Powerline adapters and intermediate network equipment are not automatically identified yet.

**A busy NAS distorts its own timings.** Ping latency includes however long the kernel needs to schedule the check, so a NAS running a heavy job reports higher router and internet times than the network deserves. The dashboard reads `/proc/loadavg` and, when load approaches the core count, adds a finding saying so. Compare a reading against the load figure shown beside it before blaming the network.

Container and VPN interfaces are deliberately excluded from the device list. Host networking puts `docker0` and `br-…` bridges in the same neighbour table as the LAN, and reporting them produced a map that was mostly containers.

## Requirements

- An OpenMediaVault NAS on a 64-bit system.
- Docker Engine and Docker Compose v2, either through the OMV Compose plugin or already installed on the NAS.
- The NAS connected to the home router. Ethernet gives the advisor its wired reference path.
- Port `8090` available on the NAS (or change `PORT` in `app/compose.yaml`).

Agent mode needs no Docker and no open port: any host with Node.js 22 or newer can report in.

For OMV setup, see the [OMV Compose plugin guide](https://wiki.omv-extras.org/doku.php?id=omv7:omv7_plugins:docker_compose) or the [OMV 8 Compose plugin guide](https://wiki.omv-extras.org/doku.php?id=omv8:omv8_plugins:docker_compose), depending on your OMV version. Those guides cover installing Docker and the plugin; this project guide covers Network Advisor.

## Install on OMV using SSH

This is the shortest route when Docker Compose is installed.

1. Connect to the NAS over SSH and change to a folder where you keep application projects.
2. Clone the repository and start the app:

   ```sh
   git clone https://github.com/tcz009/network-advisor.git
   cd network-advisor/app
   docker compose up -d --build
   ```

3. Open `http://NAS-IP:8090` from a device on your home network, replacing `NAS-IP` with the NAS's local address.
4. Open the dashboard on each phone or computer you want to include. Choose a device name and its connection type, then select **Run network check** on that device.

The `compose.yaml` uses host networking so the container can inspect the NAS's actual default route and ARP neighbour cache. The app listens on all NAS interfaces by default. Keep it on a trusted network; do not create a router port-forward to it.

## Optional: active device discovery

By default the advisor is passive. To let it find devices that never talk to the NAS, set your own LAN range:

```sh
SCAN_SUBNET=192.168.1.0/24 docker compose up -d
```

or put `SCAN_SUBNET=192.168.1.0/24` in a `.env` file beside `compose.yaml`. When set, **Run network check** first sweeps that range with one ICMP echo per address (32 at a time, minimum 30 seconds between sweeps) and then reads the neighbour table.

Only your own range is accepted: anything wider than `/22` is refused so a typo cannot turn into a large ICMP blast. Sweeping an address range you do not own is not a good idea, and some devices treat it as hostile.

## Add sensors on other hosts (agent mode)

The dashboard reads `/proc/net/route` and `/proc/net/arp` from the host it runs on, so a second copy of the app elsewhere is just a second dashboard. To get one combined picture, run an **agent** on the other host instead. It pushes its own gateway, pings, load, and neighbour list to the hub and never opens a port.

1. On the hub, set a shared token in `.env` beside `compose.yaml`, then bring the stack up:

   ```sh
   echo "AGENT_TOKEN=$(openssl rand -hex 24)" >> .env
   docker compose up -d
   ```

2. On the agent host, install Node.js 22 or newer, then copy the `app/` directory to `/opt/network-advisor-agent` (for example with `rsync -a app/ root@pi:/opt/network-advisor-agent/`) and make `node` available as `/usr/local/bin/node`.

3. Create `/etc/network-advisor-agent.env`:

   ```sh
   ROLE=agent
   ADVISOR_HUB=http://192.168.1.179:8090
   AGENT_NAME=media-pi
   AGENT_TOKEN=the-same-token-as-the-hub
   DATA_DIR=/var/lib/network-advisor-agent
   PORT=0
   ```

4. Install and start the service:

   ```sh
   install -m 644 deploy/network-advisor-agent.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now network-advisor-agent
   journalctl -u network-advisor-agent -f
   ```

If a host has no passwordless sudo — a VPN router, for example — agent mode also runs as an ordinary user: unpack Node under your home directory, start the same `server.js` with `ROLE=agent`, and keep it alive from cron with one line:

```sh
install -m 700 deploy/run-agent.sh /home/pi/network-advisor-agent/run.sh
```

then, in `crontab -e`:

```sh
* * * * * pgrep -f "network-advisor-agent/server.js" >/dev/null 2>&1 || nohup /home/pi/network-advisor-agent/run.sh >> /home/pi/network-advisor-agent/agent.log 2>&1
```

`run-agent.sh` sources `~/.config/network-advisor-agent.env` (mode 600), and the agent reports every 30 s without opening a port.

That needs no root and touches no system files, which is often the better trade on a host whose job is routing. It does mean `ping` must be allowed to use an ICMP datagram socket: check `sysctl net.ipv4.ping_group_range` includes your user's group, otherwise the sensor reports devices and load but no timings.

A working agent logs `[agent] reported N devices to …` within a few seconds. The dashboard's **Sensors on the LAN** panel lists every agent, and the device list marks which hosts saw each address. A sensor is shown offline as soon as it has not reported for 90 seconds, and after ten minutes it stops contributing devices — so a retired Pi cannot leave phantom "seen by" tags behind. The row itself is kept for seven days, then pruned.

Agents are optional and independent: the hub works fine with none, and an agent that cannot reach the hub just logs a failure and retries every 30 seconds. Set `AGENT_INTERVAL_MS` to change that interval.

## Install through the OMV Compose plugin

The plugin's Files page can manage Compose stacks in the OMV web interface. Because this project builds a local image, keep `compose.yaml`, `Dockerfile`, `package.json`, `server.js`, and the `public/` folder together in the same `app/` directory. The `build: .` entry in the Compose file expects that layout.

Clone or copy this repository onto the NAS first, then use the plugin's **Import** action for the Compose file in `app/compose.yaml`. Keep the rest of the `app/` directory alongside it so Docker can build the image. The plugin's import folder layout and Compose Files location vary with OMV setup; see its [Import instructions](https://wiki.omv-extras.org/doku.php?id=omv7:omv7_plugins:docker_compose#files) for the required folder structure. After importing, select the stack and choose **Up**. On first start, OMV builds the image and starts the service.

## Update, stop, and stored data

From the `app/` directory:

```sh
git pull
docker compose up -d --build
```

Stop and remove the container while keeping saved device details:

```sh
docker compose down
```

Device labels and measurements are stored in the named Docker volume `network-advisor-data` (Compose may prefix the volume with the project name). Back it up with your normal Docker/OMV backup process. **Do not use `docker compose down -v` unless you intend to delete that stored data.**

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Everything: check, agents, merged devices, browser nodes, history (last 60), scan config |
| `/api/check` | POST | Run a check now and return it |
| `/api/scan` | POST | Sweep `SCAN_SUBNET` (no-op returning `enabled:false` when unset) |
| `/api/history` | GET | Full check history (max 288 records) |
| `/api/agents` | GET | Sensors and their payloads |
| `/api/agents/report` | POST | Agent intake; requires `AGENT_TOKEN` or `AGENT_TOKENS` |
| `/api/nodes` | POST | Register or update this browser as a device |
| `/api/nodes/<id>` | DELETE | Forget a device (requires `x-advisor-intent: delete`) |
| `/api/speed/download` | GET | Transfer a fixed-size body for the local speed test |
| `/api/speed/upload` | POST | Receive up to 2 MiB for the local speed test |
| `/api/pulse` | GET | Liveness only; no side effects |

A full client contract for another dashboard lives in [`docs/cc-integration.md`](docs/cc-integration.md).

## Deploying, and rolling back

`deploy/redeploy.sh` (run on the NAS) is the supported path. It resolves a branch or commit, builds the hub tagged with the short SHA, ships the matching bundle to each Pi, stages and health-checks each swap, and prints the fleet it sees at the end. Any failed step exits non-zero.

```sh
deploy/redeploy.sh              # deploy origin/main
deploy/redeploy.sh <commit>     # deploy a specific revision
deploy/redeploy.sh rollback     # return to the previously deployed commit
```

Deployments are recorded in `/opt/cache/deploy-state/history`, images are tagged `network-advisor:<sha>`, and the last three bundles are kept in `/opt/cache/bundles`.

The data volume has an explicit name (`network-advisor-data`), so it no longer depends on which Compose project started the stack. Older installs created `network-advisor_network-advisor-data`; copy it across once:

```sh
docker volume create network-advisor-data
docker run --rm -v network-advisor_network-advisor-data:/from -v network-advisor-data:/to \
  alpine sh -c 'cp -a /from/. /to/'
```

## Configuration

Hub defaults come from `app/compose.yaml`; the agent and interval defaults come from `server.js`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | Web dashboard port |
| `BIND_HOST` | `0.0.0.0` | NAS interface to listen on; all interfaces by default |
| `CHECK_TARGET` | `1.1.1.1` | Public IP used for the NAS ping check |
| `CHECK_HOSTNAME` | `cloudflare.com` | Hostname used for the NAS DNS lookup |
| `SCAN_SUBNET` | unset | CIDR to sweep when a check runs; unset keeps discovery passive |
| `AGENT_TOKEN` | unset | Shared secret required for agent reports; unset disables agent intake |
| `ROLE` | `hub` | `agent` turns this copy into a sensor that reports to `ADVISOR_HUB` |
| `ADVISOR_HUB` | unset | Hub base URL, required in agent mode |
| `AGENT_NAME` | hostname | Name shown for this sensor |
| `AGENT_INTERVAL_MS` | `30000` | How often an agent reports in (minimum 15000) |
| `AGENT_TOKENS` | unset | `Name=token,Name=token`; binds a token to a sensor so one leak cannot rewrite the others |
| `ALLOWED_HOSTS` | unset | DNS names the dashboard may answer on. IP literals and `localhost` are always allowed; anything else is refused with `421` |

## Privacy and security

The dashboard currently has no login or HTTPS. It is designed for a trusted home LAN only. Do not expose it to the public internet or forward port `8090` from your router. If you use guest networks or untrusted VLANs, restrict access with your firewall.

The container runs as an unprivileged user, uses a read-only root filesystem, drops unnecessary Linux capabilities, and keeps only `NET_RAW` for ping checks. The app stores device names and measured values on the NAS; it does not store browser user-agent strings, load third-party fonts, or use analytics. The NAS contacts the configured ping target and performs the configured DNS lookup during checks.

Agent intake is closed unless `AGENT_TOKEN` or `AGENT_TOKENS` is set on the hub, and tokens are compared in constant time. `AGENT_TOKENS` binds a token to a sensor name; a single shared `AGENT_TOKEN` means any holder can rewrite every sensor, so per-sensor tokens are preferred.

The `Host` header is validated against a plain-address allowlist: IP literals and `localhost` are accepted, and DNS names must be listed in `ALLOWED_HOSTS`. That is there to defeat DNS rebinding, which the `Origin` check cannot see — under rebinding the attacker's hostname is both the Host and the Origin. Mutating requests also require a same-origin `Origin` header, deleting a device requires an `x-advisor-intent: delete` header, and pages are served with a `default-src 'self'` content security policy. None of that is authentication: this dashboard has no login, so anything that can reach the port can read everything on it.

The token crosses your LAN in clear text on every report. Treat it as a LAN-only secret, and keep the port off any untrusted network. State files are written atomically and the previous copy is kept as `.bak`.

Agents send their host's gateway, load average, ping results, and neighbour table to the hub; they send no file contents, no process list, and no credentials other than the shared token.

## Troubleshooting

- **Dashboard does not open:** confirm the container is running, that port `8090` is free, and that the device can reach the NAS on the LAN.
- **Router is not identified:** host networking is required. Confirm the NAS itself has a default route and check the container logs in OMV or with `docker compose logs`.
- **Internet says no ping reply:** some networks block ICMP. Check DNS and a browser on the NAS LAN before concluding the internet is down.
- **Phone or Mac is missing from the map:** open this dashboard in that device's browser and leave the page open. It checks in while the page is active; browsers cannot run in the background indefinitely.
- **No powerline or access point details:** this version does not query vendor equipment APIs. Select the relevant connection type manually for a browser node; intermediate hops remain unknown.
- **Every timing is empty:** the container or agent cannot do ICMP. The hub runs a ping self-test at startup and logs `ping self-test failed`; check `net.ipv4.ping_group_range` on the host, and that `iputils` is installed.
- **The dashboard returns 421 for its own address:** you reached it by DNS name. Add that name to `ALLOWED_HOSTS`, or use the IP.
- **Router or internet times look worse than they are:** check the load figure in the findings panel. A NAS running a heavy job reports inflated ping times; re-run a check when it is idle.
- **A sensor never appears:** confirm `AGENT_TOKEN` (or the sensor's entry in `AGENT_TOKENS`) matches on both ends, that `POST /api/agents/report` returns something other than `403`, and read `journalctl -u network-advisor-agent`. Visit `/api/agents` on the hub to see whether intake is enabled at all.
- **A device shows the wrong vendor:** the MAC prefixes come from a small curated table in `app/oui.js`, not the full IEEE registry. Add the prefix there if you want it named.
- **A device is labelled "Randomised MAC":** phones and some laptops rotate their MAC per network by design, so the vendor cannot be looked up.

## Project layout

```text
app/
  compose.yaml      OMV/Docker Compose service
  Dockerfile        Local image build
  server.js         Dashboard server, hub intake, agent loop, host checks
  oui.js            Curated MAC prefix to vendor labels
  public/           Browser UI
  test/             node:test unit and HTTP tests
deploy/
  network-advisor-agent.service   systemd unit for agent mode
.github/workflows/ci.yml          Tests, image build and a container smoke test on pushes to `main` and on every pull request
```

## Development

No dependencies, no build step. Node.js 22 or newer:

```sh
cd app
npm test          # 60 unit and HTTP tests, no network access needed
npm start         # runs the hub on http://localhost:8090
```

On a machine that is not Linux the gateway and neighbour table are simply empty, because `/proc/net/route` and `/proc/net/arp` do not exist; the rest of the dashboard still runs, which is the quickest way to work on the UI.

## License

This project is licensed under the [MIT License](LICENSE).
