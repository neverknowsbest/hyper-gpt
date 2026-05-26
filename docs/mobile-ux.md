# Mobile UX

Concrete UI design for the iOS Safari + PWA experience. The product-design doc establishes *what* the experience is (conversation-as-node, spawn-on-selection, Chat ↔ Map). This doc is *what it looks and feels like on the phone*.

## Design principles (operationalized)

These are the abstract principles from product-design.md, made measurable:

- **Spawn in ≤2 taps.** Select text → tap "Spin off" → typing. No menu trees, no confirmation dialogs.
- **Return in ≤1 tap.** From any spawned node, the floating header is tappable. From any node, the map button is one tap.
- **The trunk action is the lowest-friction action.** Sending a follow-up message in the current node should be effortless: keyboard pre-up, send button always reachable with one thumb.
- **No tiny tap targets.** Every interactive element is ≥44pt (Apple HIG minimum). Citation highlights are tap targets, so their padding has to absorb fat-finger taps.
- **One-thumb operable.** Primary actions reachable from the bottom-third of the screen. Top-of-screen elements (header) are for glance-info, not for tapping mid-conversation.

## Screen hierarchy

```
Canvases list ──tap a canvas──> Map view  ──tap a node──> Chat view
       ↑                            ↑                          │
       │                            └──────tap map button──────┘
       │
       └── Settings (drawer)
```

Three primary screens. Settings is a side-drawer reachable from the Canvases list — not a full screen.

### Screen: Canvases list

The landing screen when the app opens.

```
┌─────────────────────────────┐
│ ☰  HyperGPT          + New  │  ← header (drawer | title | new-canvas)
├─────────────────────────────┤
│  Transformers explainer     │
│  Yesterday · 14 nodes       │
├─────────────────────────────┤
│  Rust ownership rules       │
│  3 days ago · 6 nodes       │
├─────────────────────────────┤
│  ...                        │
└─────────────────────────────┘
```

- Sorted by most-recently-updated.
- Tap a row → enter that canvas (lands on its Map view by default; see "Where does a canvas open?" below).
- Long-press a row → context menu: Rename, Delete.
- "+ New" creates a new canvas with an empty seed-prompt input shown immediately, full-screen — no intermediate dialog.
- "☰" opens the Settings drawer.

### Screen: Map view

The graph of nodes in the current canvas.

```
┌─────────────────────────────┐
│ ←   Transformers explainer  │  ← back to Canvases | canvas title
├─────────────────────────────┤
│                             │
│           ●seed             │
│           │                 │
│      ┌────┴────┐            │
│      ●        ●             │
│      │                      │
│   ●──┴──●                   │
│                             │
├─────────────────────────────┤
│  Recent: [node A] [node B]  │  ← horizontal-scroll recents strip
└─────────────────────────────┘
```

- Pan with one-finger drag. Pinch/spread to zoom.
- Tap a node → enter Chat view for that node.
- Nodes show: short title (first ~20 chars of seed user message, or auto-generated). Currently-visited node is highlighted.
- Edges are simple lines. No edge labels in v1.
- "Recents" strip at the bottom — last ~3 nodes you've been in. Tap to jump. Especially useful when zoomed in deep.
- Back arrow → Canvases list.

### Screen: Chat view

A full-screen conversation inside one node.

```
┌─────────────────────────────┐
│ ←   [↩ Parent: "attention"] │  ← back | floating header to parent (if any)
│         "...attention mech…"│       (taps jump to parent, scrolled to citation)
├─────────────────────────────┤
│  You: explain transformers  │
│                             │
│  AI: A transformer is a     │
│      neural network arch…   │
│      The attention mech-    │
│      [anism] is how the…    │  ← [highlighted] = outbound link, tappable
│                             │
│  You: ...                   │
├─────────────────────────────┤
│ ┌─────────────────────┐ ⊙ ↑ │  ← input | map button | send
│ │ Ask a follow-up…    │     │
│ └─────────────────────┘     │
└─────────────────────────────┘
```

