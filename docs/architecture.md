# Architecture

How v1 actually runs, what it's built out of, and how the pieces fit together. This doc commits to the concrete choices we deferred in product-design and data-model. Anything still open is in the open questions at the bottom.

## Topology

A single Bun process on a small VPS, serving both the backend API and the static frontend. The user's phone reaches it over HTTPS via Safari and can install it to the home screen as a PWA.

```
  iPhone Safari ──HTTPS──> Caddy ──reverse proxy──> Bun process
                                                      │
                                                      ├── Hono (HTTP routes + SSE)
                                                      ├── Drizzle ORM
                                                      ├── SQLite (single file)
                                                      └── Provider adapters
                                                            (Anthropic / OpenAI)
                                                              │
                                                              └──HTTPS──> Anthropic / OpenAI APIs
```

There is no separate database server, no separate frontend server, no broker. One process, one file, one box. Adding complexity to that picture is a future-features problem.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | Fast, native SQLite via `bun:sqlite`, native TypeScript, ergonomic for this scale. |
| Backend framework | **Hono** | Thin, no opinions about data layer, first-class Bun support. Avoids meta-framework lock-in. |
| Data store | **SQLite** (single file) | Embedded, transactional, indexable, FTS5 for future search. One file = trivial backups. |
| ORM | **Drizzle** | TypeScript-native, schema-first, queries look like nested-document fetches. No raw SQL for 95% of operations. |
| Frontend build | **Vite** | Standard, fast, no framework opinions beyond the bundler. |
| Frontend framework | **React** | Largest ecosystem, easiest to find libraries for canvas/graph rendering, comfortable territory. |
| Streaming protocol | **SSE** (Server-Sent Events) | Simpler than WebSockets for one-way server→client streams; reconnects natively; works through any HTTP proxy. |
| TLS / reverse proxy | **Caddy** | Auto-issues Let's Encrypt certs, zero config beyond `host { reverse_proxy localhost:3000 }`. |
| Process supervision | **systemd** | Boring, works. One unit file. |
| Host | **AWS EC2 `t4g.micro`** (ARM/Graviton) | ~$6/mo on-demand. Started on `t4g.nano` ($3/mo) but 512MB OOMs during the on-box vite build; micro's 1GB has headroom. Litestream-to-S3 keeps backups in the same region for free. |
| PWA support | manifest.json + service worker | Installs to iOS home screen, opens fullscreen. No offline support in v1. |
| Auth | **Single shared secret** in env var | One user, one secret, middleware checks header. Real auth is a future-features problem. |

## Module layout

```
hypergpt/
├── backend/
│   ├── server.ts              # Hono app entrypoint; mounts routes; serves frontend static build
│   ├── routes/                # HTTP routes mapping to LocalBackend interface
│   ├── backend/
│   │   ├── interface.ts       # The LocalBackend interface (per data-model.md)
│   │   └── sqlite.ts          # SQLite + Drizzle implementation of LocalBackend
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema (Canvas, Node, Message, Edge, User, ProviderConfig)
│   │   └── migrations/        # Drizzle Kit-generated migration files
│   ├── providers/
│   │   ├── interface.ts       # Provider abstraction (per future provider doc)
│   │   ├── anthropic.ts
│   │   └── openai.ts
│   └── streaming/
│       └── sse.ts             # SSE response helpers; persistence-as-you-stream
├── frontend/
│   ├── src/
│   │   ├── views/             # ChatView, MapView, CanvasListView
│   │   ├── components/        # MessageList, SpinOffButton, FloatingHeader, etc.
│   │   ├── lib/api.ts         # Typed client for the backend; SSE handling
│   │   ├── lib/store.ts       # Client-side cache of opened nodes
│   │   └── main.tsx
│   ├── public/
│   │   ├── manifest.json      # PWA manifest
│   │   └── service-worker.ts
│   └── vite.config.ts
├── shared/
│   └── types.ts               # Canvas, Node, Message, Edge, ContentPart, StreamEvent — imported by both sides
├── docs/
└── README.md
```

