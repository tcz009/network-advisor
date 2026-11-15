# Network Advisor

Network Advisor is an early self-hosted dashboard that builds a picture of a home network from an OpenMediaVault (OMV) NAS and the browsers that connect to it. It shows which checks were run, where they ran, and which parts of the network are still unknown.

> **Status:** early development. The diagram is approximate; this version does not discover every device or map the path through Wi-Fi access points, switches, or powerline adapters.

## What it does

- Tests the NAS's wired connection to its default router and to a public ping destination.
- Checks DNS lookup from the NAS.
- Lets a phone, Mac, or other browser register as a device node, with a name and a connection type you choose.
- Measures browser response time and a small upload/download transfer between that device and the NAS.
- Shows IP and MAC addresses in the NAS's ARP neighbour cache when available.
- Keeps device labels and recent measurements in a persistent Docker volume on the NAS.

## What the measurements mean

The NAS's public test is a **latency check**, not an internet speed test. A failed ping can mean ICMP is filtered; it does not by itself prove the internet is down.

The browser upload/download check measures the path between that device and the NAS. It can help compare a phone's local connection with a Mac's, but it is not the device's internet speed or Wi-Fi radio link rate. The browser cannot run a true ICMP ping or trace route from the device.

The ARP list is passive and can be incomplete or stale. It is not a full network scan. Connection type (Wi-Fi, Ethernet, or Powerline) is selected by the user; browsers cannot reliably discover it. Powerline adapters and intermediate network equipment are not automatically identified yet.

## Requirements

- An OpenMediaVault NAS on a 64-bit system.
- Docker Engine and Docker Compose v2, either through the OMV Compose plugin or already installed on the NAS.
- The NAS connected to the home router. Ethernet gives the advisor its wired reference path.
- Port `8090` available on the NAS (or change `PORT` in `app/compose.yaml`).

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

## Configuration

The defaults are in `app/compose.yaml`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | Web dashboard port |
| `BIND_HOST` | `0.0.0.0` | NAS interface to listen on; all interfaces by default |
| `CHECK_TARGET` | `1.1.1.1` | Public IP used for the NAS ping check |
| `CHECK_HOSTNAME` | `cloudflare.com` | Hostname used for the NAS DNS lookup |

## Privacy and security

The dashboard currently has no login or HTTPS. It is designed for a trusted home LAN only. Do not expose it to the public internet or forward port `8090` from your router. If you use guest networks or untrusted VLANs, restrict access with your firewall.

The container runs as an unprivileged user, uses a read-only root filesystem, drops unnecessary Linux capabilities, and keeps only `NET_RAW` for ping checks. The app stores device names and measured values on the NAS; it does not store browser user-agent strings, load third-party fonts, or use analytics. The NAS contacts the configured ping target and performs the configured DNS lookup during checks.

## Troubleshooting

- **Dashboard does not open:** confirm the container is running, that port `8090` is free, and that the device can reach the NAS on the LAN.
- **Router is not identified:** host networking is required. Confirm the NAS itself has a default route and check the container logs in OMV or with `docker compose logs`.
- **Internet says no ping reply:** some networks block ICMP. Check DNS and a browser on the NAS LAN before concluding the internet is down.
- **Phone or Mac is missing from the map:** open this dashboard in that device's browser and leave the page open. It checks in while the page is active; browsers cannot run in the background indefinitely.
- **No powerline or access point details:** this version does not query vendor equipment APIs. Select the relevant connection type manually for a browser node; intermediate hops remain unknown.

## Project layout

```text
app/
  compose.yaml      OMV/Docker Compose service
  Dockerfile        Local image build
  server.js         Dashboard server and NAS-side checks
  public/           Browser UI
```

## License

This project is licensed under the [MIT License](LICENSE).
