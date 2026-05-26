import { eq, asc } from "drizzle-orm";
import { db } from "./db";
import { canvases, nodes, messages, providerConfigs } from "./db/schema";
import { getProvider, type ProviderMessage } from "./providers";
import { streamHub } from "./streaming";
import type {
  Canvas,
  ContentPart,
  CreateCanvasRequest,
  Message,
  Node,
  ProviderId,
  StreamEvent,
} from "../shared/types";

// ---- helpers ----

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function deriveTitle(content: ContentPart[]): string {
  const text = content
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!text) return "Untitled";
  return text.length > 40 ? text.slice(0, 40).trimEnd() + "…" : text;
}

function getApiKey(userId: string, provider: ProviderId): string {
  const row = db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId))
    .all()
    .find((r) => r.provider === provider);
  if (!row) {
    throw new Error(
      `No API key configured for provider '${provider}'. Set ${provider.toUpperCase()}_API_KEY in env or via the settings endpoint.`,
    );
  }
  return row.apiKey;
}

// ---- queries ----

export function listCanvases(userId: string): Canvas[] {
  return db.select().from(canvases).where(eq(canvases.userId, userId)).all();
}

export function getNodeWithMessages(nodeId: string): {
  node: Node;
  messages: Message[];
} | null {
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) return null;
  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.nodeId, nodeId))
    .orderBy(asc(messages.orderIndex))
    .all();
  return { node, messages: msgs };
}

// ---- writes ----

export interface CreateCanvasResult {
  canvas: Canvas;
  seedNode: Node;
  userMessage: Message;
  assistantMessage: Message;
}

export function createCanvas(
  userId: string,
  input: CreateCanvasRequest,
): CreateCanvasResult {
  const t = now();
  const canvasId = uuid();
  const nodeId = uuid();
  const userMsgId = uuid();
  const assistantMsgId = uuid();

  const titleFromSeed = deriveTitle(input.seedUserMessage);

  const canvas: Canvas = {
    id: canvasId,
    userId,
    title: input.title ?? titleFromSeed,
    seedNodeId: nodeId,
    defaultProvider: input.defaultProvider,
    defaultModel: input.defaultModel,
    createdAt: t,
    updatedAt: t,
    metadata: {},
  };

  const seedNode: Node = {
    id: nodeId,
    canvasId,
    title: titleFromSeed,
    providerOverride: null,
    modelOverride: null,
    createdAt: t,
    updatedAt: t,
    metadata: {},
  };

  const userMessage: Message = {
    id: userMsgId,
    nodeId,
    role: "user",
    content: input.seedUserMessage,
    provider: null,
    model: null,
    orderIndex: 0,
    status: "complete",
    createdAt: t,
    completedAt: t,
    metadata: {},
  };

  const assistantMessage: Message = {
    id: assistantMsgId,
    nodeId,
    role: "assistant",
    content: [],
    provider: input.defaultProvider,
    model: input.defaultModel,
    orderIndex: 1,
    status: "streaming",
    createdAt: t,
    completedAt: null,
    metadata: {},
  };

  db.transaction((tx) => {
    tx.insert(canvases).values(canvas).run();
    tx.insert(nodes).values(seedNode).run();
    tx.insert(messages).values(userMessage).run();
    tx.insert(messages).values(assistantMessage).run();
  });

  streamHub.start(assistantMsgId);
  runStreamingResponse(userId, nodeId, assistantMsgId, input.defaultProvider, input.defaultModel);

  return { canvas, seedNode, userMessage, assistantMessage };
}

export interface SendMessageResult {
  userMessage: Message;
  assistantMessage: Message;
}

export function sendUserMessage(
  userId: string,
  nodeId: string,
  content: ContentPart[],
): SendMessageResult {
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const canvas = db
    .select()
    .from(canvases)
    .where(eq(canvases.id, node.canvasId))
    .get();
  if (!canvas) throw new Error(`Canvas not found for node: ${nodeId}`);
  if (canvas.userId !== userId) throw new Error("Forbidden");

  const provider = node.providerOverride ?? canvas.defaultProvider;
  const model = node.modelOverride ?? canvas.defaultModel;

  const t = now();
  const userMsgId = uuid();
  const assistantMsgId = uuid();

  const existing = db
    .select()
    .from(messages)
    .where(eq(messages.nodeId, nodeId))
    .all();
  const nextOrder = existing.reduce(
    (max, m) => Math.max(max, m.orderIndex),
    -1,
  ) + 1;

  const userMessage: Message = {
    id: userMsgId,
    nodeId,
    role: "user",
    content,
    provider: null,
    model: null,
    orderIndex: nextOrder,
    status: "complete",
    createdAt: t,
    completedAt: t,
    metadata: {},
  };

  const assistantMessage: Message = {
    id: assistantMsgId,
    nodeId,
    role: "assistant",
    content: [],
    provider,
    model,
    orderIndex: nextOrder + 1,
    status: "streaming",
    createdAt: t,
    completedAt: null,
    metadata: {},
  };

  db.transaction((tx) => {
    tx.insert(messages).values(userMessage).run();
    tx.insert(messages).values(assistantMessage).run();
  });

  streamHub.start(assistantMsgId);
  runStreamingResponse(userId, nodeId, assistantMsgId, provider, model);

  return { userMessage, assistantMessage };
}

