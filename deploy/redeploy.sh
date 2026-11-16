#!/bin/bash
# Pull a branch on the hub and refresh the Pi agents.
#
# Run on the NAS (it uses the NAS's own SSH keys to reach the Pis).
#
#   deploy/redeploy.sh              # main
#   BRANCH=some-branch deploy/redeploy.sh
#
# This script used to hardcode a feature branch. When that branch was merged and
# deleted, the reset silently fell back to a stale local checkout and rebuilt the
# hub from the wrong commit. Hence the explicit ref check below: a missing branch
# is now a hard failure instead of a quiet rollback.
set -u

BRANCH="${BRANCH:-main}"
REPO="${REPO:-/opt/network-advisor}"
CACHE="${CACHE:-/opt/cache}"
HUB="${HUB:-http://127.0.0.1:8090}"
BUNDLE="$CACHE/network-advisor-app.tar.gz"

PI_KEYS="${PI_KEYS:-/root/.ssh/homelab_health}"
RPIHOLE_KEY="${RPIHOLE_KEY:-/root/.ssh/guac_rsa}"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10"

echo "=== redeploy $BRANCH at $(date -Is) ==="

echo "--- hub: pull and rebuild ---"
cd "$REPO" || { echo "FATAL: $REPO not found"; exit 1; }
git fetch -q origin --prune || { echo "FATAL: fetch failed"; exit 1; }
if ! git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  echo "FATAL: origin/$BRANCH does not exist; refusing to build from whatever is checked out"
  exit 1
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH" || { echo "FATAL: checkout failed"; exit 1; }
git reset --hard -q "origin/$BRANCH" || { echo "FATAL: reset failed"; exit 1; }
echo "building $(git log --oneline -1)"

cd "$REPO/app" || { echo "FATAL: $REPO/app not found"; exit 1; }
docker compose -p network-advisor up -d --build 2>&1 | tail -3

mkdir -p "$CACHE"
tar -C "$REPO" -czf "$BUNDLE" --exclude=.env app || { echo "FATAL: bundle failed"; exit 1; }
echo "app bundle: $(du -h "$BUNDLE" | cut -f1)"

echo "--- MediaPi (systemd, root) ---"
scp -q $SSH_OPTS -i "$PI_KEYS" "$BUNDLE" root@192.168.1.110:/tmp/na-app.tar.gz \
  && ssh $SSH_OPTS -i "$PI_KEYS" root@192.168.1.110 \
       'rm -rf /opt/network-advisor-agent && mkdir -p /opt/network-advisor-agent && tar -xzf /tmp/na-app.tar.gz -C /opt/network-advisor-agent --strip-components=1 && systemctl restart network-advisor-agent && sleep 6 && systemctl is-active network-advisor-agent'

echo "--- RPiHole (systemd, sudo) ---"
scp -q $SSH_OPTS -i "$RPIHOLE_KEY" "$BUNDLE" pi@192.168.1.2:/tmp/na-app.tar.gz \
  && ssh $SSH_OPTS -i "$RPIHOLE_KEY" pi@192.168.1.2 \
       'sudo -n rm -rf /opt/network-advisor-agent && sudo -n mkdir -p /opt/network-advisor-agent && sudo -n tar -xzf /tmp/na-app.tar.gz -C /opt/network-advisor-agent --strip-components=1 && sudo -n systemctl restart network-advisor-agent && sleep 6 && systemctl is-active network-advisor-agent'

echo "--- vpngate (rootless, cron) ---"
scp -q $SSH_OPTS -i "$PI_KEYS" "$BUNDLE" pi@192.168.1.142:/tmp/na-app.tar.gz \
  && ssh $SSH_OPTS -i "$PI_KEYS" pi@192.168.1.142 'bash -s' <<'EOS'
set -e
rm -rf /home/pi/network-advisor-agent.new
mkdir -p /home/pi/network-advisor-agent.new
tar -xzf /tmp/na-app.tar.gz -C /home/pi/network-advisor-agent.new --strip-components=1
cp /home/pi/network-advisor-agent/run.sh /home/pi/network-advisor-agent.new/run.sh 2>/dev/null || true
pkill -f 'network-advisor-agent/server.js' || true
sleep 2
rm -rf /home/pi/network-advisor-agent
mv /home/pi/network-advisor-agent.new /home/pi/network-advisor-agent
chmod 700 /home/pi/network-advisor-agent/run.sh
nohup /home/pi/network-advisor-agent/run.sh >> /home/pi/network-advisor-agent/agent.log 2>&1 &
sleep 12
echo -n 'processes: '; pgrep -fc 'network-advisor-agent/server.js' || echo 0
EOS

echo "--- wait for reports ---"
sleep 25
curl -s --max-time 8 "$HUB/api/agents" | python3 -c "
import json, sys
for agent in json.load(sys.stdin)['agents']:
    hop = agent['gateway'] or (agent.get('vpn') or {}).get('address') or 'none'
    print('  %-9s v%-6s hop %-14s devices %-3s online %s' % (
        agent['label'], agent['version'], hop, agent['deviceCount'], agent['online']))
" || echo "could not read /api/agents"

echo "=== done at $(date -Is) ==="
