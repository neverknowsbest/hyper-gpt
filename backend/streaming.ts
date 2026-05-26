import type { StreamEvent } from "../shared/types";

// In-process pub/sub for streaming messages. SQLite is the durable source of
// truth (chunks are persisted as they arrive); this hub is the live-update
// path for clients that are subscribed at stream time.
//
// If a client subscribes after the stream completes and the entry has already
// been evicted, they fall back to reading the completed message from SQLite.

interface StreamEntry {
  events: StreamEvent[];
  subscribers: Set<(event: StreamEvent) => void>;
  done: boolean;
}

const CLEANUP_DELAY_MS = 30_000;

class StreamHub {
  private streams = new Map<string, StreamEntry>();

  start(messageId: string): void {
    this.streams.set(messageId, {
      events: [],
      subscribers: new Set(),
      done: false,
    });
  }

  push(messageId: string, event: StreamEvent): void {
    const entry = this.streams.get(messageId);
    if (!entry) return;
    entry.events.push(event);
    for (const sub of entry.subscribers) sub(event);

    if (event.type === "message_complete" || event.type === "error") {
      entry.done = true;
      setTimeout(() => this.streams.delete(messageId), CLEANUP_DELAY_MS);
    }
  }

  // Returns the current state of the stream (if known) and registers a
  // subscriber for future events. Caller is responsible for replaying events
  // already in `existing` and then handling new ones via `onEvent`.
  subscribe(
    messageId: string,
    onEvent: (event: StreamEvent) => void,
  ): { existing: StreamEvent[]; done: boolean; unsubscribe: () => void } {
    const entry = this.streams.get(messageId);
    if (!entry) return { existing: [], done: true, unsubscribe: () => {} };

    entry.subscribers.add(onEvent);
    return {
      existing: [...entry.events],
      done: entry.done,
      unsubscribe: () => entry.subscribers.delete(onEvent),
    };
  }
}

export const streamHub = new StreamHub();
