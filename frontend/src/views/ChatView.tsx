import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getNode,
  messageText,
  sendMessage,
  spawn,
  subscribeToMessage,
} from "../lib/api";
import { submitOnEnter, useIsDesktopPointer } from "../lib/useMediaQuery";
import type { Edge, Message, StreamEvent } from "../../../shared/types";
import {
  buttonStyle,
  errBox,
  ghostButtonStyle,
  muted,
  sectionTitle,
  textareaStyle,
} from "../styles";

interface SelectionTarget {
  messageId: string;
  start: number;
  end: number;
  text: string;
}

// ---- per-node scroll position memory ----
//
// Module-level so it survives the unmount/remount that happens when the user
// navigates between nodes (App.tsx keys ChatView by activeNodeId).
const savedScrollTops = new Map<string, number>();

// ---- swipe-right-to-parent constants ----
// No edge-start restriction: iOS Safari intercepts left-edge swipes for its
// own browser-back gesture, so our handler never sees them in a Safari tab.
// (In an installed PWA, the iOS gesture is gone and our handler works
// regardless of start position.)
const SWIPE_COMMIT_DX = 90; // travel to commit a navigate on release
const SWIPE_DX_OVER_DY_RATIO = 1.5; // horizontal must dominate vertical
const SWIPE_FOLLOW_CAP = 160; // max visual pull before resistance

// ---- citation highlights via the CSS Custom Highlight API ----
//
// The message text contains zero wrapper elements for citations — iOS Safari
// disables text selection across any styled child element, so we paint the
// highlights as a separate rendering layer via CSS.highlights.

const CITATION_HIGHLIGHT_NAME = "citation";

function getCitationHighlight(): Highlight | null {
  if (typeof window === "undefined") return null;
  if (typeof Highlight === "undefined" || !CSS?.highlights) return null;
  let h = CSS.highlights.get(CITATION_HIGHLIGHT_NAME);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(CITATION_HIGHLIGHT_NAME, h);
  }
  return h;
}

// Walk the text nodes inside `container` and build a Range spanning the
// given character offsets within the container's text content.
function rangeForOffsets(
  container: Element,
  start: number,
  end: number,
): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.length;
    if (startNode === null && start < consumed + len) {
      startNode = node;
      startOffset = start - consumed;
    }
    if (endNode === null && end <= consumed + len) {
      endNode = node;
      endOffset = end - consumed;
      break;
    }
    consumed += len;
    node = walker.nextNode() as Text | null;
  }

  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

// Find the character offset within `container` corresponding to the
// document coordinates (clientX, clientY). Returns -1 if outside.
function offsetFromPoint(
  container: Element,
  clientX: number,
  clientY: number,
): number {
  let caretNode: Node | null = null;
  let caretOffset = 0;

  // Webkit (Safari) exposes caretRangeFromPoint; Firefox/spec exposes
  // caretPositionFromPoint. Use whichever is available.
  if (typeof document.caretRangeFromPoint === "function") {
    const r: Range | null = document.caretRangeFromPoint(clientX, clientY);
    if (!r) return -1;
    caretNode = r.startContainer;
    caretOffset = r.startOffset;
  } else if (typeof document.caretPositionFromPoint === "function") {
    const p = document.caretPositionFromPoint(clientX, clientY);
    if (!p) return -1;
    caretNode = p.offsetNode;
    caretOffset = p.offset;
  } else {
    return -1;
  }

  if (!container.contains(caretNode)) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(caretNode, caretOffset);
  return pre.toString().length;
}

