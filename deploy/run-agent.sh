#!/bin/sh
# Rootless agent launcher, for hosts with no systemd unit and no passwordless
# sudo (a VPN router, for example). Install alongside the app and let cron keep
# it alive:
#
#   * * * * * pgrep -f "network-advisor-agent/server.js" >/dev/null 2>&1 \
#     || nohup /home/pi/network-advisor-agent/run.sh >> /home/pi/network-advisor-agent/agent.log 2>&1
#
# The environment file must already exist and hold ROLE=agent, ADVISOR_HUB,
# AGENT_NAME, AGENT_TOKEN and DATA_DIR. Keep it mode 600. Set NODE_BIN there if
# node lives somewhere unusual; otherwise the usual locations are tried.

set -eu

ENV_FILE="${AGENT_ENV:-$HOME/.config/network-advisor-agent.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

# Resolve node after the env file, so NODE_BIN in that file takes effect. A
# rootless install keeps node under $HOME, which is why the literal path alone
# was not enough.
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
  exec_node="$NODE_BIN"
elif [ -x /usr/local/bin/node ]; then
  exec_node=/usr/local/bin/node
elif [ -x "$HOME/.local/node/bin/node" ]; then
  exec_node="$HOME/.local/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  exec_node=$(command -v node)
else
  echo "no node binary found; set NODE_BIN in $ENV_FILE" >&2
  exit 1
fi

cd "$(dirname "$0")" || exit 1
# Absolute path on purpose: supervisors and the deploy script match on
# "network-advisor-agent/server.js", which a bare "server.js" would not match.
exec "$exec_node" "$(pwd)/server.js"
