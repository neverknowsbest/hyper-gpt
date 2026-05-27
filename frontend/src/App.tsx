import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createCanvas,
  getMe,
  getNode,
  listCanvases,
  messageText,
  sendMessage,
  spawn,
  subscribeToMessage,
} from "./lib/api";
import { MapView } from "./views/MapView";
import type {
  Canvas,
  Edge,
  Message,
  ProviderId,
  StreamEvent,
} from "../../shared/types";

type ViewMode = "chat" | "map";

const DEFAULT_PROVIDER: ProviderId = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("chat");
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

  const refreshCanvases = useCallback(async () => {
    if (!userId) return;
    setCanvases(await listCanvases(userId));
  }, [userId]);

  const openCanvas = useCallback((canvas: Canvas) => {
    setActiveCanvasId(canvas.id);
    setActiveNodeId(canvas.seedNodeId);
    setView("chat");
  }, []);

  const activeCanvas = useMemo(
    () => canvases.find((c) => c.id === activeCanvasId) ?? null,
    [canvases, activeCanvasId],
  );

  return (
    <div style={layout}>
      <aside style={sidebar}>
        <h1 style={brand}>HyperGPT</h1>
        {error && <div style={errBox}>{error}</div>}
        {userId && (
          <NewCanvasForm
            userId={userId}
            onCreate={async (canvas) => {
              await refreshCanvases();
              openCanvas(canvas);
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
                  fontWeight: activeCanvasId === c.id ? 600 : 400,
                }}
                onClick={() => openCanvas(c)}
              >
                {c.title}
              </button>
            </li>
          ))}
          {canvases.length === 0 && <li style={muted}>None yet.</li>}
        </ul>
      </aside>

      <main style={chatPane}>
        {userId && activeCanvas ? (
          <>
            <CanvasTopBar
              canvasTitle={activeCanvas.title}
              view={view}
              onSetView={setView}
            />
            {view === "chat" && activeNodeId ? (
              <ChatView
                key={activeNodeId}
                userId={userId}
                nodeId={activeNodeId}
                onNavigate={(nodeId) => {
                  setActiveNodeId(nodeId);
                  setView("chat");
                }}
              />
            ) : (
              <MapView
                key={activeCanvas.id}
                userId={userId}
                canvasId={activeCanvas.id}
                activeNodeId={activeNodeId}
                onPickNode={(nodeId) => {
                  setActiveNodeId(nodeId);
                  setView("chat");
                }}
              />
            )}
          </>
        ) : (
          <div style={empty}>
            <p>Create a canvas to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function CanvasTopBar({
  canvasTitle,
  view,
  onSetView,
}: {
  canvasTitle: string;
  view: ViewMode;
  onSetView: (v: ViewMode) => void;
}) {
  return (
    <div style={topBarStyle}>
      <div style={topBarTitle}>{canvasTitle}</div>
      <div style={segmentedControl}>
        <button
          style={segmentButton(view === "chat")}
          onClick={() => onSetView("chat")}
        >
          Chat
        </button>
        <button
          style={segmentButton(view === "map")}
          onClick={() => onSetView("map")}
        >
          Map
        </button>
      </div>
    </div>
  );
}

function NewCanvasForm({
  userId,
  onCreate,
}: {
  userId: string;
  onCreate: (canvas: Canvas) => void | Promise<void>;
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
      await onCreate(res.canvas);
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

interface SelectionTarget {
  messageId: string;
  start: number;
  end: number;
  text: string;
  anchorRect: DOMRect;
}

function ChatView({
  userId,
  nodeId,
  onNavigate,
}: {
  userId: string;
  nodeId: string;
  onNavigate: (nodeId: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inboundEdge, setInboundEdge] = useState<Edge | null>(null);
  const [outboundEdges, setOutboundEdges] = useState<Edge[]>([]);
  const [parentTitle, setParentTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [spawnDraft, setSpawnDraft] = useState<SelectionTarget | null>(null);

  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Load node + initial messages + edges.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelection(null);
    setSpawnDraft(null);
    getNode(userId, nodeId)
      .then(async (res) => {
        setMessages(res.messages);
        setInboundEdge(res.inboundEdge);
        setOutboundEdges(res.outboundEdges);
        const streaming = res.messages.find((m) => m.status === "streaming");
        setStreamingId(streaming?.id ?? null);

        if (res.inboundEdge) {
          // Fetch the parent node title for the floating header.
          try {
            const parent = await getNode(userId, res.inboundEdge.sourceNodeId);
            setParentTitle(parent.node.title);
          } catch {
            setParentTitle(null);
          }
        } else {
          setParentTitle(null);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [userId, nodeId]);

  // Subscribe to in-flight assistant message.
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
                ? { ...m, status: "complete", completedAt: event.completedAt }
                : m,
            ),
          );
          setStreamingId(null);
        } else if (event.type === "error") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId ? { ...m, status: "errored" } : m,
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

  // Selection detection — only for completed assistant messages.
  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element =
      container.nodeType === 1 ? (container as Element) : container.parentElement;
    const messageEl = element?.closest("[data-message-id]") as HTMLElement | null;
    if (!messageEl) {
      setSelection(null);
      return;
    }
    const messageId = messageEl.dataset.messageId;
    if (!messageId) {
      setSelection(null);
      return;
    }
    // Confirm both endpoints are within the same message.
    const endEl =
      range.endContainer.nodeType === 1
        ? (range.endContainer as Element)
        : range.endContainer.parentElement;
    if (endEl?.closest("[data-message-id]") !== messageEl) {
      setSelection(null);
      return;
    }
    // Compute offsets within the message text.
    const preRange = document.createRange();
    preRange.selectNodeContents(messageEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const text = range.toString();
    if (!text.trim()) {
      setSelection(null);
      return;
    }
    const end = start + text.length;
    const anchorRect = range.getBoundingClientRect();
    setSelection({ messageId, start, end, text, anchorRect });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  const openSpawnDraft = () => {
    if (!selection) return;
    setSpawnDraft(selection);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleSpawnSubmit = async (firstMessage: string) => {
    if (!spawnDraft) return;
    const res = await spawn(userId, {
      sourceNodeId: nodeId,
      sourceMessageId: spawnDraft.messageId,
      citation: {
        start: spawnDraft.start,
        end: spawnDraft.end,
        text: spawnDraft.text,
      },
      firstUserMessage: [{ type: "text", text: firstMessage }],
    });
    setSpawnDraft(null);
    onNavigate(res.node.id);
  };

  const inputDisabled = sending || !!streamingId;

  return (
    <div style={chatContainer}>
      {inboundEdge && (
        <ParentHeader
          edge={inboundEdge}
          parentTitle={parentTitle}
          onTap={() => onNavigate(inboundEdge.sourceNodeId)}
        />
      )}
      <div style={transcript} ref={transcriptRef}>
        {loading && <div style={muted}>Loading…</div>}
        {messages.map((m) => {
          // Hide the first user bubble in a spawned node when it has no
          // content — the parent header already shows what was asked about.
          const isEmptyStandaloneFirstUser =
            inboundEdge !== null &&
            m.orderIndex === 0 &&
            m.role === "user" &&
            messageText(m).trim() === "";
          if (isEmptyStandaloneFirstUser) return null;
          return (
            <MessageBubble
              key={m.id}
              message={m}
              outboundEdges={outboundEdges.filter(
                (e) => e.sourceMessageId === m.id,
              )}
              onJumpToChild={onNavigate}
            />
          );
        })}
        {error && <div style={errBox}>{error}</div>}
      </div>

      {selection && (
        <SpinOffButton
          anchorRect={selection.anchorRect}
          onClick={openSpawnDraft}
        />
      )}

      {spawnDraft && (
        <SpawnModal
          citation={spawnDraft.text}
          onCancel={() => setSpawnDraft(null)}
          onSubmit={handleSpawnSubmit}
        />
      )}

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

function ParentHeader({
  edge,
  parentTitle,
  onTap,
}: {
  edge: Edge;
  parentTitle: string | null;
  onTap: () => void;
}) {
  return (
    <button onClick={onTap} style={parentHeaderStyle}>
      <div style={parentHeaderLabel}>
        ↑ {parentTitle ?? "parent"}
      </div>
      <div style={parentHeaderCitation}>“{edge.citationText}”</div>
    </button>
  );
}

function MessageBubble({
  message,
  outboundEdges,
  onJumpToChild,
}: {
  message: Message;
  outboundEdges: Edge[];
  onJumpToChild: (nodeId: string) => void;
}) {
  const text = useMemo(() => messageText(message), [message]);
  const isUser = message.role === "user";

  const content = useMemo<ReactNode>(() => {
    if (!text) {
      return message.status === "streaming" ? "…" : "";
    }
    if (outboundEdges.length === 0) return text;
    const sorted = [...outboundEdges].sort(
      (a, b) => a.citationStart - b.citationStart,
    );
    const parts: ReactNode[] = [];
    let cursor = 0;
    let key = 0;
    for (const edge of sorted) {
      // Skip out-of-bounds edges (shouldn't happen normally).
      if (edge.citationStart < cursor) continue;
      if (edge.citationStart > cursor) {
        parts.push(
          <span key={`t${key++}`}>{text.slice(cursor, edge.citationStart)}</span>,
        );
      }
      parts.push(
        <span
          key={`e${edge.id}`}
          role="link"
          tabIndex={0}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onJumpToChild(edge.targetNodeId);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              onJumpToChild(edge.targetNodeId);
            }
          }}
          style={highlightStyle}
        >
          {text.slice(edge.citationStart, edge.citationEnd)}
        </span>,
      );
      cursor = edge.citationEnd;
    }
    if (cursor < text.length) {
      parts.push(<span key={`t${key++}`}>{text.slice(cursor)}</span>);
    }
    return parts;
  }, [text, outboundEdges, onJumpToChild, message.status]);

  return (
    <div
      style={{
        ...bubble,
        alignSelf: isUser ? "flex-end" : "flex-start",
        background: isUser
          ? "color-mix(in srgb, dodgerblue 16%, Canvas)"
          : "color-mix(in srgb, CanvasText 6%, Canvas)",
      }}
    >
      <div style={role}>{isUser ? "You" : "Assistant"}</div>
      {/* data-message-id on the content div only, so selection-offset math
          excludes the role label above. */}
      <div data-message-id={message.id} style={{ whiteSpace: "pre-wrap" }}>
        {content}
        {message.status === "streaming" && <span style={cursor}> ▋</span>}
        {message.status === "errored" && (
          <span style={{ color: "crimson", userSelect: "none" }}>
            {" ⚠ errored"}
          </span>
        )}
      </div>
    </div>
  );
}

function SpinOffButton({
  anchorRect,
  onClick,
}: {
  anchorRect: DOMRect;
  onClick: () => void;
}) {
  // Position just below the selection, clamped to the viewport.
  const ref = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const btnWidth = 110;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - btnWidth - 8,
        anchorRect.left + anchorRect.width / 2 - btnWidth / 2,
      ),
    );
    const top = anchorRect.bottom + 8;
    setPos({ left, top });
  }, [anchorRect]);

  return (
    <button
      ref={ref}
      onMouseDown={(e) => {
        // Don't blur the selection before our click handler runs.
        e.preventDefault();
      }}
      onClick={onClick}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 10,
        padding: "0.4rem 0.8rem",
        borderRadius: 999,
        border: "none",
        background: "dodgerblue",
        color: "white",
        font: "inherit",
        fontSize: "0.85rem",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      }}
    >
      ↳ Spin off
    </button>
  );
}

