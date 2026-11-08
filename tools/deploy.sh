#!/usr/bin/env bash
# Uploads Mastermind to a server over SSH and restarts its systemd service.
#
#   DEPLOY_HOST=contabo DEPLOY_DIR=/home/cocojs/mastermind DEPLOY_OWNER=cocojs tools/deploy.sh
#
# Variables:
#   DEPLOY_HOST     ssh host or alias that can write to DEPLOY_DIR and restart the service (required)
#   DEPLOY_DIR      install directory on the server (required)
#   DEPLOY_SERVICE  systemd unit to restart                       (default mastermind)
#   DEPLOY_OWNER    user that owns the files and runs the service  (default: unchanged)
#
# Everything except server/data (the live games and the scoreboard), node_modules, .git and .claude is
# sent, so a redeploy never touches the scores. First-time setup (unit file, Apache include) is in
# deploy/README.md; until the unit exists the script only copies the files.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HOST=${DEPLOY_HOST:?set DEPLOY_HOST to an ssh host or alias}
DIR=${DEPLOY_DIR:?set DEPLOY_DIR to the install directory on the server}
SERVICE=${DEPLOY_SERVICE:-mastermind}
OWNER=${DEPLOY_OWNER:-}

echo "mastermind -> $HOST:$DIR (service $SERVICE)"
tar czf - -C "$HERE" --exclude=server/data --exclude=node_modules --exclude=.git --exclude=.claude . \
  | ssh "$HOST" "set -e; mkdir -p '$DIR/server/data'; tar xzf - -C '$DIR'; ${OWNER:+chown -R '$OWNER:$OWNER' '$DIR';} \
      if systemctl list-unit-files 2>/dev/null | grep -q '^$SERVICE.service'; then systemctl restart '$SERVICE'; sleep 1; echo \"service: \$(systemctl is-active '$SERVICE')\"; \
      else echo 'service $SERVICE is not installed yet: see deploy/README.md'; fi"
