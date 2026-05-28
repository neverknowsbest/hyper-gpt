#!/bin/bash
# Code deploy: pull latest, rebuild, restart the backend. Migrations run on
# backend startup, so no separate migrate step.
#
# Works whether you invoke it as ssm-user (SSM Session Manager's default),
# root, or ec2-user — it re-execs its body as ec2-user, who owns the repo and
# the Bun install. (ec2-user has passwordless sudo for the systemctl calls.)
set -euo pipefail

if [ "$(id -un)" != "ec2-user" ]; then
  exec sudo -u ec2-user -H bash "$0" "$@"
fi

set -x
REPO_DIR=/home/ec2-user/hypergpt
BUN=/home/ec2-user/.bun/bin/bun

cd "$REPO_DIR"
git pull --ff-only
"$BUN" install
"$BUN" run build

# If the Caddyfile or any deploy config changed, re-sync + reload Caddy.
sudo cp "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo cp "$REPO_DIR/deploy/hypergpt.service" /etc/systemd/system/hypergpt.service
sudo systemctl daemon-reload
sudo systemctl restart hypergpt
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "Deployed $(git rev-parse --short HEAD)."
