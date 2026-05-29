#!/bin/bash
# Trigger a deploy on the box from your LAPTOP via SSM — no interactive
# session, no SSH. Sends `update.sh` to the instance via Run Command, waits,
# and prints the result.
#
#   bash deploy/remote-deploy.sh            # auto-resolves the instance
#   bash deploy/remote-deploy.sh i-0abc123  # or pass the instance id
#
# Needs AWS creds with ssm:SendCommand (your IdC admin role has it) and an
# active SSO session (aws sso login).
set -euo pipefail

REGION=us-east-1

# Resolve the instance from the Elastic IP's Name tag (set by the CDK app
# stack) unless an id was passed explicitly.
INSTANCE_ID="${1:-$(aws ec2 describe-addresses \
  --filters "Name=tag:Name,Values=hypergpt" \
  --query 'Addresses[0].InstanceId' \
  --output text --region "$REGION")}"

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "Could not resolve the instance id. Pass it as the first argument." >&2
  exit 1
fi

echo "Deploying to ${INSTANCE_ID} via SSM…"

CMD_ID="$(aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --comment "hypergpt deploy" \
  --parameters 'commands=["bash /home/ec2-user/hypergpt/deploy/update.sh"]' \
  --query 'Command.CommandId' --output text --region "$REGION")"

echo "Command ${CMD_ID} sent; waiting for it to finish…"
aws ssm wait command-executed \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" || true

STATUS="$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" \
  --query 'Status' --output text)"

echo ""
echo "=== status: ${STATUS} ==="
echo "--- stdout ---"
aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" \
  --query 'StandardOutputContent' --output text
ERR="$(aws ssm get-command-invocation \
  --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --region "$REGION" \
  --query 'StandardErrorContent' --output text)"
if [ -n "$ERR" ]; then
  echo "--- stderr ---"
  echo "$ERR"
fi

[ "$STATUS" = "Success" ]
