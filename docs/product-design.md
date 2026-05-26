# HyperGPT — Product Design

## Elevator pitch

HyperGPT is a personal knowledge graph **made of AI conversations**. Each node is a conversation about one topic; each edge is a link, pinned to the exact span of text in one conversation that sparked the next. It's what Notion or Obsidian would feel like if every page wrote itself by chatting with a model — and if you could spawn a new page just by selecting something interesting and asking "wait, what about this?"

The goal is to make the *shape of your own thinking* legible. Linear chat throws away the structure of an inquiry. HyperGPT keeps it.

## Who it's for

A single power user (initially: the author) whose primary chat interface is **the iPhone**, used casually throughout the day. They already use Claude / ChatGPT heavily and feel the friction of linear chat:

- Lose the original thread after going deep on a tangent.
- Copy-paste snippets back into the chat to ask "wait, what about this part?".
- Keep five chats open across two apps to keep parallel investigations alive.
- Want their conversations to accumulate into something — not vanish into scrollback.

Mobile-primary is a hard constraint, not a nice-to-have. Anything that doesn't work well on a phone doesn't ship.

Not (yet) for: teams, polished consumer chat replacement, anyone whose use case is genuinely linear (drafting one email).

## The core problem

A chat transcript is a stack — push and pop the top. Real thinking is a graph: encounter an idea, fork off, chew on it, sometimes come back, sometimes don't, often connect it to something you explored last week. Existing chat UIs force the graph into a stack, and the user pays the cost: lost context, brittle threads, dead tangents, no accumulation.

## Design principles

1. **Speed and clarity first.** Branching is ≤2 taps from "I see something interesting" to "I'm typing my follow-up." Navigating between conversations is ≤1 tap from a visible link. If a feature slows the core loop, it loses.
2. **Mobile-first.** Designed for one-thumb use on a 6" screen. Desktop comes later and is the easier case.
3. **The artifact matters.** Conversations are not ephemeral. The graph is something the user returns to, navigates, and grows over time.
4. **Structure emerges from use.** No manual graph-arranging. The shape of the graph is the shape of the inquiry; the UI reveals it, doesn't ask the user to author it.

## The interaction model

### The knowledge graph

