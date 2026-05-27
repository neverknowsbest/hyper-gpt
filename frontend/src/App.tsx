import { useCallback, useEffect, useMemo, useState } from "react";
import { createCanvas, getMe, listCanvases } from "./lib/api";
import {
  MOBILE_BREAKPOINT,
  submitOnEnter,
  useIsDesktopPointer,
  useMediaQuery,
} from "./lib/useMediaQuery";
import { ChatView } from "./views/ChatView";
import { MapView } from "./views/MapView";
import type { Canvas, ProviderId } from "../../shared/types";
import {
  buttonStyle,
  errBox,
  muted,
  sectionTitle,
  textareaStyle,
} from "./styles";

const DEFAULT_PROVIDER: ProviderId = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

type ViewMode = "chat" | "map";

export function App() {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);

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

  const goBackToCanvasesList = useCallback(() => {
    setActiveCanvasId(null);
    setActiveNodeId(null);
  }, []);

  const activeCanvas = useMemo(
    () => canvases.find((c) => c.id === activeCanvasId) ?? null,
    [canvases, activeCanvasId],
  );

  // ---- mobile: one screen at a time ----
  if (isMobile) {
    return (
      <div style={mobileShell}>
        {!activeCanvas && userId && (
          <CanvasesPanel
            userId={userId}
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            error={error}
            onCreate={async (canvas) => {
              await refreshCanvases();
              openCanvas(canvas);
            }}
            onOpen={openCanvas}
          />
        )}
        {activeCanvas && userId && (
          <>
            <CanvasTopBar
              canvasTitle={activeCanvas.title}
              view={view}
              onSetView={setView}
              onBack={goBackToCanvasesList}
              showBack
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
        )}
      </div>
    );
  }

  // ---- desktop: sidebar + main pane ----
  return (
    <div style={desktopShell}>
      <aside style={sidebar}>
        {userId && (
          <CanvasesPanel
            userId={userId}
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            error={error}
            onCreate={async (canvas) => {
              await refreshCanvases();
              openCanvas(canvas);
            }}
            onOpen={openCanvas}
            embedded
          />
        )}
      </aside>

      <main style={chatPane}>
        {userId && activeCanvas ? (
          <>
            <CanvasTopBar
              canvasTitle={activeCanvas.title}
              view={view}
              onSetView={setView}
              onBack={goBackToCanvasesList}
              showBack={false}
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

function CanvasesPanel({
  userId,
  canvases,
  activeCanvasId,
  error,
  onCreate,
  onOpen,
  embedded = false,
}: {
  userId: string;
  canvases: Canvas[];
  activeCanvasId: string | null;
  error: string | null;
  onCreate: (canvas: Canvas) => Promise<void> | void;
  onOpen: (canvas: Canvas) => void;
  embedded?: boolean;
}) {
  return (
    <div style={embedded ? embeddedPanel : fullScreenPanel}>
      <h1 style={brand}>HyperGPT</h1>
      {error && <div style={errBox}>{error}</div>}
      <NewCanvasForm userId={userId} onCreate={onCreate} />
      <h2 style={sectionTitle}>Canvases</h2>
      <ul style={canvasList}>
        {canvases.map((c) => (
          <li key={c.id}>
            <button
              style={{
                ...canvasItem,
                fontWeight: activeCanvasId === c.id ? 600 : 400,
              }}
              onClick={() => onOpen(c)}
            >
              {c.title}
            </button>
          </li>
        ))}
        {canvases.length === 0 && <li style={muted}>None yet.</li>}
      </ul>
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
  const isDesktop = useIsDesktopPointer();
  const onKeyDown = submitOnEnter(isDesktop);

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
        onKeyDown={onKeyDown}
        style={textareaStyle}
      />
      <button type="submit" disabled={busy || !text.trim()} style={buttonStyle}>
        {busy ? "Creating…" : "Create canvas"}
      </button>
      {err && <div style={errBox}>{err}</div>}
    </form>
  );
}

function CanvasTopBar({
  canvasTitle,
  view,
  onSetView,
  onBack,
  showBack,
}: {
  canvasTitle: string;
  view: ViewMode;
  onSetView: (v: ViewMode) => void;
  onBack: () => void;
  showBack: boolean;
}) {
  return (
    <div style={topBarStyle}>
      {showBack && (
        <button
          onClick={onBack}
          style={backButtonStyle}
          aria-label="Back to canvases"
        >
          ←
        </button>
      )}
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

// ---- styles ----

const desktopShell = {
  display: "grid",
  gridTemplateColumns: "280px 1fr",
  height: "100dvh",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

const mobileShell = {
  display: "grid",
  gridTemplateRows: "auto 1fr",
  height: "100dvh",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
} as const;

const sidebar = {
  borderRight: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  overflowY: "auto",
} as const;

const embeddedPanel = {
  padding: "1rem",
  display: "grid",
  gap: "1rem",
  alignContent: "start",
} as const;

const fullScreenPanel = {
  padding: "1.25rem 1rem max(1rem, env(safe-area-inset-bottom))",
  display: "grid",
  gap: "1rem",
  alignContent: "start",
  overflowY: "auto",
} as const;

const brand = { margin: 0, fontSize: "1.25rem" } as const;

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
  padding: "0.75rem 0.7rem",
  borderRadius: 6,
  cursor: "pointer",
  width: "100%",
  color: "CanvasText",
  font: "inherit",
  minHeight: 44,
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
  padding: "0.4rem 0.75rem max(0.4rem, env(safe-area-inset-top))",
  borderBottom: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  background: "color-mix(in srgb, CanvasText 2%, Canvas)",
  gap: "0.5rem",
} as const;

const topBarTitle = {
  fontSize: "0.95rem",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  flex: 1,
  minWidth: 0,
};

const backButtonStyle = {
  background: "transparent",
  border: "none",
  font: "inherit",
  fontSize: "1.25rem",
  color: "CanvasText",
  padding: "0.5rem 0.6rem",
  cursor: "pointer",
  minHeight: 44,
  minWidth: 44,
} as const;

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
    padding: "0.45rem 0.9rem",
    font: "inherit",
    fontSize: "0.85rem",
    cursor: "pointer",
    minHeight: 36,
  }) as const;

const empty = {
  display: "grid",
  placeItems: "center",
  width: "100%",
  color: "color-mix(in srgb, CanvasText 50%, Canvas)",
} as const;