The `shared/` folder is the seam: types defined once, imported by both backend and frontend. There is no separate code-generation step — TypeScript already does this.

## The HTTP surface

The functions defined in [data-model.md](./data-model.md) become HTTP routes. The mapping is mechanical: every backend interface method gets one route, takes `userId` explicitly in the URL or body (per the explicit-arguments preference), and returns JSON. Streaming operations return SSE instead of JSON.

```
# Reads
GET    /api/users/:userId/canvases                      → Canvas[]
GET    /api/users/:userId/canvases/:canvasId            → { canvas, nodes, edges }
GET    /api/users/:userId/nodes/:nodeId                 → { node, messages, inboundEdge?, outboundEdges }
GET    /api/users/:userId/nodes/recent?limit=N          → Node[]

# Writes (non-streaming response, then SSE for the model output)
POST   /api/users/:userId/canvases                      → { canvas, seedNode }; then GET /stream/:messageId
POST   /api/users/:userId/nodes/:nodeId/messages        → { userMessage }; then GET /stream/:messageId
POST   /api/users/:userId/spawn                         → { node, edge, firstUserMessage }; then GET /stream/:messageId
PATCH  /api/users/:userId/canvases/:canvasId            → Canvas (rename)
PATCH  /api/users/:userId/nodes/:nodeId                 → Node (rename)
DELETE /api/users/:userId/canvases/:canvasId            → 204

# Streaming
GET    /api/stream/:messageId                            → SSE: message_start, content_delta..., message_complete | error
```

Every request carries the shared-secret in an `Authorization: Bearer <SECRET>` header; middleware rejects anything else. The `userId` in the URL must match the single configured local user; mismatch → 403. This is the assertion-check pattern from data-model.md, instantiated.

### Streaming pattern

Write endpoints return synchronously with the new entity ids, including a `messageId` for the assistant response that will stream. The frontend immediately opens an `EventSource` to `/api/stream/:messageId` to subscribe to chunks.

Why split write + stream into two requests instead of one streaming write:

- Cleaner failure modes — if the write succeeds and the stream connection drops, the assistant message is already a persisted (`status: "streaming"`) row in SQLite. The frontend can reconnect to the stream OR re-fetch the node and find the in-progress message.
- Simpler client code — the write returns a normal JSON response; the stream is its own concern.
- Multiple tabs / future second device can attach to the same stream by id.

While a message is streaming, the backend persists chunks to the SQLite row as they arrive (debounced, ~10 chunks per write to avoid hammering the DB). On `message_complete`, status transitions to `"complete"` and `completed_at` is set.

## Local dev

`bun run dev` runs Vite (frontend hot reload on `:5173`) and Hono (backend on `:3000`) concurrently. The frontend proxies `/api/*` to the backend via Vite's dev server config. SQLite db file lives in `./data/dev.db`. Drizzle Kit watches `schema.ts` and offers to generate migrations on change.

## Deployment

A single EC2 `t4g.micro` instance running Amazon Linux 2023 (or Ubuntu — either fine; Amazon Linux is the conventional pick if you want maximum AWS-shaped tooling).

- **Instance:** `t4g.micro` (ARM Graviton, 1GB, ~$6/month on-demand; cheaper reserved). Bun has first-class ARM support. Started on `t4g.nano` (0.5GB) but the on-box `vite build` OOM'd it; micro has the headroom. A 2GB swapfile (created in `bootstrap.sh`) stays as a safety margin.
- **Storage:** ~10 GB `gp3` EBS volume (~$1/month). SQLite db lives at `/var/lib/hypergpt/prod.db`.
- **Networking:** security group locked to inbound 80/443 from `0.0.0.0/0` and SSH (22) restricted to your IP (or use SSM Session Manager and close 22 entirely). No ALB — Caddy on the instance handles TLS termination directly.
- **Static IP:** Elastic IP attached so the public address survives stop/start (~$3.60/month while in use).
- **DNS:** see "Address & TLS" below.
- **Process:** one systemd unit running `bun run start` (serves the pre-built frontend statically + runs the API).
- **Updates:** `git pull && bun install && bun run build && systemctl restart hypergpt`.

