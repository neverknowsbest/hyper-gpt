import { and, eq, asc } from "drizzle-orm";
import { db } from "./db";
import {
  canvases,
  nodes,
  messages,
  edges,
  providerConfigs,
  users,
} from "./db/schema";
import { getProvider, type ProviderMessage } from "./providers";
import { streamHub } from "./streaming";
import type {
  Canvas,
  ContentPart,
  CreateCanvasRequest,
  Edge,
  Message,
  Node,
  ProviderConfigSummary,
  ProviderId,
  SpawnRequest,
  StreamEvent,
  UserPreferences,
} from "../shared/types";

const FALLBACK_PREFERENCES: UserPreferences = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4-6",
};

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  // Show enough prefix that the user can tell which key this is, then last 4.
  const prefixLen = key.startsWith("sk-ant-") ? 7 : key.startsWith("sk-") ? 3 : 4;
  return `${key.slice(0, prefixLen)}…${"•".repeat(5)}${key.slice(-4)}`;
}

const KNOWN_PROVIDERS: ProviderId[] = ["anthropic", "openai"];

export function listProviderConfigs(userId: string): ProviderConfigSummary[] {
  const rows = db
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.userId, userId))
    .all();
  const byProvider = new Map(rows.map((r) => [r.provider, r] as const));
  return KNOWN_PROVIDERS.map((p) => {
    const row = byProvider.get(p);
    return {
      provider: p,
      hasKey: !!row,
      masked: row ? maskKey(row.apiKey) : null,
    };
  });
}

export function upsertProviderConfig(
  userId: string,
  provider: ProviderId,
  apiKey: string,
): ProviderConfigSummary {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");

  const existing = db
    .select()
    .from(providerConfigs)
    .where(
      and(
        eq(providerConfigs.userId, userId),
        eq(providerConfigs.provider, provider),
      ),
    )
    .get();

  const t = new Date().toISOString();
  if (existing) {
    db.update(providerConfigs)
      .set({ apiKey: trimmed, updatedAt: t })
      .where(eq(providerConfigs.id, existing.id))
      .run();
  } else {
    db.insert(providerConfigs)
      .values({
        id: uuid(),
        userId,
        provider,
        apiKey: trimmed,
        createdAt: t,
        updatedAt: t,
      })
      .run();
  }
  return { provider, hasKey: true, masked: maskKey(trimmed) };
}

export function deleteProviderConfig(
  userId: string,
  provider: ProviderId,
): void {
  db.delete(providerConfigs)
    .where(
      and(
        eq(providerConfigs.userId, userId),
        eq(providerConfigs.provider, provider),
      ),
    )
    .run();
}

export function getUserPreferences(userId: string): UserPreferences {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return FALLBACK_PREFERENCES;
  const prefs = (user.metadata as { preferences?: Partial<UserPreferences> })
    .preferences;
  return {
    defaultProvider: prefs?.defaultProvider ?? FALLBACK_PREFERENCES.defaultProvider,
    defaultModel: prefs?.defaultModel ?? FALLBACK_PREFERENCES.defaultModel,
  };
}

export function setUserPreferences(
  userId: string,
  prefs: UserPreferences,
): UserPreferences {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error("User not found");
  const metadata = {
    ...user.metadata,
    preferences: prefs,
  };
  db.update(users).set({ metadata }).where(eq(users.id, userId)).run();
  return prefs;
}

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

