#!/bin/bash
# Fetch secrets from SSM Parameter Store and write the app env file.
# Re-run this (then `sudo systemctl restart hypergpt`) after you set or
# rotate the key in SSM.
set -euo pipefail

ENV_FILE=/etc/hypergpt/env
REGION=us-east-1

mkdir -p /etc/hypergpt

# SecureString you create with:
#   aws ssm put-parameter --name /hypergpt/anthropic-api-key \
#     --type SecureString --value sk-ant-... --region us-east-1
KEY="$(aws ssm get-parameter \
  --name /hypergpt/anthropic-api-key \
  --with-decryption \
  --region "$REGION" \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || echo "")"

cat > "$ENV_FILE" <<EOF
DATA_DIR=/var/lib/hypergpt
DB_FILE=hypergpt.db
PORT=3000
ANTHROPIC_API_KEY=${KEY}
EOF
chmod 600 "$ENV_FILE"

if [ -z "$KEY" ]; then
  echo "WARNING: /hypergpt/anthropic-api-key not found in SSM. Set it, then re-run."
fi
