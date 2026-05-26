import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { eq } from "drizzle-orm";
import { db, ensureLocalUser, bootstrapProviderKeysFromEnv } from "./db";
import { canvases, nodes, messages, edges } from "./db/schema";
import {
  createCanvas,
  sendUserMessage,
  listCanvases,
  getNodeWithMessages,
  buildReplayEvents,
} from "./orchestrator";
import { streamHub } from "./streaming";
import type {
  CreateCanvasRequest,
  SendMessageRequest,
  StreamEvent,
} from "../shared/types";

const localUser = ensureLocalUser();
bootstrapProviderKeysFromEnv(localUser.id);
console.log(`[boot] local user: ${localUser.id}`);

const app = new Hono();

app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: err.message ?? String(err) }, 500);
});

// Identifies the local user to the frontend.
app.get("/api/me", (c) => {
  return c.json({ userId: localUser.id });
});

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    userId: localUser.id,
    createdAt: localUser.createdAt,
  });
});

// Guard: any /api/users/:userId/... route requires userId to match the local user.
function assertLocalUser(userIdParam: string): void {
  if (userIdParam !== localUser.id) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

app.get("/api/users/:userId/canvases", (c) => {
  assertLocalUser(c.req.param("userId"));
  return c.json(listCanvases(localUser.id));
});

app.post("/api/users/:userId/canvases", async (c) => {
  assertLocalUser(c.req.param("userId"));
  const body = (await c.req.json()) as CreateCanvasRequest;
  const result = createCanvas(localUser.id, body);
  return c.json({
    canvas: result.canvas,
    seedNode: result.seedNode,
    userMessage: result.userMessage,
    assistantMessageId: result.assistantMessage.id,
  });
});

app.get("/api/users/:userId/nodes/:nodeId", (c) => {
  assertLocalUser(c.req.param("userId"));
  const nodeId = c.req.param("nodeId");
  const data = getNodeWithMessages(nodeId);
  if (!data) return c.json({ error: "Not found" }, 404);

  const inboundEdge =
    db.select().from(edges).where(eq(edges.targetNodeId, nodeId)).get() ?? null;
  const outboundEdges = db
    .select()
    .from(edges)
    .where(eq(edges.sourceNodeId, nodeId))
    .all();

  return c.json({
    node: data.node,
    messages: data.messages,
    inboundEdge,
    outboundEdges,
  });
});

app.post("/api/users/:userId/nodes/:nodeId/messages", async (c) => {
  assertLocalUser(c.req.param("userId"));
  const nodeId = c.req.param("nodeId");
  const body = (await c.req.json()) as SendMessageRequest;
  const result = sendUserMessage(localUser.id, nodeId, body.content);
  return c.json({
    userMessage: result.userMessage,
    assistantMessageId: result.assistantMessage.id,
  });
});

// SSE stream for an in-progress (or completed) assistant message.
app.get("/api/stream/:messageId", (c) => {
  const messageId = c.req.param("messageId");

  return streamSSE(c, async (stream) => {
    const msg = db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();

    if (!msg) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          messageId,
          error: { code: "not_found", message: "Message not found" },
        } satisfies StreamEvent),
      });
      return;
    }

    const send = async (e: StreamEvent) => {
      await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    };

    // If already complete or errored: replay from DB and close.
    if (msg.status !== "streaming") {
      for (const e of buildReplayEvents(messageId)) await send(e);
      return;
    }

    // Live stream: subscribe to the hub. Replay any existing events first.
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const handler = async (event: StreamEvent) => {
      await send(event);
      if (event.type === "message_complete" || event.type === "error") {
        resolveDone();
      }
    };

    const sub = streamHub.subscribe(messageId, handler);
    for (const e of sub.existing) await send(e);

    if (sub.done) {
      sub.unsubscribe();
      return;
    }

    // Also bail if the client disconnects.
    stream.onAbort(() => {
      sub.unsubscribe();
      resolveDone();
    });

    await done;
    sub.unsubscribe();
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`[boot] backend listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
