#!/bin/bash
# Code deploy: pull latest, rebuild, restart the backend. Run as ec2-user on
# the box (it has passwordless sudo for the restart). Migrations run on
# backend startup, so no separate migrate step.
set -euxo pipefail

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
