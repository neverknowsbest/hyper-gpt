# Provider Abstraction

How HyperGPT talks to LLM providers (Anthropic, OpenAI) behind a single interface, so the rest of the backend never knows which one it's calling.

## Responsibilities

Each provider implementation knows:
- Its API endpoint, auth scheme, and streaming protocol.
- How to translate our internal message format to its own.
- How to translate its streaming events to our internal `StreamEvent` shape.

The rest of the backend knows:
- *Which* provider to call (resolved from canvas defaults + node overrides).
- *What* messages to pass (constructed by the context-replay rule in [data-model.md](./data-model.md)).
- How to persist the assistant's streaming response as it arrives.

This boundary keeps each provider's quirks isolated. Adding a third provider later (e.g. Gemini) is one new file in `backend/providers/`.

## The interface

```ts
// backend/providers/interface.ts

export type ProviderId = "anthropic" | "openai"  // extensible

export interface ModelInfo {
  id: string                    // e.g. "claude-opus-4-7", "gpt-4o"
  displayName: string           // human-readable, for settings UI
  contextWindow: number         // tokens
}

export interface ProviderMessage {
  role: "user" | "assistant"
  content: ContentPart[]        // same shape as our Message.content
}

export interface ProviderStreamChunk {
  type: "content_delta" | "complete" | "error"
  delta?: ContentPart           // present when type === "content_delta"
  error?: { code: string, message: string }
}

export interface ModelProvider {
  id: ProviderId
  listModels(): ModelInfo[]
  streamChat(input: {
    apiKey: string
    model: string               // id within this provider's catalog
    messages: ProviderMessage[]
  }): AsyncIterable<ProviderStreamChunk>
}
```

Calling code:

```ts
const provider = providerRegistry.get(providerId)
for await (const chunk of provider.streamChat({ apiKey, model, messages })) {
  // translate chunk into our StreamEvent, persist to SQLite, forward over SSE
}
```

The provider doesn't know about Canvas / Node / Edge / Message rows. It doesn't know about citations. It doesn't know about users. It takes some messages, streams back chunks. The orchestration layer above it deals with everything else.

## Provider implementations (v1)

### Anthropic

- Uses the Messages API (`POST https://api.anthropic.com/v1/messages`) via the official `@anthropic-ai/sdk`.
- Auth: `x-api-key: <key>` header (handled by the SDK).
- Streaming: SSE with event types `message_start`, `content_block_delta`, `message_stop`, etc.
- Mapping:
  - `ProviderMessage` → Anthropic `messages[]` array (1:1; both use role + content-parts).
  - `content_block_delta` (text) → `ProviderStreamChunk { type: "content_delta", delta: { type: "text", text } }`.
  - `message_stop` → `ProviderStreamChunk { type: "complete" }`.
  - Any Anthropic error event → `ProviderStreamChunk { type: "error", error: ... }`.
- v1 catalog: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. (The Anthropic model list is the source of truth; this is just what the settings UI offers.) Default is `claude-sonnet-4-6` for cost-vs-quality balance; Opus is available as a per-canvas or per-node override.

**Prompt caching.** The Anthropic adapter marks the last content block of the last assistant message in the request with `cache_control: { type: "ephemeral" }`. This caches the conversation prefix up through that turn (5-minute TTL). The next turn's request sets a new marker further along, and Anthropic's longest-prefix match reuses the prior cache automatically. First turns (no assistant message yet) skip caching.

Why this matters for HyperGPT specifically:
- **Linear chat growth** re-sends history on every turn — the classic case for prompt caching. Each follow-up pays full input rate only on the new tokens; the rest are 10% cache reads.
- **Spawned tangents reuse parent context.** When spawning multiple tangents from the same parent within a few minutes, every spawn after the first hits the cached parent prefix. This is the access pattern caching was designed for.

Costs to know:
- Cache writes are 25% more than regular input (only matters if the prefix is never reused, which our access pattern avoids).
- Minimum 1024 tokens to be cacheable, so short conversations get no benefit either way.
- Default 5-minute TTL is fine for burst patterns; 1-hour TTL is available at higher write cost but not used in v1.

### OpenAI

- Uses Chat Completions (`POST https://api.openai.com/v1/chat/completions`) with `stream: true`.
- Auth: `Authorization: Bearer <key>` header.
- Streaming: SSE with `data: { choices: [{ delta: { content } }] }` lines until `data: [DONE]`.
- Mapping:
  - `ProviderMessage` → OpenAI `messages[]` (need to flatten our `ContentPart[]` into a single string in v1, since we only have text parts).
  - `delta.content` chunks → `ProviderStreamChunk { type: "content_delta", delta: { type: "text", text } }`.
  - `[DONE]` → `ProviderStreamChunk { type: "complete" }`.
  - HTTP error or `error` event → `ProviderStreamChunk { type: "error", ... }`.
- v1 catalog: whichever GPT-4-class models the user wants exposed in settings.

### The system prompt question

