import { useEffect, useMemo, useState } from "react";
import {
  createCanvas,
  getMe,
  getNode,
  listCanvases,
  messageText,
  sendMessage,
  subscribeToMessage,
} from "./lib/api";
import type {
  Canvas,
  Message,
  ProviderId,
  StreamEvent,
} from "../../shared/types";

const DEFAULT_PROVIDER: ProviderId = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-7";

export function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(({ userId }) => setUserId(userId))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!userId) return;
    listCanvases(userId).then(setCanvases).catch((e) => setError(String(e)));
  }, [userId]);

  const refreshCanvases = async () => {
    if (!userId) return;
    setCanvases(await listCanvases(userId));
  };

  return (
    <div style={layout}>
      <aside style={sidebar}>
        <h1 style={brand}>HyperGPT</h1>
        {error && <div style={errBox}>{error}</div>}
        {userId && (
          <NewCanvasForm
            userId={userId}
            onCreate={async (nodeId) => {
              setActiveNodeId(nodeId);
              await refreshCanvases();
            }}
          />
        )}
        <h2 style={sectionTitle}>Canvases</h2>
        <ul style={canvasList}>
          {canvases.map((c) => (
            <li key={c.id}>
              <button
                style={{
                  ...canvasItem,
                  fontWeight: activeNodeId === c.seedNodeId ? 600 : 400,
                }}
                onClick={() => setActiveNodeId(c.seedNodeId)}
              >
                {c.title}
              </button>
            </li>
          ))}
          {canvases.length === 0 && <li style={muted}>None yet.</li>}
        </ul>
      </aside>

      <main style={chatPane}>
        {userId && activeNodeId ? (
          <ChatView userId={userId} nodeId={activeNodeId} />
        ) : (
          <div style={empty}>
            <p>Create a canvas to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function NewCanvasForm({
  userId,
  onCreate,
}: {
  userId: string;
  onCreate: (nodeId: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await createCanvas(userId, {
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        seedUserMessage: [{ type: "text", text }],
      });
      setText("");
      onCreate(res.seedNode.id);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "0.5rem" }}>
      <textarea
        rows={3}
        placeholder="Seed prompt to start a new canvas…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={textareaStyle}
      />
      <button type="submit" disabled={busy || !text.trim()} style={buttonStyle}>
        {busy ? "Creating…" : "Create canvas"}
      </button>
      {err && <div style={errBox}>{err}</div>}
    </form>
  );
}

function ChatView({ userId, nodeId }: { userId: string; nodeId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load node + initial messages.
  useEffect(() => {
    setLoading(true);
    setError(null);
    getNode(userId, nodeId)
      .then((res) => {
        setMessages(res.messages);
        const streaming = res.messages.find((m) => m.status === "streaming");
        if (streaming) setStreamingId(streaming.id);
        else setStreamingId(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [userId, nodeId]);

  // Subscribe to the in-progress assistant message, if any.
  useEffect(() => {
    if (!streamingId) return;
    const cleanup = subscribeToMessage(streamingId, {
      onEvent: (event: StreamEvent) => {
        if (event.type === "content_delta") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    content: [
                      {
                        type: "text",
                        text: messageText(m) + event.delta.text,
                      },
                    ],
                  }
                : m,
            ),
          );
        } else if (event.type === "message_complete") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    status: "complete",
                    completedAt: event.completedAt,
                  }
                : m,
            ),
          );
          setStreamingId(null);
        } else if (event.type === "error") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? { ...m, status: "errored" }
                : m,
            ),
          );
          setError(event.error.message);
          setStreamingId(null);
        }
      },
    });
    return cleanup;
  }, [streamingId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending || streamingId) return;
    setSending(true);
    setError(null);
    try {
      const content = [{ type: "text" as const, text: input }];
      const res = await sendMessage(userId, nodeId, { content });
      setInput("");
      setMessages((prev) => [
        ...prev,
        res.userMessage,
        {
          id: res.assistantMessageId,
          nodeId,
          role: "assistant",
          content: [],
          provider: null,
          model: null,
          orderIndex: res.userMessage.orderIndex + 1,
          status: "streaming",
          createdAt: new Date().toISOString(),
          completedAt: null,
          metadata: {},
        },
      ]);
      setStreamingId(res.assistantMessageId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const inputDisabled = sending || !!streamingId;

  return (
    <div style={chatContainer}>
      <div style={transcript}>
        {loading && <div style={muted}>Loading…</div>}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {error && <div style={errBox}>{error}</div>}
      </div>
      <form onSubmit={submit} style={composer}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            streamingId ? "Waiting for response to finish…" : "Reply…"
          }
          disabled={inputDisabled}
          style={textareaStyle}
        />
        <button
          type="submit"
          disabled={inputDisabled || !input.trim()}
          style={buttonStyle}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const text = useMemo(() => messageText(message), [message]);
  const isUser = message.role === "user";
  return (
    <div
      style={{
        ...bubble,
        alignSelf: isUser ? "flex-end" : "flex-start",
        background: isUser
          ? "color-mix(in srgb, dodgerblue 16%, Canvas)"
          : "color-mix(in srgb, CanvasText 6%, Canvas)",
        whiteSpace: "pre-wrap",
      }}
    >
      <div style={role}>{isUser ? "You" : "Assistant"}</div>
      <div>
        {text || (message.status === "streaming" ? "…" : "")}
        {message.status === "streaming" && (
          <span style={cursor}> ▋</span>
        )}
        {message.status === "errored" && (
          <span style={{ color: "crimson" }}> ⚠ errored</span>
        )}
      </div>
    </div>
  );
}

// ---- styles ----

const layout = {
  display: "grid",
  gridTemplateColumns: "280px 1fr",
  height: "100dvh",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

const sidebar = {
  borderRight: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  padding: "1rem",
  overflowY: "auto",
  display: "grid",
  gap: "1rem",
  alignContent: "start",
} as const;

const brand = { margin: 0, fontSize: "1.2rem" } as const;

const sectionTitle = {
  margin: 0,
  fontSize: "0.8rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "color-mix(in srgb, CanvasText 60%, Canvas)",
};

const canvasList = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: "0.25rem",
} as const;

const canvasItem = {
  background: "transparent",
  border: "none",
  textAlign: "left" as const,
  padding: "0.5rem 0.6rem",
  borderRadius: 6,
  cursor: "pointer",
  width: "100%",
  color: "CanvasText",
  font: "inherit",
};

const chatPane = {
  display: "flex",
  minHeight: 0,
} as const;

const chatContainer = {
  display: "grid",
  gridTemplateRows: "1fr auto",
  width: "100%",
  minHeight: 0,
} as const;

const transcript = {
  overflowY: "auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minHeight: 0,
} as const;

const bubble = {
  padding: "0.75rem 1rem",
  borderRadius: 12,
  maxWidth: "min(60ch, 80%)",
  lineHeight: 1.45,
} as const;

const role = {
  fontSize: "0.7rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "color-mix(in srgb, CanvasText 55%, Canvas)",
  marginBottom: "0.25rem",
};

const cursor = {
  opacity: 0.6,
  animation: "blink 1s infinite",
} as const;

const composer = {
  borderTop: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  padding: "0.75rem 1rem",
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: "0.5rem",
  alignItems: "end",
} as const;

const textareaStyle = {
  font: "inherit",
  padding: "0.5rem",
  borderRadius: 6,
  border: "1px solid color-mix(in srgb, CanvasText 20%, Canvas)",
  background: "Canvas",
  color: "CanvasText",
  resize: "vertical" as const,
};

const buttonStyle = {
  font: "inherit",
  padding: "0.5rem 1rem",
  borderRadius: 6,
  border: "none",
  background: "dodgerblue",
  color: "white",
  cursor: "pointer",
} as const;

const empty = {
  display: "grid",
  placeItems: "center",
  width: "100%",
  color: "color-mix(in srgb, CanvasText 50%, Canvas)",
} as const;

const muted = {
  color: "color-mix(in srgb, CanvasText 50%, Canvas)",
  fontSize: "0.85rem",
} as const;

const errBox = {
  background: "color-mix(in srgb, crimson 12%, Canvas)",
  color: "crimson",
  padding: "0.5rem 0.75rem",
  borderRadius: 6,
  fontSize: "0.85rem",
} as const;