Approximate monthly cost: **~$4–8** (instance + EBS + S3 backups + optional Elastic IP).

### Address & TLS (two-phase)

PWA install on iOS Safari requires HTTPS, but HTTPS requires a hostname (Let's Encrypt won't issue free certs for raw IPs). So:

- **Phase 1 — iterate fast.** Plain HTTP on the EC2 public IP. Caddy listens on 80, no TLS. Use a desktop browser to develop and test. PWA install won't work yet; that's fine because the mobile experience isn't being tested at this phase anyway.
- **Phase 2 — mobile install matters.** Switch to **`sslip.io`** (or `nip.io`) for a free wildcard hostname: `<ip-with-dashes>.sslip.io` resolves to `<ip>`. Caddy auto-issues a Let's Encrypt cert for that hostname. Two-line Caddyfile change. URL is ugly but works.
- **Phase 3 — eventually.** Register a real domain through **Route53** (or transfer one you own). Hosted zone is $0.50/month, queries are pennies. Add an `A` record pointing the apex (or a subdomain) at the Elastic IP. Caddy config swap is trivial — replace the sslip.io hostname with the real one and it auto-issues a new cert. No ACM, no ALB, no CloudFront — Caddy stays as the TLS terminator on the instance. The whole DNS setup is one record in one console you're already in.

No private-network setup (Tailscale, VPC peering) in v1 — the app is reachable from the public internet, gated by the shared-secret middleware.

### Backups

The whole database is one file. v1 backup is **Litestream** replicating SQLite continuously to **S3 in the same region** as the EC2 instance. Same-region S3 traffic is free (no egress charges), storage is cents/month, and Litestream gives real point-in-time restore. Pre-configure the bucket and IAM role with `s3:GetObject`/`PutObject` for the bucket; attach the role to the instance.

Belt-and-suspenders option: also enable AWS Backup nightly snapshots of the EBS volume. Coarser-grained than Litestream but zero code.

Losing the db file is losing everything; set this up before doing anything interesting in the app.

## Schema migrations

Drizzle Kit generates migration files from schema changes. On app start, the backend runs any pending migrations against the SQLite file before opening the rest of the server. Numbered, ordered, idempotent. Day-one discipline — the first migration creates the initial schema.

## PWA on iOS

- `manifest.json` declares display: standalone, theme colors, icons.
- Service worker registered for: (a) install (so the "Add to Home Screen" prompt appears), (b) basic asset caching. **No offline-first data caching in v1** — too easy to get wrong; everything is online-only.
- Tested by adding to home screen on the actual phone; iOS Safari treats it as a near-native app from there (fullscreen, own icon, own task in app-switcher).

## Provider calls

The backend (never the frontend) makes outbound HTTPS calls to Anthropic / OpenAI. API keys live in env vars (or in the ProviderConfig table — the provider doc will decide; both work). Streaming model responses arrive as SSE-like protocol from the provider, are forwarded as our SSE events to the browser, and are persisted to SQLite as they go.

## What this architecture deliberately doesn't have

- No separate database process.
- No separate frontend hosting.
- No message broker, no Redis.
- No real authentication.
- No multi-region anything.
- No CDN — single VPS serves static assets; that's fine at this traffic scale.
- No client-side offline support.
- No background jobs / queues.

Each of those is a future-features problem. Adding one means the v1 hypothesis is being stretched, and we should be honest about which one and why.

## Open questions

(All previously-deferred architecture decisions — VPS provider, address & TLS strategy, schema migration tooling, frontend state management, map view rendering — are now committed. See [map-view.md](./map-view.md) for the map view design, including the React Flow vs. custom-SVG decision and the spike that resolves it.)
