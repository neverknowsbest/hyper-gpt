# Deployment

How HyperGPT gets to `https://hyper-gpt.com`. Infra is CDK (TypeScript) in
`infra/`; the on-box config lives in `deploy/`. Everything runs in
**us-east-1**.

## What gets created

Two CDK stacks:

- **HyperGptNetwork** — a described-in-code VPC (`10.0.0.0/16`, public
  subnets only, **zero NAT gateways**), tagged `Name=hypergpt`. Separate
  stack because the network is rarely touched and should be cleanly
  reproducible / destroyable rather than relying on the account default VPC.
- **HyperGptApp** — a `t4g.nano` (Amazon Linux 2023, ARM) in a public
  subnet of that VPC, a 10 GB encrypted gp3 root volume, a security group
  (inbound 80/443 only — no SSH), an instance role with SSM Session Manager
  access + read on `/hypergpt/*` SSM params + scoped KMS decrypt, an Elastic
  IP, UserData that bootstraps the box, and the `A` records for
  `hyper-gpt.com` + `www.hyper-gpt.com` pointing at the EIP.

The two stacks are decoupled with **no CloudFormation cross-stack exports**:
the app stack finds the VPC via `Vpc.fromLookup({ tags: { Name: "hypergpt" }})`,
and the DNS records live in the same stack as the EIP they point at. The
trade-off is that the **first** deploy is two-phase — the network stack must
exist before the app stack synthesizes (the lookup needs a real VPC to find).

On the box: **Caddy** terminates TLS (auto Let's Encrypt), serves the built
SPA, reverse-proxies `/api/*` to the **Bun backend** (systemd unit
`hypergpt`), and gates everything behind HTTP basic auth.

## Prerequisites (laptop)

- AWS credentials for your account configured locally (`aws sts
  get-caller-identity` works), targeting us-east-1.
- `hyper-gpt.com` registered in Route53 (done).
- Bun installed (for running the CDK app).
- **Edit `infra/cdk.json`**: set `context.repoUrl` to your public GitHub
  clone URL (currently a `CHANGE_ME` placeholder).
- Push this repo to that GitHub URL — the instance clones it at boot.

## First deploy

### 1. Provision infra (two-phase, first time only)

```
cd infra
bun install
bunx cdk bootstrap                 # once per account+region; you may already have it
bunx cdk deploy HyperGptNetwork    # create + tag the VPC first
bunx cdk deploy HyperGptApp        # now the VPC lookup resolves
```

Deploy the network stack **before** the app stack the first time — the app
stack's `Vpc.fromLookup` needs the VPC to already exist, and running
`cdk deploy --all` on a clean account would synth the app stack against a
dummy VPC and cache it in `cdk.context.json`. After both stacks exist,
`cdk deploy HyperGptApp` (or `--all`) is fine for subsequent changes.

The hosted-zone lookup also runs at synth and writes `cdk.context.json`.
`HyperGptApp` prints the public IP and an `aws ssm start-session …` command
when it finishes. The box is now bootstrapping itself (cloning the repo,
installing Bun + Caddy, building, starting services) — give it a few minutes.

### 2. Put the Anthropic key in SSM

CloudFormation can't create SecureString params, so you create it (the
instance role already has read access):

```
aws ssm put-parameter \
  --name /hypergpt/anthropic-api-key \
  --type SecureString \
  --value sk-ant-your-key \
  --region us-east-1
```

### 3. Load the key + grab the basic-auth password

Open a shell on the box (no SSH needed):

```
aws ssm start-session --target <instance-id> --region us-east-1
```

Then on the box:

```
sudo bash /home/ec2-user/hypergpt/deploy/fetch-secrets.sh
sudo systemctl restart hypergpt
sudo cat /root/hypergpt-initial-password.txt   # the basic-auth password
```

Basic-auth username is `hyper`; the password is the value you just printed.

### 4. Verify

Wait for DNS to propagate (the A record TTL is 5 min; first resolution may
take a little longer) and for Caddy to obtain a cert. Then open
`https://hyper-gpt.com`, log in with `hyper` + the password, and create a
canvas.

If the cert isn't issuing, check `sudo journalctl -u caddy -f` on the box —
the usual cause is the A record not yet resolving to the EIP, so Let's
Encrypt's HTTP challenge can't reach you.

## Updating the code

After pushing changes to GitHub:

```
aws ssm start-session --target <instance-id> --region us-east-1
# on the box:
bash /home/ec2-user/hypergpt/deploy/update.sh
```

`update.sh` does `git pull` → `bun install` → `bun run build` → restart the
backend (migrations run on startup) → re-sync + reload Caddy.

## Updating infra

Edit `infra/lib/*.ts`, then:

```
cd infra && bunx cdk diff && bunx cdk deploy --all
```

(`--all` is safe here since both stacks already exist — the two-phase
ordering only matters on the very first deploy.)

## Rotating the basic-auth password

```
# on the box:
sudo rm /etc/caddy/env
sudo bash /home/ec2-user/hypergpt/deploy/bootstrap.sh   # regenerates + restarts
sudo cat /root/hypergpt-initial-password.txt
```

## Rotating the Anthropic key

```
aws ssm put-parameter --name /hypergpt/anthropic-api-key \
  --type SecureString --value sk-ant-new --overwrite --region us-east-1
# on the box:
sudo bash /home/ec2-user/hypergpt/deploy/fetch-secrets.sh
sudo systemctl restart hypergpt
```

Note: the key is also bootstrapped into the `provider_configs` table on first
launch. If you rotate it, update it in the app's Settings too (or clear the
DB row so the env value re-bootstraps).

## Not yet wired up

- **Backups (Litestream → S3).** The instance role doesn't grant S3 yet and
  there's no Litestream config. Add when there's data worth protecting — see
  `architecture.md`. Until then, the SQLite file lives only on the EBS volume;
  an EBS snapshot schedule (AWS Backup) is the zero-code stopgap.
- **PWA install.** Lands after this — needs the HTTPS origin that this
  deploy provides. See `tasks.md`.
