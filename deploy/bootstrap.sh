#!/bin/bash
# First-boot setup, run by the EC2 UserData (as root). Idempotent — safe to
# re-run. Installs Bun + Caddy, builds the app, wires up systemd, and starts
# the services. Secrets are fetched separately (fetch-secrets.sh).
set -euxo pipefail

REPO_DIR=/home/ec2-user/hypergpt
EC2_USER=ec2-user
BUN=/home/ec2-user/.bun/bin/bun

# --- Swap: t4g.nano has only 512MB RAM; the Vite build needs headroom or it
# OOMs and wedges the box (SSM included). A 2GB swapfile covers it. ---
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Bun (installed into the ec2-user home) ---
if [ ! -x "$BUN" ]; then
  sudo -u "$EC2_USER" bash -c 'curl -fsSL https://bun.sh/install | bash'
fi

# --- Caddy (static arm64 binary) ---
if [ ! -x /usr/local/bin/caddy ]; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64" \
    -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi

# --- Build the app (as ec2-user, in the repo) ---
cd "$REPO_DIR"
sudo -u "$EC2_USER" "$BUN" install
sudo -u "$EC2_USER" "$BUN" run build

# --- Directories ---
mkdir -p /var/lib/hypergpt /etc/hypergpt /etc/caddy
chown "$EC2_USER":"$EC2_USER" /var/lib/hypergpt

# --- App env file (DATA_DIR etc.); the API key is filled by fetch-secrets ---
bash "$REPO_DIR/deploy/fetch-secrets.sh" || true

# --- Basic-auth password (random, generated once) ---
# Stored hashed for Caddy; plaintext written to a root-only file you can read
# over SSM. Regenerate any time by deleting /etc/caddy/env and re-running.
if [ ! -f /etc/caddy/env ]; then
  set +x  # stop tracing — keep the password/hash out of the bootstrap log
  PW="$(openssl rand -base64 18)"
  HASH="$(/usr/local/bin/caddy hash-password --plaintext "$PW")"
  echo "HYPERGPT_PASSWORD_HASH=${HASH}" > /etc/caddy/env
  chmod 600 /etc/caddy/env
  echo "$PW" > /root/hypergpt-initial-password.txt
  chmod 600 /root/hypergpt-initial-password.txt
  set -x
fi

# --- systemd + Caddy config ---
cp "$REPO_DIR/deploy/hypergpt.service" /etc/systemd/system/hypergpt.service
cp "$REPO_DIR/deploy/caddy.service" /etc/systemd/system/caddy.service
cp "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now hypergpt
systemctl enable --now caddy

echo "Bootstrap complete. Basic-auth user is 'hyper'; password in /root/hypergpt-initial-password.txt"