export function ChatView({
  userId,
  nodeId,
  onNavigate,
  onLeaveCanvas,
}: {
  userId: string;
  nodeId: string;
  onNavigate: (nodeId: string) => void;
  // Called when the user swipes right on a node that has no parent (the
  // canvas seed). Lets the seed node's swipe-right take them out of the
  // canvas entirely instead of doing nothing.
  onLeaveCanvas?: () => void;
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

  const isDesktop = useIsDesktopPointer();
  const onComposerKeyDown = submitOnEnter(isDesktop);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user was at (or near) the bottom before the last render,
  // so we only auto-scroll when they haven't deliberately scrolled up.
  const wasNearBottomRef = useRef(true);
  // Whether we've already applied initial-scroll behavior (restore-from-saved
  // OR scroll-to-bottom) for this node. Reset per ChatView instance.
  const initialScrollAppliedRef = useRef(false);
  // Touch-swipe tracking for back-to-parent gesture.
  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(
    null,
  );
  // Track whether the current swipe has committed visual tracking (so we
  // can decide whether to animate back on release).
  const swipeActiveRef = useRef(false);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

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

  // Read the current selection and return a SelectionTarget if it lives
  // wholly within a single assistant message, otherwise null.
  const readSelection = useCallback((): SelectionTarget | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element =
      container.nodeType === 1 ? (container as Element) : container.parentElement;
    const messageEl = element?.closest("[data-message-id]") as HTMLElement | null;
    if (!messageEl) return null;
    const messageId = messageEl.dataset.messageId;
    if (!messageId) return null;
    const endEl =
      range.endContainer.nodeType === 1
        ? (range.endContainer as Element)
        : range.endContainer.parentElement;
    if (endEl?.closest("[data-message-id]") !== messageEl) return null;
    const preRange = document.createRange();
    preRange.selectNodeContents(messageEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const text = range.toString();
    if (!text.trim()) return null;
    const end = start + text.length;
    return { messageId, start, end, text };
  }, []);

  // Selection trigger:
  // - Desktop: selectionchange.
  // - Mobile: pointerup at end of gesture, then defer one tick so iOS has
  //   committed (or cleared) the selection before we read it. We skip
  //   pointerup events that originate inside the chip so tapping it doesn't
  //   re-read a now-cleared selection.
  useEffect(() => {
    if (isDesktop) {
      const onChange = () => setSelection(readSelection());
      document.addEventListener("selectionchange", onChange);
      return () => document.removeEventListener("selectionchange", onChange);
    }

    const onPointerUp = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("[data-spawn-chip]")) return;
      setTimeout(() => setSelection(readSelection()), 0);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, [isDesktop, readSelection]);

  // Track whether the user is near the bottom (so auto-scroll doesn't yank
  // them) AND continuously save the current scroll position for this node so
  // we can restore it when they return. Save-on-scroll (rather than save-on-
  // unmount) survives React Strict Mode's mount → cleanup → remount dance,
  // which would otherwise overwrite saved positions with a stale 0.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const onScroll = () => {
      wasNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      savedScrollTops.set(nodeId, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [nodeId]);

  // Scroll handling: on the first message-content render for this node,
  // either restore a previously-saved scroll position (if we're returning
  // from a tangent) or scroll to bottom. After that, normal auto-scroll
  // behavior on new content as long as the user is near the bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || messages.length === 0) return;

    if (!initialScrollAppliedRef.current) {
      initialScrollAppliedRef.current = true;
      const saved = savedScrollTops.get(nodeId);
      if (saved !== undefined) {
        el.scrollTop = saved;
        wasNearBottomRef.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        return;
      }
    }

    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, nodeId]);

  // iOS keyboard handling: when the visible viewport changes (keyboard slides
  // in or out), re-anchor the transcript bottom so the latest message stays
  // visible above the keyboard.
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const onResize = () => {
      if (!wasNearBottomRef.current) return;
      const el = transcriptRef.current;
      if (!el) return;
      // Defer to next frame so layout has settled.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

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

  // Swipe-right to navigate to the parent node, when one exists.
  // During the gesture, the chat content follows the finger (translateX)
  // so the user can see it's a directional gesture and not a tap. On
  // release, if horizontal travel exceeds the commit threshold and was
  // dominantly horizontal, we navigate; otherwise the content springs
  // back to position.
  //
  // Touches starting inside the composer / a button / the chip are
  // ignored so we don't fight typing or chip taps.
  const resetSwipeTransform = (animated: boolean) => {
    const el = chatContainerRef.current;
    if (!el) return;
    if (animated) {
      el.style.transition = "transform 0.24s ease-out";
      el.style.transform = "translateX(0)";
      // Clear the transition after it finishes so future swipes aren't
      // smoothed by a stale transition rule.
      window.setTimeout(() => {
        if (chatContainerRef.current) {
          chatContainerRef.current.style.transition = "";
        }
      }, 260);
    } else {
      el.style.transition = "";
      el.style.transform = "";
    }
    swipeActiveRef.current = false;
  };

  // Whether a swipe-right has somewhere to go from this node — parent if
  // we have one, otherwise back to the canvases list.
  const canSwipeBack = !!inboundEdge || !!onLeaveCanvas;

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!canSwipeBack) return;
    if (e.touches.length !== 1) return;
    // Skip while there's an active selection — the user is likely dragging
    // an iOS selection handle to extend it, not trying to navigate.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
    const target = e.target as Element | null;
    if (target?.closest("textarea, input, button, [data-spawn-chip]")) return;
    const t = e.touches[0];
    swipeStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    swipeActiveRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = Math.abs(t.clientY - start.y);
    const el = chatContainerRef.current;
    if (!el) return;
    // Only start following the finger once the gesture is clearly a
    // rightward swipe (not a vertical scroll or accidental horizontal jitter).
    if (dx <= 8 || dx < dy) {
      if (swipeActiveRef.current) resetSwipeTransform(false);
      return;
    }
    swipeActiveRef.current = true;
    // Light resistance: once past the cap, additional travel only nudges
    // a little, suggesting "you've gone far enough."
    const pull =
      dx <= SWIPE_FOLLOW_CAP
        ? dx
        : SWIPE_FOLLOW_CAP + (dx - SWIPE_FOLLOW_CAP) * 0.25;
    el.style.transition = "";
    el.style.transform = `translateX(${pull}px)`;
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    const wasActive = swipeActiveRef.current;
    swipeStartRef.current = null;
    if (!start || !canSwipeBack) {
      if (wasActive) resetSwipeTransform(true);
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = Math.abs(t.clientY - start.y);
    const committed =
      dx >= SWIPE_COMMIT_DX && dx > dy * SWIPE_DX_OVER_DY_RATIO;
    if (committed) {
      // ChatView will unmount as we navigate away, so no need to animate
      // back; let the next view's mount handle the transition.
      if (inboundEdge) {
        onNavigate(inboundEdge.sourceNodeId);
      } else if (onLeaveCanvas) {
        onLeaveCanvas();
      }
    } else if (wasActive) {
      resetSwipeTransform(true);
    }
  };

  const handleTouchCancel = () => {
    swipeStartRef.current = null;
    if (swipeActiveRef.current) resetSwipeTransform(true);
  };

  return (
    <div
      ref={chatContainerRef}
      style={chatContainer}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      {inboundEdge && (
        <ParentHeader
          edge={inboundEdge}
          parentTitle={parentTitle}
          onTap={() => onNavigate(inboundEdge.sourceNodeId)}
        />
      )}
      <div ref={transcriptRef} style={transcript}>
        {loading && <div style={muted}>Loading…</div>}
        {messages.map((m) => {
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

      {spawnDraft && (
        <SpawnModal
          citation={spawnDraft.text}
          onCancel={() => setSpawnDraft(null)}
          onSubmit={handleSpawnSubmit}
        />
      )}

      <div style={composerStack}>
        {/* Always-mounted so showing/hiding never mutates the DOM tree —
            iOS Safari cancels active selections on any tree mutation. */}
        <SpawnChip selection={selection} onSpawn={openSpawnDraft} />
        <form onSubmit={submit} style={composer}>
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKeyDown}
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
      <div style={parentHeaderLabel}>↑ {parentTitle ?? "parent"}</div>
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
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Paint citation highlights via CSS.highlights — no wrapper elements in
  // the DOM, so iOS Safari leaves the text fully selectable.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (outboundEdges.length === 0) return;
    const highlight = getCitationHighlight();
    if (!highlight) return; // unsupported browser; highlights silently absent

    const added: Range[] = [];
    for (const edge of outboundEdges) {
      const range = rangeForOffsets(el, edge.citationStart, edge.citationEnd);
      if (range) {
        highlight.add(range);
        added.push(range);
      }
    }
    return () => {
      for (const r of added) highlight.delete(r);
    };
  }, [outboundEdges, text]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (outboundEdges.length === 0) return;
    const el = contentRef.current;
    if (!el) return;
    const offset = offsetFromPoint(el, e.clientX, e.clientY);
    if (offset < 0) return;
    for (const edge of outboundEdges) {
      if (offset >= edge.citationStart && offset < edge.citationEnd) {
        onJumpToChild(edge.targetNodeId);
        return;
      }
    }
  };

  const visibleText = text || (message.status === "streaming" ? "…" : "");

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
      <div
        ref={contentRef}
        data-message-id={message.id}
        onClick={handleClick}
        style={{ whiteSpace: "pre-wrap" }}
      >
        {visibleText}
        {message.status === "streaming" && <span style={cursorStyle}> ▋</span>}
        {message.status === "errored" && (
          <span style={{ color: "crimson", userSelect: "none" }}>
            {" ⚠ errored"}
          </span>
        )}
      </div>
    </div>
  );
}