function SpawnModal({
  citation,
  onCancel,
  onSubmit,
}: {
  citation: string;
  onCancel: () => void;
  onSubmit: (firstMessage: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(text);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const hasText = text.trim().length > 0;

  return (
    <div style={modalBackdrop} onMouseDown={onCancel}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={modalCard}
      >
        <div style={sectionTitle}>Spin off a tangent</div>
        <blockquote style={modalQuote}>{citation}</blockquote>
        <textarea
          ref={textareaRef}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Optional follow-up — leave blank to just elaborate on the selection"
          style={textareaStyle}
        />
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ ...buttonStyle, background: "transparent", color: "CanvasText" }}
          >
            Cancel
          </button>
          <button type="submit" disabled={busy} style={buttonStyle}>
            {busy ? "Spinning…" : hasText ? "Spin off" : "Just elaborate"}
          </button>
        </div>
      </form>
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
  display: "grid",
  gridTemplateRows: "auto 1fr",
  minHeight: 0,
  overflow: "hidden",
} as const;

const topBarStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.5rem 1rem",
  borderBottom: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  background: "color-mix(in srgb, CanvasText 2%, Canvas)",
  gap: "1rem",
} as const;

const topBarTitle = {
  fontSize: "0.95rem",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

const segmentedControl = {
  display: "inline-flex",
  border: "1px solid color-mix(in srgb, CanvasText 20%, Canvas)",
  borderRadius: 6,
  overflow: "hidden",
} as const;

const segmentButton = (active: boolean) =>
  ({
    background: active ? "dodgerblue" : "transparent",
    color: active ? "white" : "CanvasText",
    border: "none",
    padding: "0.35rem 0.8rem",
    font: "inherit",
    fontSize: "0.85rem",
    cursor: "pointer",
  }) as const;

const chatContainer = {
  display: "grid",
  gridTemplateRows: "auto 1fr auto",
  width: "100%",
  minHeight: 0,
  position: "relative",
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

const cursor = { opacity: 0.6, userSelect: "none" } as const;

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
  width: "100%",
  boxSizing: "border-box" as const,
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

const highlightStyle = {
  background: "color-mix(in srgb, dodgerblue 20%, Canvas)",
  borderBottom: "1.5px solid dodgerblue",
  borderRadius: 2,
  padding: 0,
  margin: 0,
  cursor: "pointer",
  font: "inherit",
  color: "inherit",
  border: "none",
  borderBottomWidth: "1.5px",
  borderBottomStyle: "solid" as const,
  borderBottomColor: "dodgerblue",
};

const parentHeaderStyle = {
  textAlign: "left" as const,
  background: "color-mix(in srgb, CanvasText 4%, Canvas)",
  borderBottom: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  border: "none",
  borderBottomWidth: "1px",
  borderBottomStyle: "solid" as const,
  borderBottomColor: "color-mix(in srgb, CanvasText 12%, Canvas)",
  padding: "0.6rem 1rem",
  cursor: "pointer",
  display: "grid",
  gap: "0.15rem",
  font: "inherit",
  color: "CanvasText",
  width: "100%",
};

const parentHeaderLabel = {
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "color-mix(in srgb, CanvasText 55%, Canvas)",
};

const parentHeaderCitation = {
  fontSize: "0.9rem",
  fontStyle: "italic" as const,
  color: "color-mix(in srgb, CanvasText 75%, Canvas)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

const modalBackdrop = {
  position: "fixed" as const,
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "grid",
  placeItems: "center",
  zIndex: 100,
};

const modalCard = {
  background: "Canvas",
  borderRadius: 12,
  padding: "1.25rem",
  width: "min(32rem, 92vw)",
  display: "grid",
  gap: "0.75rem",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
} as const;

const modalQuote = {
  borderLeft: "3px solid dodgerblue",
  paddingLeft: "0.75rem",
  margin: 0,
  color: "color-mix(in srgb, CanvasText 75%, Canvas)",
  fontStyle: "italic" as const,
  maxHeight: "8rem",
  overflowY: "auto",
} as const;
