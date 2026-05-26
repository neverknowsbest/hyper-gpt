# Map View

The map view is the spatial visualization of a canvas's tree of conversations. It's the "see the shape of my inquiry" surface — secondary to Chat view in time-spent, but primary to the product's identity. This doc commits the rendering tech, the layout, the visual language, and the interaction details.

## What the map view is (and isn't)

It **is**:
- A pan-and-zoomable view of one canvas's tree of nodes.
- A navigation surface — tap a node to enter its Chat view.
- The place where the user sees the structure of what they've explored.

It **isn't**:
- A free-form whiteboard. The user doesn't position nodes by hand; layout is derived.
- A graph editor. You can't drag edges around or rewire the tree.
- A search/browse-everything view across canvases. That's a future feature.

Time spent here is short and intermittent — pop in to navigate, pop out. The view has to make orientation and re-entry fast, and that's it.

## Tech choice: React Flow (with a fallback)

**Primary pick: [React Flow](https://reactflow.dev/)**. Reasons:
- Battle-tested node-graph library with built-in pan/zoom/viewport state.
- Custom node rendering via plain React components — we have full control of the node card visuals.
- Built-in minimap (which we want).
- Active maintenance, decent docs.

**The risk to validate early:** mobile pinch-zoom + one-finger pan on iOS Safari. Reports of jankiness exist. If a 30-minute spike on a real iPhone reveals gesture quality is bad enough to hurt the "speed and clarity" principle, fall back to:

**Fallback: custom SVG + `@use-gesture/react` for gestures + `d3-hierarchy` for layout.** More code to write but full control of gesture behavior. Same data structure flows in; only the rendering layer changes.

This decision should happen in the first week of frontend implementation, not be deferred. The downstream UI (node card design, animations) is the same either way — what changes is which library renders it.

## Layout algorithm

A canvas is a tree (one inbound edge per node), rooted at the seed. Layout is:

- **Reingold-Tilford tidy tree** via `d3-hierarchy`'s `d3.tree()` layout. Produces minimum-width compact trees with non-overlapping nodes.
- **Vertical orientation by default** — root at the top, children growing downward. This is the conventional reading order and matches how branching is rendered in version-control UIs (which users are more familiar with than mind-map software).
- **Recomputed on every tree change.** For tens of nodes, recomputation is microseconds. No need to cache positions across renders.

Layout produces `(x, y)` coordinates per node, which React Flow then uses for absolute positioning. Edges are inferred from the node tree — no separate edge layout step.

### Why not horizontal

A phone screen is taller than it is wide. Horizontal-tree (root at left, growing right) has its merits — node titles read naturally without wrapping — but it pushes wide trees into horizontal-pan-only territory, which on a vertical phone feels worse. Vertical lets the user pan in both axes equally and keeps the "trunk" at the top, which matches a normal conversation reading order.

Horizontal as a user toggle is a future feature, not v1.

## Node card design

Each node renders as a compact card:

```
┌────────────────────────────────┐
│ Transformers explainer         │  ← title (auto or user-set), 1–2 lines
│ 6 messages · 3 tangents        │  ← message count · outbound edge count
└────────────────────────────────┘
```

- Width: ~180px. Height: ~52px. Tap target is the whole card.
- **Currently-visited node** (where the user was last in Chat view): subtle accent border + slightly larger.
- **Seed node**: visually distinct (a small "root" marker, maybe a filled dot in the corner) — orientation cue when zoomed in.
- **Streaming node** (an assistant response is mid-stream in this conversation): pulse animation on the border. Tells the user there's live activity here.

Title source: the heuristic from mobile-ux.md ("first ~40 chars of seed user message"). LLM-generated titles are a future polish.

## Edge design

- **Curved Bézier** from parent-bottom to child-top. Subtle, ~1.5px stroke.
- Color: low-contrast neutral. Edges aren't the focus — they show structure, they don't carry information beyond "there's a connection here."
- **No edge labels in v1.** Showing the cited text on each edge is informative but visually busy at tree scale. The information lives inside the Chat view (inline highlights + parent header). Edge labels stay in future-features.

## Interactions

| Gesture | Behavior |
|---|---|
| One-finger drag on empty area | Pan |
| Two-finger pinch / spread | Zoom |
| Tap a node | Enter its Chat view (transition: see Animations below) |
| Tap empty space | Nothing (no accidental zoom-out) |
| Double-tap empty space | Reset to fit-all |
| Double-tap on a node | Same as single tap (don't make the user wait for double-tap detection) |
| Long-press on a node | Context menu: rename, delete |
| Back button / swipe-from-left-edge | Up to Canvases list |
| "Fit all" button (corner of map view) | Animate viewport to fit the whole tree |

### Zoom constraints

- **Min zoom**: fit-all-bounds at current viewport size. The user can never zoom out further than "I can see the whole canvas." Beyond fit-all is just empty space, no signal.
- **Max zoom**: ~2.5×. Beyond that, node cards are huge but you can only see one or two — useless.
- Inertial panning with light damping. iOS users expect this.

### Tap vs. drag disambiguation

A tap on a node card has to register as "open this node" only if the touch was a *stationary* press (no significant drag). Threshold: <8px of movement before lift. Otherwise it's a pan gesture. React Flow handles this; if we fall back to custom, `@use-gesture/react` does too.

## Animations and transitions

The map view feels alive through small, fast animations. Every animation is ≤250ms — they communicate state changes without slowing the user down.

- **New node spawned:** the node card fades in at its computed position, with a quick scale-from-0.8 bounce. The edge to its parent draws in (`stroke-dasharray` animation, ~200ms). Total ~250ms.
- **Map → Chat (tapping a node):** the tapped node scales up + fades out as the Chat view fades in. Crossfade is fast (~200ms) so it feels like zooming into the conversation rather than navigating away.
- **Chat → Map (tapping the map button in Chat input row):** reverse — Chat fades out, map fades in with the node centered and slightly highlighted, then settles.
- **Layout reflow:** when the tree structure changes (new node, deleted node), surviving nodes animate to their new positions (~250ms ease-out). No abrupt jumps. React Flow handles this via its `nodes` prop + automatic transitions; in the custom path we'd interpolate positions ourselves.

## Viewport state

The viewport (pan offset + zoom level) is **per-session-per-canvas, not persisted to disk**.

- First visit to a canvas in a session: fit-all.
- Returning to map view of a canvas already visited this session: restore the previous viewport.
- After spawning a new node and switching to map: center on the new node (don't auto-fit, which would jerk the view).
- App restart: viewport state is gone, reset to fit-all.

Persisting viewport across app restarts is possible (localStorage) but adds a small cache to maintain and isn't worth the complexity for v1.

## Minimap

When the canvas exceeds the viewport, a small minimap in the corner shows the whole tree and a rectangle for the current viewport. Tap the minimap to jump-pan there.

- Below a threshold (≤6 nodes, say), hide the minimap — it's redundant when the whole tree fits comfortably in the viewport.
- React Flow provides this out of the box. In the custom fallback path, this is a second small SVG render of the same tree at low zoom.

## Recents strip

Per mobile-ux.md, a horizontal-scrolling strip at the bottom of Map view shows the last ~5 nodes visited in this canvas:

```
┌─────────────────────────────────┐
│  Recent: [Attention] [QKV math] │
│          [Layer norm] ...       │
└─────────────────────────────────┘
```

- Tap a chip → enter that node's Chat view directly (no need to find the dot on the map).
- Visible only when the canvas has >3 nodes. Below that, the map IS the navigation.

## State synchronization

The map view's data — nodes, edges, titles, message counts, "currently-visited" — has to stay in sync with the rest of the app.

- **On entering map view:** fetch fresh canvas structure (`GET /api/users/:userId/canvases/:canvasId`). Cheap query (canvas + node list + edge list, no messages).
- **On spawn from Chat view:** the client-side cache for this canvas's structure is invalidated. Next time map view opens, fresh fetch.
- **On rename or delete:** same invalidation pattern.
- **On streaming completion** in a node (which might update "last activity" on the node card): debounced invalidation — don't refetch the whole canvas structure on every token, but do refetch when an assistant message completes.

We don't push live updates from the server to the map view in v1. The map is a snapshot the user pulls; not a live dashboard.

## Performance and scale

- v1 expects tens of nodes per canvas. SVG renders that trivially.
- 100–300 nodes: still fine for SVG. Layout recompute is fast enough.
- 1000+ nodes: would want virtualization (only render nodes within the viewport) or canvas-based rendering. Not a v1 concern.

If we ever hit perf issues, the fix is: drop SVG nodes for canvas-rendered ones (lose accessibility) or virtualize via React Flow's built-in viewport culling.

## Edge cases

- **Single-node canvas (just the seed).** Map view shows the seed in the center. Visually thin, but valid. The user can spawn from it via Chat view's selection gesture and see the tree grow.
- **Streaming the seed message of a brand-new canvas.** The seed node appears immediately (status "streaming"); the user can swipe to map view and see it pulsing, even before the first response completes.
- **Deleted nodes.** v1 has hard delete at the canvas level only; we don't delete individual nodes inside a canvas. If we ever do, deleted nodes vanish from the map with a fade-out animation, and the layout reflows.

## What's deliberately out of scope (v1)

- **Edge labels** showing cited text.
- **Search / filter inside the map** ("show me nodes mentioning X").
- **Manual node positioning** — the layout is the layout.
- **Horizontal-orientation toggle**.
- **Cross-canvas map view** — only one canvas at a time.
- **Live updates from the server** (subscriptions / push). Map is pull-on-enter.

## Open questions

- **React Flow vs. custom — confirmed by spike.** Resolve via a real-iPhone test in week 1 of frontend implementation. Decision criterion: does pinch-zoom and one-finger pan feel like a native app, or like wrestling with a webpage?
- **What does a brand-new empty canvas show?** Tapping a fresh canvas opens to Chat view of the seed node with the input focused — the user types their first prompt. The map view isn't seen until something exists in it. So edge case (truly empty canvas, zero nodes) doesn't exist in practice — a canvas is created together with its seed node.
- **Hit-area for tapping a node.** Card is ~180×52px; the tap area should extend a few pixels beyond the visible card so fat-finger taps are forgiving. ~6px invisible padding.
- **Animation budget.** All transitions are ≤250ms in the doc, but the cumulative feel of "tap card → see Chat" matters more than any single animation. Tune on hardware.
