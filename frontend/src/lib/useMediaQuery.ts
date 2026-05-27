import type React from "react";
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export const MOBILE_BREAKPOINT = "(max-width: 768px)";

// True when the primary pointer is a mouse (desktop), false on touch.
// Used to wire Enter-to-submit on textareas only where it won't fight the
// soft keyboard's expected newline behavior.
export function useIsDesktopPointer(): boolean {
  return !useMediaQuery("(pointer: coarse)");
}

export function submitOnEnter(
  isDesktop: boolean,
): (e: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  return (e) => {
    if (!isDesktop) return;
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const form = (e.currentTarget as HTMLTextAreaElement).form;
      form?.requestSubmit();
    }
  };
}
