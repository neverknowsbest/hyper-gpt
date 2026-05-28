import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentPart,
  MessageRole,
  ModelCatalog,
  ProviderId,
} from "../shared/types";

// Hard-coded for v1; refreshed by editing this file when new models ship.
// Source of truth for the settings UI's model dropdown.
export const MODEL_CATALOG: ModelCatalog = {
  anthropic: [
    { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
  ],
  openai: [], // OpenAI provider not implemented yet
};

export interface ProviderMessage {
  role: MessageRole;
  content: ContentPart[];
}

export type ProviderStreamChunk =
  | { type: "content_delta"; delta: ContentPart }
  | { type: "complete" }
  | { type: "error"; error: { code: string; message: string } };

export interface StreamChatInput {
  apiKey: string;
  model: string;
  messages: ProviderMessage[];
}

export interface ModelProvider {
  id: ProviderId;
  streamChat(input: StreamChatInput): AsyncIterable<ProviderStreamChunk>;
}

// --- Anthropic ---

const ANTHROPIC_MAX_TOKENS = 4096;

async function* anthropicStream(
  input: StreamChatInput,
): AsyncIterable<ProviderStreamChunk> {
  const client = new Anthropic({ apiKey: input.apiKey });

  // Mark the last content block of the last assistant message with
  // cache_control so Anthropic caches the prefix up through that turn.
  // Subsequent requests with a longer history will set a new marker further
  // along; Anthropic's longest-prefix match reuses the prior cache.
  // First turns (no assistant message yet) skip caching.
  let lastAssistantIdx = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  const anthropicMessages = input.messages.map((m, mi) => ({
    role: m.role,
    content: m.content.map((p, pi) => {
      const block: Anthropic.TextBlockParam = { type: "text", text: p.text };
      if (mi === lastAssistantIdx && pi === m.content.length - 1) {
        block.cache_control = { type: "ephemeral" };
      }
      return block;
    }),
  }));

  try {
    const stream = client.messages.stream({
      model: input.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: anthropicMessages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield {
          type: "content_delta",
          delta: { type: "text", text: event.delta.text },
        };
      }
    }

    yield { type: "complete" };
  } catch (e) {
    const err = e as Error & { status?: number; error?: { type?: string } };
    const code =
      err.status === 401 || err.status === 403
        ? "auth"
        : err.status === 429
          ? "rate_limit"
          : err.error?.type === "invalid_request_error" &&
              err.message?.includes("max_tokens")
            ? "context_too_long"
            : "unknown";
    yield {
      type: "error",
      error: { code, message: err.message ?? String(e) },
    };
  }
}

export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  streamChat: (input) => anthropicStream(input),
};

// --- Registry ---

const providers: Record<ProviderId, ModelProvider> = {
  anthropic: anthropicProvider,
  // openai: TBD
  openai: anthropicProvider, // placeholder to satisfy the type until we implement OpenAI
};

export function getProvider(id: ProviderId): ModelProvider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  if (id === "openai") {
    throw new Error(
      "OpenAI provider not yet implemented. Use 'anthropic' for now.",
    );
  }
  return p;
}