// ---- streaming the model response ----

const PERSIST_DEBOUNCE_CHARS = 80; // flush to DB roughly every ~80 chars

function runStreamingResponse(
  userId: string,
  nodeId: string,
  assistantMessageId: string,
  provider: ProviderId,
  model: string,
): void {
  // Fire and forget; runs in the background.
  void (async () => {
    try {
      const apiKey = getApiKey(userId, provider);

      // Build context: all complete messages in this node, in order.
      const history = db
        .select()
        .from(messages)
        .where(eq(messages.nodeId, nodeId))
        .orderBy(asc(messages.orderIndex))
        .all()
        .filter((m) => m.status === "complete");

      const providerMessages: ProviderMessage[] = history.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      streamHub.push(assistantMessageId, {
        type: "message_start",
        messageId: assistantMessageId,
      });

      let accumulated = "";
      let unflushed = 0;

      const flush = () => {
        if (unflushed === 0) return;
        db.update(messages)
          .set({ content: [{ type: "text", text: accumulated }] })
          .where(eq(messages.id, assistantMessageId))
          .run();
        unflushed = 0;
      };

      const stream = getProvider(provider).streamChat({
        apiKey,
        model,
        messages: providerMessages,
      });

      let errored: { code: string; message: string } | null = null;

      for await (const chunk of stream) {
        if (chunk.type === "content_delta") {
          accumulated += chunk.delta.text;
          unflushed += chunk.delta.text.length;
          streamHub.push(assistantMessageId, {
            type: "content_delta",
            messageId: assistantMessageId,
            delta: chunk.delta,
          });
          if (unflushed >= PERSIST_DEBOUNCE_CHARS) flush();
        } else if (chunk.type === "error") {
          errored = chunk.error;
          break;
        } else if (chunk.type === "complete") {
          break;
        }
      }

      flush();
      const completedAt = now();

      if (errored) {
        db.update(messages)
          .set({
            status: "errored",
            completedAt,
            metadata: { error: errored },
          })
          .where(eq(messages.id, assistantMessageId))
          .run();
        streamHub.push(assistantMessageId, {
          type: "error",
          messageId: assistantMessageId,
          error: errored,
        });
      } else {
        db.update(messages)
          .set({ status: "complete", completedAt })
          .where(eq(messages.id, assistantMessageId))
          .run();
        streamHub.push(assistantMessageId, {
          type: "message_complete",
          messageId: assistantMessageId,
          completedAt,
        });
      }
    } catch (e) {
      const err = e as Error;
      const error = { code: "unknown", message: err.message ?? String(e) };
      db.update(messages)
        .set({
          status: "errored",
          completedAt: now(),
          metadata: { error },
        })
        .where(eq(messages.id, assistantMessageId))
        .run();
      streamHub.push(assistantMessageId, {
        type: "error",
        messageId: assistantMessageId,
        error,
      });
    }
  })();
}

// ---- replay for late subscribers ----

export function buildReplayEvents(messageId: string): StreamEvent[] {
  const msg = db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!msg) return [];

  const events: StreamEvent[] = [
    { type: "message_start", messageId: msg.id },
  ];

  const text = msg.content.map((p) => p.text).join("");
  if (text) {
    events.push({
      type: "content_delta",
      messageId: msg.id,
      delta: { type: "text", text },
    });
  }

  if (msg.status === "complete") {
    events.push({
      type: "message_complete",
      messageId: msg.id,
      completedAt: msg.completedAt ?? now(),
    });
  } else if (msg.status === "errored") {
    const stored = (msg.metadata as { error?: { code: string; message: string } })
      .error;
    events.push({
      type: "error",
      messageId: msg.id,
      error: stored ?? { code: "unknown", message: "Stream errored." },
    });
  }

  return events;
}