export function getCanvasStructure(canvasId: string): {
  canvas: Canvas;
  nodes: Node[];
  edges: Edge[];
} | null {
  const canvas = db
    .select()
    .from(canvases)
    .where(eq(canvases.id, canvasId))
    .get();
  if (!canvas) return null;

  const canvasNodes = db
    .select()
    .from(nodes)
    .where(eq(nodes.canvasId, canvasId))
    .all();

  // Edges within this canvas: their source nodes belong to this canvas.
  const nodeIds = new Set(canvasNodes.map((n) => n.id));
  const allEdges = db.select().from(edges).all();
  const canvasEdges = allEdges.filter(
    (e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId),
  ) as Edge[];

  return { canvas, nodes: canvasNodes, edges: canvasEdges };
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

// ---- context replay ----

function citationPrefix(citationText: string, standalone: boolean): string {
  if (standalone) {
    return `Tell me more about this part of your previous response:\n\n> ${citationText}`;
  }
  return `Regarding this part of your previous response:\n\n> ${citationText}\n\n`;
}

function isEmptyContent(content: ContentPart[]): boolean {
  return content.map((p) => p.text).join("").trim() === "";
}

// Builds the message history to send to the model for an assistant turn in
// `nodeId`. Walks the full lineage from root to this node. For each non-root
// ancestor (and for this node itself if it's a spawn), the synthetic citation
// prefix is folded into that node's first user message at replay time.
//
// Why every level needs the transformation, not just the leaf: a spawned
// node's first user message is stored verbatim — empty when the user just
// hit "elaborate" without typing. If that node later becomes an ancestor of
// a deeper spawn, the empty message would be sent to the provider unchanged
// and the request would be rejected. Same applies to typed-follow-up
// messages: the user originally saw the model respond to the *prefixed*
// version, so the replay has to match that.
//
// See docs/data-model.md "Context replay (the rule for spawned nodes)".
function buildContext(nodeId: string): ProviderMessage[] {
  type ChainStep = {
    nodeId: string;
    inboundEdge: Edge | null;
    upToOrderIndex: number; // inclusive; Infinity for the leaf
  };

  // Walk up from `nodeId` to the root, recording each step.
  const chain: ChainStep[] = [];
  let cursorNodeId: string | null = nodeId;
  let cursorUpTo: number = Number.POSITIVE_INFINITY;

  while (cursorNodeId) {
    const edgeRow = db
      .select()
      .from(edges)
      .where(eq(edges.targetNodeId, cursorNodeId))
      .get();
    const inboundEdge = (edgeRow ?? null) as Edge | null;
    chain.unshift({
      nodeId: cursorNodeId,
      inboundEdge,
      upToOrderIndex: cursorUpTo,
    });
    if (!inboundEdge) break;

    const srcMsg = db
      .select()
      .from(messages)
      .where(eq(messages.id, inboundEdge.sourceMessageId))
      .get();
    if (!srcMsg) break;

    cursorNodeId = inboundEdge.sourceNodeId;
    cursorUpTo = srcMsg.orderIndex;
  }

  const result: ProviderMessage[] = [];
  for (const step of chain) {
    const nodeMessages = db
      .select()
      .from(messages)
      .where(eq(messages.nodeId, step.nodeId))
      .orderBy(asc(messages.orderIndex))
      .all()
      .filter(
        (m) => m.status === "complete" && m.orderIndex <= step.upToOrderIndex,
      );

    nodeMessages.forEach((m, i) => {
      // Only the first message of a *non-root* node gets the citation prefix.
      const needsPrefix = i === 0 && step.inboundEdge !== null;
      if (!needsPrefix) {
        result.push({ role: m.role, content: m.content });
        return;
      }

      const standalone = isEmptyContent(m.content);
      const prefix = citationPrefix(step.inboundEdge!.citationText, standalone);

      if (standalone) {
        result.push({
          role: m.role,
          content: [{ type: "text", text: prefix }],
        });
      } else {
        const firstText = m.content[0]?.text ?? "";
        const rest = m.content.slice(1);
        result.push({
          role: m.role,
          content: [
            { type: "text", text: prefix + firstText },
            ...rest,
          ],
        });
      }
    });
  }

  return result;
}

// ---- spawn ----

export interface SpawnResult {
  node: Node;
  edge: Edge;
  userMessage: Message;
  assistantMessage: Message;
}

export function spawnNode(userId: string, input: SpawnRequest): SpawnResult {
  const sourceNode = db
    .select()
    .from(nodes)
    .where(eq(nodes.id, input.sourceNodeId))
    .get();
  if (!sourceNode) throw new Error(`Source node not found: ${input.sourceNodeId}`);

  const canvas = db
    .select()
    .from(canvases)
    .where(eq(canvases.id, sourceNode.canvasId))
    .get();
  if (!canvas) throw new Error("Canvas not found for source node");
  if (canvas.userId !== userId) throw new Error("Forbidden");

  const sourceMessage = db
    .select()
    .from(messages)
    .where(eq(messages.id, input.sourceMessageId))
    .get();
  if (!sourceMessage) {
    throw new Error(`Source message not found: ${input.sourceMessageId}`);
  }
  if (sourceMessage.nodeId !== input.sourceNodeId) {
    throw new Error("Source message does not belong to source node");
  }
  if (sourceMessage.role !== "assistant") {
    throw new Error("Citations must come from an assistant message");
  }

  const provider = sourceNode.providerOverride ?? canvas.defaultProvider;
  const model = sourceNode.modelOverride ?? canvas.defaultModel;

  const t = now();
  const newNodeId = uuid();
  const edgeId = uuid();
  const userMsgId = uuid();
  const assistantMsgId = uuid();

  const userWroteSomething = !isEmptyContent(input.firstUserMessage);
  const title = userWroteSomething
    ? deriveTitle(input.firstUserMessage)
    : deriveTitle([{ type: "text", text: input.citation.text }]);

  const newNode: Node = {
    id: newNodeId,
    canvasId: sourceNode.canvasId,
    title,
    providerOverride: null,
    modelOverride: null,
    createdAt: t,
    updatedAt: t,
    metadata: {},
  };

  const edge: Edge = {
    id: edgeId,
    sourceNodeId: input.sourceNodeId,
    sourceMessageId: input.sourceMessageId,
    targetNodeId: newNodeId,
    citationStart: input.citation.start,
    citationEnd: input.citation.end,
    citationText: input.citation.text,
    kind: "spawn",
    createdAt: t,
    metadata: {},
  };

  const userMessage: Message = {
    id: userMsgId,
    nodeId: newNodeId,
    role: "user",
    content: input.firstUserMessage,
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
    nodeId: newNodeId,
    role: "assistant",
    content: [],
    provider,
    model,
    orderIndex: 1,
    status: "streaming",
    createdAt: t,
    completedAt: null,
    metadata: {},
  };

  db.transaction((tx) => {
    tx.insert(nodes).values(newNode).run();
    tx.insert(edges).values(edge).run();
    tx.insert(messages).values(userMessage).run();
    tx.insert(messages).values(assistantMessage).run();
  });

  streamHub.start(assistantMsgId);
  runStreamingResponse(userId, newNodeId, assistantMsgId, provider, model);

  return { node: newNode, edge, userMessage, assistantMessage };
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

      const providerMessages = buildContext(nodeId);

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