We don't use a system prompt in v1. The synthetic citation line for spawned nodes (see context-replay in data-model.md) is injected as a **prefix on the spawned node's first user message**, not as a `system` role message. Reasons:

- Both providers tolerate this fine.
- Keeps `ProviderMessage.role` to just `user`/`assistant`, matching our internal Message model.
- The citation framing is conceptually part of *what the user is asking*, not part of *how the assistant should behave* — it belongs in the user message.

If a system prompt ever becomes useful (custom personas, instructions per canvas), the interface gains an optional `systemPrompt?: string` field. Future-features, not v1.

## Resolving (provider, model) for a call

When the backend is about to make a model call for a node:

```
provider = node.provider_override ?? canvas.default_provider
model    = node.model_override ?? canvas.default_model
```

The resolved pair lives in only one place: the message metadata we persist (`Message.provider`, `Message.model`). That way, the transcript is honest about which model said what, even if defaults change later. Future regenerate / model-switching features can read this faithfully.

## API key storage

API keys live in the `ProviderConfig` table (per data-model.md), one row per user-provider pair:

```
ProviderConfig {
  id: Id
  user_id: UserId
  provider: ProviderId
  api_key: string               // plaintext in v1; see "Encryption at rest" below
  created_at: timestamp
  updated_at: timestamp
}
```

### Bootstrap (first launch)

The first time the backend boots without any `ProviderConfig` rows, it checks for env vars `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. If either is set, it creates the corresponding `ProviderConfig` row for the local user. On subsequent boots the DB row is the source of truth — env vars are ignored.

This gives a one-line bootstrap (`ANTHROPIC_API_KEY=sk-... bun run start`) while keeping the DB as the long-term home.

### Updating keys

A settings screen in the UX (see mobile-ux.md) lets the user paste in new keys, mask-display them (`sk-•••••••AB12`), and delete them. The endpoint is a normal write op:

```
PUT  /api/users/:userId/provider-configs/:provider    body: { api_key }    → ProviderConfig
DELETE /api/users/:userId/provider-configs/:provider  → 204
```

### Encryption at rest

For v1, API keys are stored as plaintext in SQLite. Threat model: anyone with shell access to the VPS already has the env vars, the SQLite file, and the running process — encrypting the keys in the DB but not the env vars doesn't move the needle. If hosted-mode ever becomes real, encryption-at-rest gets revisited then. Documented here so the choice is deliberate, not accidental.

## Error handling

The provider interface returns errors as `ProviderStreamChunk { type: "error" }` events rather than throwing. This way:

- The orchestration layer always processes chunks the same way (drive the loop, react to event type).
- Partial messages aren't lost — the bytes that streamed before the error are already persisted.
- The frontend's SSE handler doesn't need a separate exception path.

Error codes the orchestration layer maps onto user-facing behavior:

| Code | Cause | UX |
|---|---|---|
| `auth` | API key invalid/expired/missing | Toast: "Update your API key in Settings." |
| `rate_limit` | Provider returned 429 | Toast: "Rate limited; try again in a moment." |
| `context_too_long` | Replayed messages exceeded model context window | Toast: "This conversation is too long for the chosen model." |
| `network` | Connection failure mid-stream | Toast: "Network issue; the partial response is saved." |
| `unknown` | Anything else | Toast: error message verbatim. |

No retries in v1. The user retries by sending the message again (or by waiting and reconnecting via the stream endpoint, which finds the partial message and resumes if the backend itself is still working).

## What's deliberately out of scope (v1)

- **Tool use** (web search, code execution). Future-features; the message parts schema is ready for it (`type: "tool_use"`, `type: "tool_result"`), but no v1 plumbing.
- **Image inputs.** Same — schema-ready, no UX or transport.
- **Per-message sampling parameters** (temperature, top_p, etc.). v1 uses provider defaults. If we want them later, they live as optional fields on `streamChat`'s input.
- **Token usage tracking / cost reporting.** See [future-features.md](./future-features.md#token-usage-and-cost-tracking) — would enable cache-hit verification and per-canvas cost display.
- **Provider-specific features** (Anthropic's prompt caching, OpenAI's response format JSON mode). Don't expose them through the abstraction — that defeats the abstraction.

## Open questions

- **Model catalog source of truth.** Hard-coded in each provider file (current sketch), or fetched dynamically from the provider's "list models" endpoint at boot? Hard-coded is simpler and avoids a startup network dependency; dynamic stays current automatically. Lean toward hard-coded for v1, refresh by editing the file.
- **Cross-provider model identity.** If a node is created on Anthropic and its model is later changed to OpenAI, do we re-run the conversation, or just use OpenAI for *new* messages? v1: just new messages. The transcript honestly records which model said what.
- **Streaming reconnect from the provider side.** If the provider's SSE stream drops mid-message, do we re-issue the request (and risk a duplicated assistant message) or surface the partial as-is? v1: surface partial, mark message status `errored`, user re-sends. Avoids correctness landmines.
