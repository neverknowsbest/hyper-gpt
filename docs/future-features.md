# Future Features

Things we've considered and explicitly deferred past v1. This doc exists so that:

- We don't re-litigate decisions every time someone asks "what about X?"
- We don't accidentally build v1 in a way that closes off a known future direction.
- When v1 ships and we look around for what to build next, the list of candidates is already here, with the context for *why* each one was deferred.

Each entry should answer: **what is it, why isn't it in v1, and is there anything v1 should do (or avoid doing) to keep this path open?**

## Graph features (beyond a tree of conversations)

### Cross-canvas links

Right now a canvas is scoped to one seed conversation. There's no way to link a node in canvas A to a node in canvas B.

- **Why deferred:** v1 wants to validate the single-canvas inquiry experience before introducing the complexity of cross-canvas navigation, search, and identity.
- **Keep the path open by:** giving every node a globally unique id, not just one that's unique within its canvas. The data model should treat "node belongs to canvas X" as a property of the node, not as nested identity.

### Self-discovered edges between existing nodes

In v1, edges are only created at spawn time (a new node is born of a citation). A node never gains a new inbound edge later.

A future direction: the system (or the user, by hand) discovers that node B is relevant to node A and creates a citation edge between them, without spawning a new node.

- **Why deferred:** speculative. Requires meaningful AI surface area (similarity search, "you might want to connect this to…") and a UI for accepting/rejecting suggestions. Not needed to validate v1.
- **Keep the path open by:** modeling edges as first-class entities that can exist independently of node-creation. An edge is not "a property of being born from X"; it's its own row, with a source, target, citation, and provenance (created-by-spawn vs created-by-suggestion vs created-by-hand).

### Merging two nodes

If a user explores two tangents and realizes they should converge, there's no way today to merge them into one ongoing conversation.

- **Why deferred:** semantically tricky (whose context wins? how do the model histories reconcile?) and rare enough in practice that it's worth waiting to see if it actually comes up.
- **Keep the path open by:** treating a node's message list as the unit of truth, not the spawn event. If we ever do merge, it's some form of "concatenate / interleave message histories"; that operation is at least well-defined on the data we're already storing.

### A universal cross-canvas overview

A view that shows *all* canvases and their internal structures at once — the user's entire knowledge graph, not just one inquiry.

- **Why deferred:** the rendering and navigation problem is hard, and it's not useful until the user has many canvases.
- **Keep the path open by:** storing canvases as peers in a single store, queryable as a set.

## Organizational features

### Tags / folders / manual organization

No explicit way to categorize canvases or nodes by hand.

- **Why deferred:** premature. The shape of the inquiry should emerge from use, not from up-front authoring. If a user ends up needing tags, we'll know because they'll ask.
- **Keep the path open by:** the data model permitting arbitrary key-value metadata on nodes and canvases. Don't paint into a corner.

### Search across all conversations

No full-text or semantic search across nodes, messages, or canvases.

- **Why deferred:** v1 has tens of nodes per canvas and few canvases — navigation by recents and the map should be enough. Search becomes essential at scale, which v1 doesn't have.
- **Keep the path open by:** storing message content in a form that's straightforwardly indexable later (plain text on the server side, not encrypted-at-rest in a way that prevents indexing).

### Directory of outbound links inside a node

A "show me all the tangents from this conversation" affordance, listed somewhere reachable from inside a node.

- **Why deferred:** outbound links being highlighted inline in the text is probably enough for v1. A directory is a useful add for nodes with many tangents.
- **Keep the path open by:** the data model already supports it (a node knows its outbound edges); this is purely a UI addition.

### Manual layout / arbitrary node positioning

Letting the user drag nodes around the map view.

- **Why deferred:** structure should emerge from use, not be authored. Map view layout is derived in v1.
- **Keep the path open by:** storing nothing about layout in the data model. If we ever add manual layout, the layout-data is additive and optional.

## Conversation features

### Rich content (images, files, attachments)

Conversations are text-only in v1.

- **Why deferred:** scope. The branching mechanic is the thing we're validating, and it's orthogonal to media support.
- **Keep the path open by:** message content being modeled as a list of typed parts (text part, image part, file part), not a single string. Even if v1 only uses the text-part case, the structure is there.

### Tool use / model actions

The model can't invoke tools (web search, code execution, file I/O) inside a conversation.

- **Why deferred:** scope, and the UX of "tool calls inside a node, rendered in the transcript" is a design problem of its own.
- **Keep the path open by:** the message model accommodating non-prose message parts (a tool-use part, a tool-result part), even if v1 doesn't emit them.

### Per-prompt model selection

The user picks which model answers each individual prompt — a small model picker next to the composer, defaulting to the canvas's default but overridable for any single turn. Different from the existing per-canvas and per-node overrides (which apply to the whole conversation): this is "use Opus for THIS question, then back to Sonnet."

