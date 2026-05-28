import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createCanvas,
  getMe,
  getPreferences,
  listCanvases,
} from "./lib/api";
import {
  MOBILE_BREAKPOINT,
  submitOnEnter,
  useIsDesktopPointer,
  useMediaQuery,
} from "./lib/useMediaQuery";
import { ChatView } from "./views/ChatView";
import { MapView } from "./views/MapView";
import { SettingsView } from "./views/SettingsView";
import type { Canvas, UserPreferences } from "../../shared/types";
import {
  buttonStyle,
  errBox,
  muted,
  sectionTitle,
  textareaStyle,
} from "./styles";

type ViewMode = "chat" | "map";

export function App() {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);

  const [userId, setUserId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(({ userId }) => setUserId(userId))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!userId) return;
    listCanvases(userId).then(setCanvases).catch((e) => setError(String(e)));
    getPreferences(userId).then(setPrefs).catch((e) => setError(String(e)));
  }, [userId]);

  const refreshCanvases = useCallback(async () => {
    if (!userId) return;
    setCanvases(await listCanvases(userId));
  }, [userId]);

  const openCanvas = useCallback((canvas: Canvas) => {
    setActiveCanvasId(canvas.id);
    setActiveNodeId(canvas.seedNodeId);
    setView("chat");
    setSettingsOpen(false);
  }, []);

  const goBackToCanvasesList = useCallback(() => {
    setActiveCanvasId(null);
    setActiveNodeId(null);
    setSettingsOpen(false);
  }, []);

  const openSettings = useCallback(() => {
    setActiveCanvasId(null);
    setActiveNodeId(null);
    setSettingsOpen(true);
  }, []);

  const activeCanvas = useMemo(
    () => canvases.find((c) => c.id === activeCanvasId) ?? null,
    [canvases, activeCanvasId],
  );

  const renderCanvasContent = () => {
    if (!userId || !activeCanvas) return null;
    return (
      <>
        <CanvasTopBar
          canvasTitle={activeCanvas.title}
          view={view}
          onSetView={setView}
          onBack={goBackToCanvasesList}
          showBack={isMobile}
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
            onLeaveCanvas={isMobile ? goBackToCanvasesList : undefined}
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
    );
  };

  const renderSettings = () =>
    userId ? (
      <>
        {isMobile && (
          <SimpleTopBar title="Settings" onBack={goBackToCanvasesList} />
        )}
        <SettingsView userId={userId} onPreferencesChange={setPrefs} />
      </>
    ) : null;

  // ---- mobile: one screen at a time ----
  if (isMobile) {
    return (
      <div style={mobileShell}>
        <InstallHint />
        {settingsOpen && renderSettings()}
        {!settingsOpen && !activeCanvas && userId && (
          <CanvasesPanel
            userId={userId}
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            error={error}
            prefs={prefs}
            onCreate={async (canvas) => {
              await refreshCanvases();
              openCanvas(canvas);
            }}
            onOpen={openCanvas}
            onOpenSettings={openSettings}
          />
        )}
        {!settingsOpen && activeCanvas && renderCanvasContent()}
      </div>
    );
  }

  // ---- desktop: sidebar + main pane ----
  return (
    <div style={desktopShell}>
      <InstallHint />
      <aside style={sidebar}>
        {userId && (
          <CanvasesPanel
            userId={userId}
            canvases={canvases}
            activeCanvasId={activeCanvasId}
            error={error}
            prefs={prefs}
            onCreate={async (canvas) => {
              await refreshCanvases();
              openCanvas(canvas);
            }}
            onOpen={openCanvas}
            onOpenSettings={openSettings}
            embedded
          />
        )}
      </aside>

      <main style={chatPane}>
        {settingsOpen && renderSettings()}
        {!settingsOpen && activeCanvas && renderCanvasContent()}
        {!settingsOpen && !activeCanvas && (
          <div style={empty}>
            <p>Create a canvas to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function SimpleTopBar({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <div style={topBarStyle}>
      <button onClick={onBack} style={backButtonStyle} aria-label="Back">
        ←
      </button>
      <div style={topBarTitle}>{title}</div>
    </div>
  );
}

const A2HS_DISMISSED_KEY = "hypergpt:a2hs-dismissed";

// One-time hint shown on iOS Safari (the only iOS browser that can install a
// PWA) when not already running standalone. iOS exposes no programmatic
// install prompt, so we instruct the manual Share → Add to Home Screen flow.
function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    const isIOS =
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const standalone =
      ("standalone" in navigator &&
        (navigator as unknown as { standalone?: boolean }).standalone) ||
      window.matchMedia("(display-mode: standalone)").matches;
    const dismissed = localStorage.getItem(A2HS_DISMISSED_KEY) === "1";
    setShow(Boolean(isIOS && !standalone && !dismissed));
  }, []);

  if (!show) return null;

  return (
    <div style={installBanner}>
      <span style={{ flex: 1 }}>
        Install HyperGPT: tap <strong>Share</strong> →{" "}
        <strong>Add to Home Screen</strong>
      </span>
      <button
        onClick={() => {
          localStorage.setItem(A2HS_DISMISSED_KEY, "1");
          setShow(false);
        }}
        aria-label="Dismiss"
        style={installDismiss}
      >
        ×
      </button>
    </div>
  );
}

