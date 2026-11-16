#!/bin/bash
# Deploy Network Advisor: hub on the NAS, then the agent on each Pi.
#
#   deploy/redeploy.sh                 # deploy origin/main
#   deploy/redeploy.sh main            # same, explicit
#   BRANCH=feature deploy/redeploy.sh  # another branch
#   deploy/redeploy.sh rollback        # go back to the previously deployed commit
#
# Run on the NAS. Fails loudly: any failed step exits non-zero, because a
# half-updated fleet that reports success is worse than a failed deploy.
set -euo pipefail

REPO="${REPO:-/opt/network-advisor}"
CACHE="${CACHE:-/opt/cache}"
BUNDLE_DIR="$CACHE/bundles"
STATE_DIR="$CACHE/deploy-state"
HUB="${HUB:-http://127.0.0.1:8090}"
PROJECT="${PROJECT:-network-advisor}"

# Pi connection details. Host keys are recorded on first contact and verified
# afterwards; StrictHostKeyChecking=no would let any LAN host impersonate a Pi.
PI_KEYS="${PI_KEYS:-/root/.ssh/homelab_health}"
RPIHOLE_KEY="${RPIHOLE_KEY:-/root/.ssh/guac_rsa}"
KNOWN_HOSTS="${KNOWN_HOSTS:-/root/.ssh/known_hosts_pis}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10
          -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new)

MEDIAPI_HOST="${MEDIAPI_HOST:-192.168.1.110}"
RPIHOLE_HOST="${RPIHOLE_HOST:-192.168.1.2}"
VPNGATE_HOST="${VPNGATE_HOST:-192.168.1.142}"
VPNGATE_DIR="/home/pi/network-advisor-agent"

mkdir -p "$BUNDLE_DIR" "$STATE_DIR"
touch "$STATE_DIR/history"
trap 'echo "FAILED at line $LINENO" >&2' ERR

log() { echo "--- $* ---"; }

current_sha() { tail -n 1 "$STATE_DIR/history" 2>/dev/null || true; }

# Newest recorded deployment that is not the one running now.
previous_sha() {
  local current
  current=$(current_sha)
  tac "$STATE_DIR/history" 2>/dev/null | grep -v -x -F "${current:-none}" | head -n 1 || true
}

checkout_ref() {
  local ref="$1" target
  cd "$REPO"
  git fetch -q origin --prune
  if git rev-parse --verify --quiet "origin/$ref" >/dev/null; then
    target="origin/$ref"
    # Stay on the branch so `git status` on the NAS reads sanely afterwards.
    git checkout -q -B "$ref" "$target"
  elif git rev-parse --verify --quiet "$ref" >/dev/null; then
    target="$ref"
    git checkout -q --detach "$target"   # a SHA is not a branch
  else
    echo "FATAL: $ref does not exist" >&2
    exit 1
  fi
  git reset -q --hard "$target"
  git log --oneline -1
}

