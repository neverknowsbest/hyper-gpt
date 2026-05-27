# Tasks

Long-term task list for HyperGPT v1. Source of truth for "what's done, what's next." Update as work lands.

Deferred features (things we considered and decided against for v1) live in [future-features.md](./future-features.md), not here.

## Done

- [x] **Initial design docs.** All seven design docs in `docs/`: product, data-model, architecture, provider, mobile-ux, map-view, future-features.
- [x] **Scaffold project.** Bun + Hono backend, Vite + React frontend, Drizzle ORM over `bun:sqlite`. `bun run dev` launches both with `/api` proxy. TypeScript clean. `.env` auto-loaded.
- [x] **Full data model: 6 tables with migrations.** users, canvases, nodes, messages, edges, provider_configs. FKs, indices, v1 tree constraint (UNIQUE on `edges.target_node_id`). Drizzle Kit migrations applied at boot.
- [x] **End-to-end canvas + messaging slice with SSE streaming.** Transactional POST canvas creation (canvas + seed node + user msg + placeholder assistant msg). Follow-up message endpoint. SSE stream endpoint with in-process pub/sub hub for live updates and SQLite replay for late/disconnected clients. React frontend with canvas list + ChatView consuming EventSource. Send disabled mid-stream. Verified end-to-end with real key.
- [x] **Anthropic provider with prompt caching.** Adapter using `@anthropic-ai/sdk` implementing the `ModelProvider` interface. Error-code mapping (auth / rate_limit / context_too_long / unknown). Prompt caching: `cache_control: ephemeral` on the last content block of the last assistant message so long histories and spawn-context replays are cache reads. Env-var bootstrap of keys into `ProviderConfig` on first launch.
- [x] **Spawn slice.** `POST /api/users/:userId/spawn` creates node + edge (citation snapshot) + first user message + placeholder assistant in one transaction. `buildContext()` extracted in the orchestrator: if a node has an inbound edge, it prepends the parent's complete messages up to and including the cited message, and folds a synthetic citation prefix into the spawned node's first user turn. Frontend: `selectionchange` detects selections inside assistant bubbles, "Spin off" floating button positions near the selection, modal collects the first message (or no message = standalone "elaborate on this" framing), navigates to the new node on submit. Inline citation highlights render in parent transcripts as inline `<span>` tap-targets. Floating parent header at the top of spawned-node ChatView taps back to parent.
- [x] **Map view.** New `GET /api/users/:userId/canvases/:canvasId` returns the full structure (`{canvas, nodes, edges}`). Frontend uses `@xyflow/react` + `d3-hierarchy` tidy-tree layout (vertical orientation, root at top). Custom node card shows title + outbound tangent count + seed indicator; currently-visited node is accent-highlighted. Smooth-step edges, low-contrast stroke. Tap a node to jump into Chat view for it. Built-in minimap appears once the canvas has ≥6 nodes. App-level Chat/Map toggle in a canvas top bar.

## Upcoming

In rough priority order.

### Next Decision spike on real iOS Safari: React Flow vs custom SVG + `@use-gesture/react` (gating criterion is pinch/pan quality). Reingold-Tilford tidy tree via `d3-hierarchy`, vertical orientation. Node cards (~180×52). Curved Bézier edges. Pan/zoom/tap-to-enter, double-tap-empty to fit-all, long-press for rename/delete. Minimap when ≥6 nodes. Recents strip. State sync is pull-on-enter + invalidate-on-write.
- [ ] **Mobile responsiveness + gestures.** Convert the current desktop layout into the screen hierarchy from `mobile-ux.md` (Canvases list → Map → Chat). Replace the 280px sidebar with proper screen-level nav. `100dvh` + sticky-bottom composer + `visualViewport` listener for iOS keyboard handling. Tap targets ≥44pt. Selection-menu coexistence with iOS native menu (250ms debounce). Chat ↔ Map crossfade transitions. Swipe-back gesture. Test on real iPhone over LAN before PWA work.
- [ ] **Settings UI for API key management.** Settings drawer per `mobile-ux.md`: per-provider key entry with masked display (`sk-•••••AB12`), default provider + model selection. Backend: `PUT /api/users/:userId/provider-configs/:provider` and `DELETE` same. Removes env-var-bootstrap as the only key-entry path.
- [ ] **PWA install** (blocked by mobile responsiveness + an HTTPS path).
  - `manifest.json`: `display: standalone`, theme/background colors, icons at 192/512 + apple-touch-icon 180.
  - Service worker: cache static assets only — no API response caching in v1.
  - One-time banner instructing manual Share → Add to Home Screen (iOS gives no programmatic prompt).
  - Requires HTTPS to actually install on iOS, so lands together with (or after) Tailscale / sslip.io / real-domain setup.
- [ ] **EC2 deployment** (when the local experience is good enough to want to carry it around). Per `architecture.md`. `t4g.nano` Amazon Linux 2023, EBS gp3 ~10GB, Elastic IP, security group inbound 80/443. systemd unit. Three-phase address: HTTP-on-IP → sslip.io → Route53 domain. Litestream → S3 same-region for backups. Update flow: `git pull && bun install && bun run build && systemctl restart`.

## Notes

- Open questions that aren't blocking ("title generation," "soft delete," "concurrency," etc.) live in the **Open questions** sections of individual design docs, not here.
- When a task lands, move it to **Done** (with a brief one-line summary of what shipped), don't just check the box.
- If a new task surfaces from working on another, add it under **Upcoming** in priority order. Don't accumulate stale entries — delete or move to future-features.md if scope changes.