- Transcript scrolls. Latest message visible by default; auto-scroll to bottom as new chunks stream in (unless the user has scrolled up, then don't yank them).
- Floating header at top (sticky). For a spawned node: shows parent title + the cited span snippet, taps jump back to parent. For the seed node: shows the canvas title.
- Outbound citations are inline highlights (subtle underline + tinted background). Tapping the highlight = jump to child node.
- Selection menu when text is highlighted (see below).
- Input area pinned to bottom, above the keyboard when keyboard is up. Map button (⊙) and send button (↑) to its right.

### Screen: Settings (drawer)

Slides in from the left when ☰ is tapped on the Canvases list.

```
┌─────────────────┐
│ Settings        │
├─────────────────┤
│ API Keys        │
│  Anthropic      │
│   sk-•••••AB12  │
│  OpenAI         │
│   [+ Add key]   │
├─────────────────┤
│ Default model   │
│  Anthropic /    │
│  claude-opus-4-7│
└─────────────────┘
```

Per the provider doc: per-provider API key entry (masked display, tap to edit), default provider + model selection.

## The core gesture: select-to-spin-off

The single most important interaction in the app. Has to be fast, obvious, and not fight iOS's native selection UI.

### How it works

1. User long-presses or double-taps in an assistant message to start a text selection.
2. iOS's native selection handles appear (the two draggable dots and the Copy/Look Up/Share menu).
3. **After ~250ms of stable selection** (i.e. the user has let go and the selection has settled), our custom floating button appears:

   ```
   ┌──────────────────┐
   │  ↳ Spin off       │
   └──────────────────┘
   ```

   Positioned just below the selection (or above, if there's no room below). Big enough to thumb-tap.
4. Tap it → atomic write to the backend (per data-model.md `spawnNode` operation), Chat view transitions to the new node, keyboard pre-up with the input focused.

The delay before showing our button is to avoid fighting iOS's native menu for the same space and to make the gesture feel deliberate rather than accidental.

### iOS Safari specifics

- We listen to the `selectionchange` event on the document; debounce to detect "settled" selection.
- Selection that spans across messages or includes user messages → our button doesn't appear (citations are from a single assistant message in v1, per future-features.md).
- After tapping our button, we call `window.getSelection().removeAllRanges()` to clear the selection cleanly before navigating.
- iOS's native selection menu can't easily be extended with custom items; the floating-button-near-selection pattern is the workaround. Multiple PWA projects use this approach (Notion, Google Docs on mobile).

## Streaming UX inside Chat view

How an in-progress assistant message renders:

1. User taps send → user message appears in transcript immediately (optimistic).
2. Below it, a placeholder bubble appears with a typing-dots animation.
3. First content chunk arrives → placeholder converts to a real message bubble; text starts flowing in.
4. Subsequent chunks append. The view auto-scrolls to keep the bottom visible (unless the user is scrolled up reading earlier content — then don't yank).
5. `message_complete` event → animation/indicator settles; message is now "done."

While a message is streaming:
- **Spinning off from the streaming text is allowed.** The citation snapshots whatever text exists at selection time. (Per data-model.md.)
- **Sending the next message is disabled.** Send button greyed until the current message completes. Tapping the disabled state shows a toast: "Wait for the current response to finish."

On error mid-stream:
- The partial text remains visible, with an inline error chip below it: "⚠ Response interrupted." and a "Retry" button.
- Tapping Retry resends the user's last message.

## Chat ↔ Map transition

Switching between Chat and Map should feel like the same context shown at different zoom levels, not like two separate screens.

- **Chat → Map** (tap map button in Chat input row): cross-fade or slide-up; the current node is the centered/highlighted node in the map.
- **Map → Chat** (tap a node): the tapped node "zooms" into the chat view (subtle scale animation, ~200ms).
- iOS-style swipe-back gesture from the left edge in Chat view: behaves the same as the back arrow (returns to the previous screen in the navigation stack).

## Where does a canvas open?

When you tap a canvas in the Canvases list, where do you land?

Two reasonable answers:
- **Map view of the canvas.** Lets you see the structure first, pick a node to enter. Better when canvases have many nodes.
- **Chat view of the last-visited node.** Faster to resume in-progress conversations. Better when canvases are small or you usually return to continue one thread.

**Decision: Chat view of the last-visited node** (defaulting to the seed node for a fresh canvas). The map button is one tap away if you want to see the shape. This prioritizes the continue-where-I-left-off case, which is the more frequent action in a personal-tool context.

## Keyboard behavior

iOS Safari's handling of the on-screen keyboard with sticky-bottom inputs is famously annoying. Specifics:

- We use `100dvh` (dynamic viewport height) for the Chat view container so it shrinks correctly when the keyboard is up.
- The input area uses `position: sticky` (not `fixed`) anchored to the bottom of the transcript scroll container, so it rides the visible viewport when the keyboard appears.
- We listen to `window.visualViewport.resize` to re-anchor if iOS does something weird (which it occasionally does).
- Tapping into the input pre-scrolls so the latest assistant message is still visible above the keyboard.

This is the "iOS Safari PWA tax" — has to be tested on a real device because simulators lie.

## PWA install

First-time experience (described in product-design language, implemented here):

1. User opens the URL in iOS Safari.
2. App displays a one-time banner: *"Install HyperGPT — tap Share, then 'Add to Home Screen'"* with a dismiss × button. (iOS doesn't expose a programmatic install prompt, so we instruct manually.)
3. Once installed, the app launches from the home-screen icon in standalone mode (no Safari chrome).

Manifest fields that matter:
- `display: "standalone"`
- `theme_color` matches the app header color
- `background_color` for the splash screen
- Icons at 192×192 and 512×512 (and Apple-specific 180×180 `apple-touch-icon`)

Service worker scope: cache the static frontend assets (HTML, JS, CSS). **Do not cache API responses** — everything is online-only in v1; cached data would lie about the current state.

## Visual style (deliberately deferred)

This doc doesn't pick colors, fonts, or specific component styles. That's a visual-design pass, separate from interaction design. v1 starts plain (system font, single accent color, generous whitespace) and gets styled later. The interaction model has to be right first.

## Open questions

- **Map view rendering library.** React Flow handles pan/zoom and node positioning cleanly, but its mobile gesture story needs verification. If pinch-zoom or one-finger pan feels janky, we render a custom SVG with our own gesture handling. Resolve when frontend implementation starts; a small spike on real iOS Safari is the right way to decide.
- **Node title generation.** Heuristic (first ~40 chars of seed user message, with hand-wavy cleanup) vs. cheap follow-up LLM call ("summarize this conversation in 4 words"). Heuristic for v1; LLM-generated titles is a future polish.
- **Selection menu collision with iOS native menu.** The 250ms delay-then-show pattern is the plan, but on real devices we may need to coexist differently. Spike on hardware.
- **What happens when a streaming message is interrupted by app backgrounding** (user swipes to home, comes back later). v1: the message keeps streaming on the server; the frontend re-fetches the node state on resume. If the server already completed it, no resubscribe is needed. If it's still going, we resubscribe to the stream by `messageId`.
- **Haptic feedback.** iOS Safari has limited haptics support (only via `navigator.vibrate` which iOS treats as a no-op in many contexts). Probably skip in v1; revisit if it ever becomes possible from a PWA.
- **Dark mode.** Should follow the system setting (`prefers-color-scheme`). Visual style pass.