bundle_app() {
  local sha="$1"
  local out="$BUNDLE_DIR/$sha.tar.gz"
  tar -C "$REPO" -czf "$out" --exclude=.env app
  ls -1t "$BUNDLE_DIR"/*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f   # keep the last 3
  echo "$out"
}

# Keep the images the last three deployments used, plus latest. Without this the
# NAS collects a 169 MB image per deploy.
prune_images() {
  local recent
  recent=$(tail -n 3 "$STATE_DIR/history" 2>/dev/null || true)
  for tag in $(docker images --filter reference='network-advisor:*' --format '{{.Tag}}' 2>/dev/null); do
    case "$tag" in
      latest) continue ;;
    esac
    if printf '%s\n' "$recent" | grep -qx -F "$tag"; then continue; fi
    docker rmi "network-advisor:$tag" >/dev/null 2>&1 && echo "pruned image $tag" || true
  done
  docker tag "network-advisor:$(current_sha)" network-advisor:latest >/dev/null 2>&1 || true
}

build_hub() {
  local sha="$1"
  log "hub: build $sha"
  cd "$REPO/app"
  if ! ADVISOR_TAG="$sha" docker compose -p "$PROJECT" up -d --build; then
    echo "FATAL: hub build/start failed" >&2
    exit 1
  fi
  sleep 5
  local health
  health=$(docker inspect -f '{{.State.Health.Status}}' network-advisor 2>/dev/null || echo unknown)
  if [ "$health" != "healthy" ] && [ "$health" != "starting" ]; then
    echo "FATAL: hub container is $health" >&2
    docker logs --tail 20 network-advisor >&2 || true
    exit 1
  fi
  if ! curl -fsS --max-time 10 "$HUB/api/pulse" >/dev/null; then
    echo "FATAL: hub does not answer on $HUB" >&2
    exit 1
  fi
  echo "hub healthy, tagged network-advisor:$sha"
}

# Stage, verify, swap, and restore on failure. The old tree is only removed once
# the new one is running, so a bad bundle cannot leave a Pi with no code.
install_systemd_agent() {
  local host="$1" user="$2" key="$3" label="$4"
  local sudo=""; [ "$user" = root ] || sudo="sudo -n "
  scp -q "${SSH_OPTS[@]}" -i "$key" "$BUNDLE" "$user@$host:/tmp/na-app.tar.gz"
  scp -q "${SSH_OPTS[@]}" -i "$key" "$REPO/deploy/network-advisor-agent.service" "$user@$host:/tmp/na-agent.service"
  ssh "${SSH_OPTS[@]}" -i "$key" "$user@$host" "${sudo}bash -s" <<'EOS'
set -euo pipefail
stage=/opt/network-advisor-agent.new
rm -rf "$stage"
mkdir -p "$stage"
tar -xzf /tmp/na-app.tar.gz -C "$stage" --strip-components=1
/usr/local/bin/node --check "$stage/server.js"
install -m 644 /tmp/na-agent.service /etc/systemd/system/network-advisor-agent.service
if [ ! -f /etc/network-advisor-agent.env ]; then
  echo "WARNING: /etc/network-advisor-agent.env is missing; the unit will not start" >&2
fi
chmod 600 /etc/network-advisor-agent.env 2>/dev/null || true
cp /etc/systemd/system/network-advisor-agent.service /tmp/na-agent.service.prev 2>/dev/null || true
systemctl daemon-reload
mv /opt/network-advisor-agent /opt/network-advisor-agent.prev 2>/dev/null || true
mv "$stage" /opt/network-advisor-agent
(systemctl restart network-advisor-agent && sleep 8) || true
if ! systemctl is-active --quiet network-advisor-agent; then
  echo "agent failed to start; restoring previous tree and unit" >&2
  rm -rf /opt/network-advisor-agent
  mv /opt/network-advisor-agent.prev /opt/network-advisor-agent 2>/dev/null || true
  if [ -f /tmp/na-agent.service.prev ]; then
    install -m 644 /tmp/na-agent.service.prev /etc/systemd/system/network-advisor-agent.service
    systemctl daemon-reload
  fi
  systemctl restart network-advisor-agent || true
  sleep 5
  if ! systemctl is-active --quiet network-advisor-agent; then
    echo "RESTORE FAILED: network-advisor-agent is not running" >&2
  fi
  exit 1
fi
rm -rf /opt/network-advisor-agent.prev
systemctl is-active network-advisor-agent
EOS
}

install_vpngate_agent() {
  log "vpngate ($VPNGATE_HOST, rootless)"
  scp -q "${SSH_OPTS[@]}" -i "$PI_KEYS" "$BUNDLE" "pi@$VPNGATE_HOST:/tmp/na-app.tar.gz"
  scp -q "${SSH_OPTS[@]}" -i "$PI_KEYS" "$REPO/deploy/run-agent.sh" "pi@$VPNGATE_HOST:/tmp/na-run.sh"
  ssh "${SSH_OPTS[@]}" -i "$PI_KEYS" "pi@$VPNGATE_HOST" 'bash -s' <<EOS
set -euo pipefail
stage="$VPNGATE_DIR.new"
rm -rf "\$stage"
mkdir -p "\$stage"
tar -xzf /tmp/na-app.tar.gz -C "\$stage" --strip-components=1
/home/pi/.local/node/bin/node --check "\$stage/server.js"
install -m 700 /tmp/na-run.sh "\$stage/run.sh"
rm -rf "$VPNGATE_DIR.prev"
mv "$VPNGATE_DIR" "$VPNGATE_DIR.prev"
mv "\$stage" "$VPNGATE_DIR"
pkill -f "$VPNGATE_DIR/server.js" || true
sleep 2
nohup "$VPNGATE_DIR/run.sh" >> "$VPNGATE_DIR/agent.log" 2>&1 &
sleep 10
if ! pgrep -f "$VPNGATE_DIR/server.js" >/dev/null; then
  echo "vpngate agent did not start; restoring" >&2
  rm -rf "$VPNGATE_DIR"
  mv "$VPNGATE_DIR.prev" "$VPNGATE_DIR"
  nohup "$VPNGATE_DIR/run.sh" >> "$VPNGATE_DIR/agent.log" 2>&1 &
  exit 1
fi
rm -rf "$VPNGATE_DIR.prev"
echo "vpngate running"
EOS
}

verify_fleet() {
  log "waiting for reports"
  sleep 20
  # The expected list is passed through the environment: the python snippet is
  # single-quoted, so ${...} inside it would never expand.
  curl -fsS --max-time 10 "$HUB/api/agents" \
    | EXPECTED_AGENTS="${EXPECTED_AGENTS:-MediaPi,RPiHole,vpngate}" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
agents = data["agents"]
expected = set(filter(None, (name.strip() for name in os.environ["EXPECTED_AGENTS"].split(","))))
for agent in agents:
    hop = agent["gateway"] or (agent.get("vpn") or {}).get("address") or "none"
    print("  %-9s v%-6s hop %-14s devices %-3s online %s" % (
        agent["label"], agent["version"], hop, agent["deviceCount"], agent["online"]))
if not agents:
    print("  no sensors reported at all", file=sys.stderr)
    sys.exit(1)
online = {agent["label"] for agent in agents if agent["online"]}
missing = sorted(expected - online)
if missing:
    print("  FAILED: sensors not reporting: %s" % ", ".join(missing), file=sys.stderr)
    sys.exit(2)
'
}

deploy() {
  local ref="$1" sha
  log "deploy $ref at $(date -Is)"
  checkout_ref "$ref"
  sha=$(git -C "$REPO" rev-parse --short HEAD)
  BUNDLE=$(bundle_app "$sha")
  echo "bundle: $BUNDLE"
  build_hub "$sha"
  # Plain calls: putting these behind `|| exit 1` would disable errexit inside
  # the functions, so a failed scp could go unnoticed.
  install_systemd_agent "$MEDIAPI_HOST" root "$PI_KEYS" MediaPi
  install_systemd_agent "$RPIHOLE_HOST" pi "$RPIHOLE_KEY" RPiHole
  install_vpngate_agent
  verify_fleet
  # Record once; a repeated deploy of the same SHA must not poison rollback.
  if [ "$(current_sha)" != "$sha" ]; then
    echo "$sha" >> "$STATE_DIR/history"
  fi
  prune_images
  echo "=== deployed $sha at $(date -Is) ==="
}

rollback() {
  local target
  target=$(previous_sha)
  if [ -z "$target" ]; then
    echo "FATAL: no previous deployment recorded in $STATE_DIR/history" >&2
    exit 1
  fi
  log "rollback to $target"
  deploy "$target"
}

case "${1:-deploy}" in
  rollback) rollback ;;
  deploy) deploy main ;;
  *) deploy "$1" ;;
esac