function SpawnChip({
  selection,
  onSpawn,
}: {
  selection: SelectionTarget | null;
  onSpawn: () => void;
}) {
  const visible = selection !== null;
  const preview = selection
    ? selection.text.length > 80
      ? selection.text.slice(0, 80).trimEnd() + "…"
      : selection.text
    : // Non-empty placeholder so the text node persists when there's no
      // selection — keeps React from inserting/removing nodes on toggle.
      " ";

  return (
    <div
      data-spawn-chip=""
      aria-hidden={!visible}
      style={{
        ...spawnChip,
        transform: visible ? "translateY(0)" : "translateY(110%)",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div style={spawnChipPreview}>{visible ? `“${preview}”` : " "}</div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSpawn}
        disabled={!visible}
        style={spawnChipButton}
      >
        ↳ Spin off
      </button>
    </div>
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
  const isDesktop = useIsDesktopPointer();
  const onKeyDown = submitOnEnter(isDesktop);

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
          onKeyDown={onKeyDown}
          placeholder={
            isDesktop
              ? "Optional follow-up — Enter to submit, Shift+Enter for newline"
              : "Optional follow-up — leave blank to just elaborate on the selection"
          }
          style={textareaStyle}
        />
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={ghostButtonStyle}>
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

const chatContainer = {
  display: "grid",
  gridTemplateRows: "auto 1fr auto",
  width: "100%",
  minHeight: 0,
  height: "100%",
  position: "relative",
} as const;

const transcript = {
  overflowY: "auto",
  padding: "1rem 1rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minHeight: 0,
} as const;

const bubble = {
  padding: "0.75rem 1rem",
  borderRadius: 12,
  maxWidth: "min(60ch, 88%)",
  lineHeight: 1.5,
} as const;

const role = {
  fontSize: "0.7rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "color-mix(in srgb, CanvasText 55%, Canvas)",
  marginBottom: "0.25rem",
};

const cursorStyle = { opacity: 0.6, userSelect: "none" } as const;

const composerStack = {
  display: "flex",
  flexDirection: "column",
  background: "Canvas",
  position: "relative",
} as const;

const composer = {
  borderTop: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  padding: "0.75rem 0.75rem max(0.75rem, env(safe-area-inset-bottom))",
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: "0.5rem",
  alignItems: "end",
  background: "Canvas",
} as const;

const spawnChip = {
  // Always mounted (never conditionally rendered) so iOS Safari doesn't see
  // a DOM tree mutation when the chip is shown. Position is absolute so
  // toggling visibility doesn't take/release layout space, and the
  // transform+opacity transition is a pure paint change.
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "100%",
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.55rem 0.75rem",
  borderTop: "1px solid color-mix(in srgb, CanvasText 12%, Canvas)",
  background: "color-mix(in srgb, dodgerblue 10%, Canvas)",
  boxShadow: "0 -2px 8px rgba(0,0,0,0.1)",
  zIndex: 5,
  transition: "transform 0.18s ease-out, opacity 0.14s ease-out",
} as const;

const spawnChipPreview = {
  flex: 1,
  minWidth: 0,
  fontStyle: "italic" as const,
  fontSize: "0.85rem",
  color: "color-mix(in srgb, CanvasText 80%, Canvas)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

const spawnChipButton = {
  background: "dodgerblue",
  color: "white",
  border: "none",
  borderRadius: 999,
  padding: "0.45rem 0.85rem",
  font: "inherit",
  fontSize: "0.85rem",
  cursor: "pointer",
  minHeight: 36,
  flexShrink: 0,
} as const;

const highlightStyle = {
  // DIAGNOSTIC: stripped to bare minimum. If selection still breaks after
  // a span with just an underline (no background, no padding, no box-like
  // styling), then the element's mere presence is the problem and we have
  // to switch to the CSS Custom Highlight API (no wrapper elements at all).
  textDecoration: "underline dodgerblue 1.5px",
  textUnderlineOffset: "2px",
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
  padding: "1rem",
  zIndex: 100,
};

const modalCard = {
  background: "Canvas",
  borderRadius: 12,
  padding: "1.25rem",
  width: "min(32rem, 92vw)",
  maxHeight: "calc(100dvh - 2rem)",
  overflowY: "auto" as const,
  display: "grid",
  gap: "0.75rem",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
};

const modalQuote = {
  borderLeft: "3px solid dodgerblue",
  paddingLeft: "0.75rem",
  margin: 0,
  color: "color-mix(in srgb, CanvasText 75%, Canvas)",
  fontStyle: "italic" as const,
  maxHeight: "8rem",
  overflowY: "auto",
} as const;