A **canvas** is scoped to a single **seed conversation** — the inquiry that started it. From there, new nodes spawn off as the user follows tangents, and the canvas grows into a tree of related conversations rooted at the seed. (It's a tree in v1, not an arbitrary graph: each node has exactly one inbound edge, its seed. Cross-canvas links, merges, and self-discovered edges between existing nodes are explicitly future work — see [future-features.md](./future-features.md).)

A node knows:
- Its conversation transcript (a normal back-and-forth with a model).
- Its **inbound edge** — the parent conversation, the cited span of text in that parent, and the seed user message in this conversation.
- Its **outbound edges** — selections inside *this* conversation that sparked child nodes, with links to them.

A canvas knows its set of nodes and edges. That's it. Layout is derived; the user doesn't position nodes by hand.

### Inside a node: the conversation

A node, when opened, is a normal chat: full transcript scrolling up, input pinned at the bottom. Tangents elsewhere on the canvas don't intrude. The user keeps talking to the model here as long as they want; the conversation keeps growing inside this one node.

**Inbound link (a floating header).** If this node has a parent, a compact header sits pinned at the top of Chat view: the parent conversation's title and the cited span. Tapping it jumps back to the parent, scrolled to the exact message that contained the citation. The header is always visible, even mid-scroll — orientation is one glance away. For the seed node of a canvas (no parent), the header shows the canvas title instead.

**Outbound links (inline in the text).** When a child node has been spawned from a span in this conversation, that span is rendered with a subtle highlight (underline / margin marker) in the transcript. Tapping the highlight jumps to the child node. A node may have many outbound links; they live in-place where they were created. (A separate directory of outbound links — "show me all the tangents from this conversation" — is a useful affordance, but is post-v1.)

The model also receives the seed (and the parent conversation's history) as context for this node, so it knows what the user is asking about.

### Spawning a new node (the core gesture)

Inside any conversation, **select a span of text** in a model response. A floating action appears: *"Spin off →"*. One tap creates a new node, with:

- The selected span as the **seed quote** at the top.
- An input ready for the user's first message.
- An edge from this conversation (at the cited span) to the new one.
- The parent's full conversation history loaded as context for the new model call.

The new node opens immediately, full-screen. The user is now in the tangent, typing. Two taps total: select, tap "Spin off." That's the speed bar.

### The dual visibility of an edge

Edges are visible from both ends:

- **In the source conversation,** the cited span is highlighted (subtle underline / margin marker). Tapping the highlight jumps to the child node.
- **In the child conversation,** the seed quote at the top is a link back to the exact message in the source.

This is what makes the structure feel like a real hypertext document, not a chat with metadata. You can navigate the graph by following citations the way you'd follow links in a wiki.

### Two views: Chat and Map

The UI has two primary modes:

- **Chat view** (default, full-screen): you are inside one node, talking. This is where most time is spent. It looks like a chat app.
- **Map view** (zoomed out): the graph of nodes and edges, visible at once. Used for navigation, orientation, and seeing the shape of what you've explored. Tap a node to enter Chat view for it.

On mobile, these are two screens; you swipe / tap to switch. On desktop, they can coexist (map as a side panel). The map is for getting your bearings, not for working.

### Navigation primitives

- **Tap a highlighted span** in chat → jump to the child node.
- **Tap the seed quote** at the top of a node → jump back to the source.
- **Swipe to map** → see the graph; tap any node to enter.
- **Recents list** in map view, for fast return to nodes you've been in lately.
- **Search** across all conversations (later — but the data model needs to support it).

### Persistence

Each canvas is a saved document (a graph of conversations). Conversations are not throwaway — they accumulate. Opening the app shows the user's canvases; opening one restores its full state, including which node was last in focus.

Local-first to start. The data model is structured so a future hosted version can sync canvases across devices without rework.

## Why conversation-as-node (the granularity decision)

Alternatives considered:

- **Message-as-node** (every prompt and response is its own graph node). Too granular: the graph fills with hundreds of tiny nodes that map to no meaningful unit of thought. The user remembers "I had a chat about X," not "I sent prompt #4."
- **Inline nested branches** (footnotes-that-talk-back inside a single transcript). Unreadable past two levels of nesting; forces a single reading order on something that doesn't have one; bad on mobile.
- **Tabs / side panels**. Hides the structure. The user can't see the shape of their own thinking, which is half the point.

**Conversation-as-node** matches the unit of memory (one chat = one topic), keeps the graph at a navigable scale (tens of nodes per canvas, not hundreds), and works on a phone because the primary mode is one full-screen conversation at a time.

## Model provider

Pluggable from the start. The user supplies API keys for one or more providers (Anthropic, OpenAI). Each canvas has a default model; each node can override. The spawn mechanic is provider-agnostic: a new node is just a new chat-completion request seeded with the parent's history plus the cited span — any chat API supports that.

## What v1 is, and isn't

The v1 question to answer: *can a single user, on their phone, think more clearly using this than they could in linear chat?* Everything else waits on that being true.

Specific deferrals (collaboration, hosted sync, tools, manual organization, cross-canvas links, merges, self-discovered edges, etc.) live in [future-features.md](./future-features.md). That doc is the single source of truth for "we considered it, we're not doing it yet."

## Open questions to resolve in subsequent design docs

- **Data model.** Exact shape of a canvas, node, edge, message; how the citation is stored; how parent history is replayed for a spawned node. → *data model doc.*
- **Mobile UX details.** Exactly how select-and-spin-off feels on iOS; how Chat ↔ Map transitions feel; how seed quotes render at the top of a node. → *mobile interaction doc.*
- **Map view rendering.** Layout algorithm for the graph (force-directed? hierarchical-ish?); how to keep it readable as nodes accumulate; pan/zoom on mobile. → *map view doc.*
- **Streaming UX.** How an in-progress response renders inside a node; can the user select-and-spin-off from a half-streamed response. → *streaming doc.*
- **Local-first architecture.** Storage format, what the path to hosted-with-sync looks like, how a canvas is a single shareable artifact. → *architecture doc.*
- **Provider abstraction.** The interface that lets Anthropic and OpenAI sit behind one spawn mechanic, including per-node model overrides. → *provider doc.*