function CanvasesPanel({
  userId,
  canvases,
  activeCanvasId,
  error,
  prefs,
  onCreate,
  onOpen,
  onOpenSettings,
  embedded = false,
}: {
  userId: string;
  canvases: Canvas[];
  activeCanvasId: string | null;
  error: string | null;
  prefs: UserPreferences | null;
  onCreate: (canvas: Canvas) => Promise<void> | void;
  onOpen: (canvas: Canvas) => void;
  onOpenSettings: () => void;
  embedded?: boolean;
}) {
  return (
    <div style={embedded ? embeddedPanel : fullScreenPanel}>
      <div style={brandRow}>
        <h1 style={brand}>HyperGPT</h1>
        <button
          type="button"
          onClick={onOpenSettings}
          style={brandSettingsButton}
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
      </div>
      {error && <div style={errBox}>{error}</div>}
      <NewCanvasForm userId={userId} prefs={prefs} onCreate={onCreate} />
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
  prefs,
  onCreate,
}: {
  userId: string;
  prefs: UserPreferences | null;
  onCreate: (canvas: Canvas) => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isDesktop = useIsDesktopPointer();
  const onKeyDown = submitOnEnter(isDesktop);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy || !prefs) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await createCanvas(userId, {
        defaultProvider: prefs.defaultProvider,
        defaultModel: prefs.defaultModel,
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

const brandRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
} as const;

const brand = { margin: 0, fontSize: "1.25rem" } as const;

const brandSettingsButton = {
  background: "transparent",
  border: "none",
  font: "inherit",
  fontSize: "1.2rem",
  color: "color-mix(in srgb, CanvasText 65%, Canvas)",
  cursor: "pointer",
  padding: "0.4rem 0.5rem",
  borderRadius: 6,
  minHeight: 36,
  minWidth: 36,
} as const;

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

const installBanner = {
  position: "fixed" as const,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.75rem 1rem max(0.75rem, env(safe-area-inset-bottom))",
  background: "color-mix(in srgb, dodgerblue 22%, Canvas)",
  borderTop: "1px solid color-mix(in srgb, CanvasText 15%, Canvas)",
  fontSize: "0.9rem",
  color: "CanvasText",
};

const installDismiss = {
  background: "transparent",
  border: "none",
  font: "inherit",
  fontSize: "1.4rem",
  lineHeight: 1,
  color: "CanvasText",
  cursor: "pointer",
  padding: "0 0.4rem",
  minHeight: 44,
  minWidth: 44,
} as const;
