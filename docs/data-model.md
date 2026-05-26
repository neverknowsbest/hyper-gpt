# Data Model

This doc defines the entities, their relationships, and the **UX ↔ backend API surface** between them. The overarching constraint is that the frontend (UX) talks to a backend through a clean, narrow interface — and the backend has two interchangeable implementations: **local** (v1) and **hosted** (future). The UX must not care which it's talking to.

Implementation choices (Tauri vs PWA vs native, SQLite vs flat files, etc.) live in the architecture doc. This doc is provider- and runtime-agnostic.

## Entities

Six entities. All have stable globally-unique ids (ULID or UUIDv7 — sortable by creation time, so id ordering ≈ time ordering for free).

### User

The owner of canvases and provider config. v1 has exactly one user, created implicitly at first launch — there is no login, no password, no email. The entity exists purely so that "this is my data" has a machine-readable answer the day we ever need it (hosted multi-device sync, multi-user later).

```
User {
  id: Id
  created_at: timestamp
  metadata: json                 // display name, email, auth fields, etc. live here until they earn real columns
}
```

Auth fields (email, password hash, OAuth tokens, display name) are deliberately *not* modeled as columns yet — see future-features.md. Adding nullable columns to an existing user row when hosted-mode arrives is cheap; modeling them now risks getting the shape wrong before we know what auth will look like.

### Canvas

The root container, scoped to a single seed conversation.

```
Canvas {
  id: Id
  user_id: UserId                // owner
  title: string                  // user-editable; auto-derived from seed prompt initially
  seed_node_id: NodeId           // the root of the tree
  default_provider: ProviderId   // e.g. "anthropic" | "openai"
  default_model: string          // e.g. "claude-opus-4-7"
  created_at: timestamp
  updated_at: timestamp
  metadata: json                 // extensible bag for future fields
}
```

`user_id` lives on Canvas (and on ProviderConfig, below) but **not** on Node, Message, or Edge — those inherit ownership via their canvas. One FK to enforce, one cascade rule, no noise on every other table.

### Node

A single conversation inside a canvas.

```
Node {
  id: Id
  canvas_id: CanvasId
  title: string                  // auto-derived; user-editable later
  provider_override: ProviderId | null
  model_override: string | null
  created_at: timestamp
  updated_at: timestamp
  metadata: json
}
```

A node has zero or one **inbound** edges (the seed node has zero; every other node has exactly one) and zero or more **outbound** edges. Enforced by a unique constraint on `edge.target_node_id` in v1.

### Message

One turn in a conversation. Append-only and immutable (editing is future work — see future-features.md).

```
Message {
  id: Id
  node_id: NodeId
  role: "user" | "assistant"
  content: ContentPart[]         // list of typed parts; v1 only uses text parts
  provider: ProviderId | null    // populated for assistant messages
  model: string | null
  order_index: int               // position within the node (0-indexed)
  status: "streaming" | "complete" | "errored"
  created_at: timestamp
  completed_at: timestamp | null // null while streaming
  metadata: json
}

ContentPart =
  | { type: "text", text: string }
  // future: { type: "image", ... }, { type: "tool_use", ... }, etc.
```

**Why a list of parts when v1 only has text:** keeps the path open for images, tool use, and structured content without a schema migration. v1 emits `[{type: "text", text: "..."}]`.

### Edge

A citation link from one message in one node to another node.

```
Edge {
  id: Id
  source_node_id: NodeId
  source_message_id: MessageId   // must belong to source_node
  target_node_id: NodeId         // must belong to the same canvas in v1
  citation_start: int            // character offset within source message's text
  citation_end: int              // exclusive
  citation_text: string          // immutable snapshot of the cited text at creation time
  kind: "spawn"                  // "suggested" / "manual" reserved for future
  created_at: timestamp
  metadata: json
}
```

`citation_text` is a snapshot, not a derived view. It survives any future message edits and never changes.

In v1, `(source_node_id, target_node_id)` are always in the same canvas, and there's a unique constraint on `target_node_id` (one inbound edge per node).

### ProviderConfig (out-of-band from the canvas tree)

API keys and provider preferences. Per-user, not per-canvas. Detailed schema lives in the provider doc, but the shape it has to fit is:

```
ProviderConfig {
  id: Id
  user_id: UserId                // owner
  provider: ProviderId           // "anthropic" | "openai" | ...
  // credentials + provider-specific settings — defined in the provider doc
  created_at: timestamp
  updated_at: timestamp
}
```

