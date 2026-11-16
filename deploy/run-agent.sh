#!/bin/sh
# Rootless agent launcher, for hosts with no systemd unit and no passwordless
# sudo (a VPN router, for example). Install alongside the app and let cron keep
# it alive:
#
#   * * * * * pgrep -f "network-advisor-agent/server.js" >/dev/null 2>&1 \
#     || nohup /home/pi/network-advisor-agent/run.sh >> /home/pi/network-advisor-agent/agent.log 2>&1
#
# The environment file must already exist and hold ROLE=agent, ADVISOR_HUB,
# AGENT_NAME, AGENT_TOKEN and DATA_DIR. Keep it mode 600.

set -eu

ENV_FILE="${AGENT_ENV:-/home/pi/.config/network-advisor-agent.env}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "missing node binary: $NODE_BIN" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

cd "$(dirname "$0")" || exit 1
exec "$NODE_BIN" server.js