- **Why deferred:** v1 settings already let users pick a default model; per-prompt fine-grained control is power-user behavior (e.g. "use Opus for this hard question, Haiku for the next follow-up") that doesn't move the v1 thesis. Adds UI complexity in the most-touched area of the app.
- **Keep the path open by:** the data model is already ready — `Message.provider` and `Message.model` record what produced each assistant message, so mixed-model conversations replay correctly. The `SendMessageRequest` and `SpawnRequest` shapes would grow an optional `model: { provider, model }` field; when absent, the existing canvas/node default chain applies. The provider abstraction (`streamChat`) already takes provider+model per call, so the backend wiring is mostly already there. The new work is mostly UX: a small chip/dropdown near the composer that's easy to use one-handed on mobile.

### Multiple models / personas in one node

A node is one back-and-forth with one model. A tangent doesn't internally branch into "summarizer says X, critic says Y."

- **Why deferred:** explicitly discussed and dismissed — the conversation-as-node model already covers what the user wanted from "interactivity in tangents."
- **Keep the path open by:** message-level model identity. Each assistant message records which model produced it. If we ever do multi-model nodes, we don't have to retrofit.

### Editing past messages / regenerate

No way to edit a sent prompt or re-roll an assistant response.

- **Why deferred:** v1 doesn't need it to test the branching hypothesis, and adding it raises model-history-correctness questions (do downstream nodes need re-running?).
- **Keep the path open by:** messages being immutable append-only by default. A future "edit" feature creates a new message version; it doesn't mutate in place.

### Token usage and cost tracking

Provider responses include a `usage` field with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. v1 ignores it. Capturing it would enable: verifying prompt-caching savings (currently invisible — we set the cache marker but don't measure the hit rate), per-canvas/per-conversation cost reporting in the UI, "this conversation has cost $X so far" affordances, and informed model-override decisions ("Sonnet is fine here, no need for Opus").

- **Why deferred:** the v1 question is whether the UX is worth using at all. Cost telemetry is a refinement that matters once you're committed enough to care about your monthly Anthropic bill. The prompt-caching savings land invisibly either way.
- **Keep the path open by:** the `ProviderStreamChunk` union can grow a `{ type: "usage", usage: {...} }` variant without breaking existing handlers — it's just a new event type to ignore-or-handle. Per-message usage data lives in `Message.metadata` (no schema migration needed); aggregations happen at query time. The provider doc's "Tool use" deferral already commits to non-prose chunk types; this is in the same family.

### Intra-node branching (conversation tree inside a single node)

Today, a node's conversation is strictly linear (`order_index` 0, 1, 2, …). Editing or regenerating a past message could fork the conversation in place — message #4 has two children, two competing #5s, and the UI lets you pick which path to view.

- **Why deferred:** v1's branching mechanic is spawning a new node, not forking inside a node. Until intra-node edits/regenerate ship, there is nothing to fork.
- **Keep the path open by:** if/when intra-node branching is needed, migrate Message from `order_index` to a `parent_message_id` linked-list (each message points at its predecessor; the conversation is a tree, and a "current view" is a path from a leaf to the root). This is roughly the model ChatGPT uses internally. v1 picks `order_index` because it's simpler and recursive-CTE reads are real cost for no v1 benefit — but the migration is straightforward when the time comes: derive `parent_message_id = message[order_index - 1].id` for every existing row, then drop `order_index`.

## Multi-user / hosted

### Multi-user collaboration, sharing, comments

Single user only in v1.

- **Why deferred:** v1 question is single-user value. Collaboration is a different product on top of the same primitive.
- **Keep the path open by:** every entity (canvas, node, message, edge) having stable globally-unique ids and timestamps. Don't bake single-user assumptions into the schema.

### Hosted accounts, cross-device sync, billing

Local-first in v1.

- **Why deferred:** scope and validation order — prove the thing works first, then think about how to make it portable.
- **Keep the path open by:** the architecture's UX ↔ backend boundary being clean enough that "the backend" can be local-in-process *or* a remote service without UX changes. See the data model and architecture docs.

## Selection / authoring

### Selecting across multiple messages or non-text spans

In v1, a citation is one contiguous text span inside one assistant message.

- **Why deferred:** the common case is what the user actually wants to "spin off from"; cross-message selection adds UI complexity for marginal value.
- **Keep the path open by:** the citation data structure being able to grow to a list-of-spans without breaking the single-span case.

### User-authored notes attached to nodes

Annotations on a conversation that aren't part of the chat with the model.

- **Why deferred:** scope. The conversation transcript is the artifact in v1.
- **Keep the path open by:** node-level metadata being extensible.