A user may have zero or more ProviderConfigs (one per provider they've set up keys for).

## Relationships at a glance

```
User   ──1:N──> Canvas
User   ──1:N──> ProviderConfig
Canvas ──1:N──> Node
Node   ──1:N──> Message
Node   ──0..1:N──> Edge (inbound)    // v1: exactly 1 for non-seed, 0 for seed
Node   ──0:N──> Edge (outbound)
Edge   ──N:1──> Message  (source_message_id)
```

A canvas is a connected tree of nodes; deleting the canvas deletes its nodes, messages, and edges (cascade). Deleting a user (a v1 non-operation, but defined for completeness) cascades to their canvases and provider configs.

## How a node stores its conversation

A node's conversation is the set of Messages with that node's `node_id`, ordered by `order_index`. Append = `max(order_index) + 1`. Read = `SELECT * FROM message WHERE node_id = ? ORDER BY order_index`. Messages are first-class rows, not embedded in the node, because:

- Edges cite specific messages (`Edge.source_message_id` is a real FK).
- Streaming writes a message field-by-field; rewriting a JSON blob on every token would be wasteful and would defeat partial-message recovery on reconnect.
- Future per-message indices (search, citation lookup) need a real table to live on.

**The seed user message of a spawned node is just `order_index = 0` like any other first message.** The citation itself is not a Message — it's snapshot text stored on the inbound Edge (`citation_text`, `citation_start`, `citation_end`). At replay time, the backend constructs the model call by inserting a synthetic context line *before* the seed message, e.g.:

> *"The user has selected the following span from the previous assistant message: «cited text». Their follow-up question:"*

That synthetic line is **never persisted** as a Message. It's a function of the Edge, computed at request time. This keeps the Message table a clean record of what was actually said by the user and the model — citation framing lives where it belongs, on the link.

Alternatives considered and passed on:

- **Linked list (`parent_message_id` on each message).** Cleaner if we ever support *intra-node* editing/regenerate that forks the conversation in place. v1 has no intra-node branching (spawning a new node *is* the branching mechanic), so paying for recursive traversal on every read buys nothing. Flagged as a future direction in [future-features.md](./future-features.md).
- **Order by `created_at`.** Timestamp ties on fast appends; wall-clock is not logical order.
- **Messages embedded in the node row as a JSON array.** Breaks Edge FKs into specific messages, breaks streaming, breaks indexing.

## Context replay (the rule for spawned nodes)

When a new node is spawned from a citation in a parent node, the model call for the new node receives:

1. The parent node's transcript **up to and including the message the citation came from**. Messages in the parent that happened *after* the cited message are excluded. (Two reasons: (a) contextually, the tangent is "I want to ask about *this*, given everything that led to it" — later parent turns are irrelevant noise; (b) including later parent messages would mean that every continuation of the parent silently grows the replay context of every spawned child, leading to unbounded context bloat on big trees. The cited-message cutoff makes a child's context stable for the lifetime of the child.)
2. A synthetic context line indicating the citation, e.g. *"The user has selected the following span from the previous assistant message: «cited text». Their follow-up question:"*
3. The new node's own messages.

The cited message itself is sent in full (not truncated to the citation), so the model has surrounding context for the span. The citation is highlighted via the synthetic context line.

If the parent is itself a spawned node, its replay recursively includes its own parent context. We don't flatten this at storage time; we compute the replay at request time. Storage stays normalized.

## The UX ↔ Backend interface

This is the **only** surface the UX uses to read or write data, including model calls. There are two implementations, and the UX is identical against both:

- `LocalBackend`: runs in-process (or on localhost), persists to local storage, calls LLM providers directly with the user's keys.
- `RemoteBackend`: makes requests to a hosted service that owns persistence and provider calls. (Not built in v1, but the interface must support it.)

The interface is request/response for reads and writes, and **streaming** for model output.

**Every operation takes `userId` as an explicit first argument.** No ambient/magic context. The UX holds the current user's id in its session state and threads it through every call site — every function signature is honest about whose data it touches.

The backend treats `userId` as an *assertion* that must agree with whatever it knows authoritatively:

- **LocalBackend (v1):** `userId` must match the single local user's id. If it doesn't, the call is rejected.
- **RemoteBackend (future):** the auth session establishes the real authenticated user; the client-passed `userId` must match it, or the call is rejected. The wire-level `userId` is never the source of truth in hosted mode — but its presence keeps every call site self-documenting.

### Read operations

```
listCanvases(userId): Canvas[]
getCanvas(userId, canvasId): { canvas, nodes, edges }    // structure only; no messages
getNode(userId, nodeId): { node, messages, inboundEdge?, outboundEdges }
listRecentNodes(userId, limit): Node[]                    // for the recents UI in map view
```

Reads are eventually-consistent across implementations; the UX should not assume in-memory state matches the backend until a fetch resolves.

### Write operations

```
createCanvas(userId, input: {
  title?: string,
  defaultProvider: ProviderId,
  defaultModel: string,
  seedUserMessage: string,
}): { canvas, seedNode }
// Triggers a streaming assistant response for the seed node — see streaming below.

sendUserMessage(userId, input: {
  nodeId: NodeId,
  content: ContentPart[],
}): { userMessage: Message }
// Persists the user message and triggers a streaming assistant response.

spawnNode(userId, input: {
  sourceNodeId: NodeId,
  sourceMessageId: MessageId,
  citation: { start: int, end: int, text: string },
  firstUserMessage: ContentPart[],
  providerOverride?: ProviderId,
  modelOverride?: string,
}): { node: Node, edge: Edge, firstUserMessage: Message }
// Persists everything atomically, then triggers a streaming assistant response in the new node.

renameCanvas(userId, canvasId, title)
renameNode(userId, nodeId, title)
deleteCanvas(userId, canvasId)                            // hard delete, cascades
```

Every write that triggers a model call also opens a stream for the assistant's response. Callers get the new entity ids back synchronously, and the assistant message arrives over the stream.

### Streaming

Model output streams as a sequence of typed events. The interface returns an `AsyncIterable<StreamEvent>` (or equivalent in non-JS backends).

```
StreamEvent =
  | { type: "message_start", message: Message }       // status: "streaming"
  | { type: "content_delta", messageId, delta: ContentPart }
  | { type: "message_complete", messageId, completed_at: timestamp }
  | { type: "error", messageId, error: { code, message } }
```

The backend is responsible for persisting the streaming message as it grows, so a UX reconnection (e.g. dropped connection, app re-open) can re-fetch the partial message and resume listening for the rest if it's still going.

**Spawning off a still-streaming response is allowed.** The citation snapshots whatever text exists at the moment of selection. The parent's streaming continues independently.

### Subscriptions (optional, for later)

A future feature is "another tab / device sees changes made elsewhere." The interface should be designed so it can grow a `subscribe(canvasId)` method that emits change events, without breaking v1 (which has no other tabs/devices). v1 ships without subscriptions.

## What lives where (UX vs backend)

| Concern | UX | Backend |
|---|---|---|
| Rendering, gestures, scroll/zoom | ✅ | |
| Map view layout computation | ✅ | |
| In-memory cache of opened nodes | ✅ | |
| Persistence of canvases / nodes / messages / edges | | ✅ |
| Context replay (deciding what to send the model) | | ✅ |
| Provider API calls + streaming | | ✅ |
| API keys / secrets | | ✅ |
| Model defaults & overrides | (read) | ✅ |

The UX **never** talks to a model provider directly. Even in the v1 local implementation, the backend layer is the one making outbound provider calls — this keeps the seam intact for when we swap in the hosted backend.

## Open questions

- **Title generation.** Who writes a node's auto-title — the model (via a cheap follow-up call?), or a heuristic (truncate first user message)? v1 heuristic: first ~40 chars of the seed user message (see map-view.md, mobile-ux.md). LLM-generated titles is a future polish.
- **Cited-message addressing for streaming.** Citations index into a message's text. If a message is streamed, can the cited offsets shift? In v1 the rule is: a citation can only target a *complete* message OR a streaming-but-frozen-at-now snapshot. Worth re-checking when we build it.
- **Concurrency.** Two near-simultaneous user actions on the same node (e.g. send message while previous one is still streaming): allow, queue, or reject? Suggest: reject the second with a clear error (matches the mobile-ux.md "send disabled mid-stream" rule). Cheap to implement, easy to relax later.
- **Soft delete vs hard delete.** v1 says hard delete for simplicity, but soft delete is friendlier to "undo" and future cross-device sync. Probably ship hard delete v1, revisit.

(Storage format → SQLite, and schema migration strategy → Drizzle Kit at app start, are both committed in [architecture.md](./architecture.md).)
