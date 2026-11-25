import type { BlockchainEvent } from '../types/event';
import { hydrateNotificationStatus } from './eventsApi';

export interface EventStreamHandlers {
  onEvent: (event: BlockchainEvent) => void;
  /** Called once when the stream never opens, so the caller can poll instead. */
  onFallback: () => void;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onopen: ((this: EventSourceLike, ev: Event) => void) | null;
  onerror: ((this: EventSourceLike, ev: Event) => void) | null;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;

/**
 * Subscribe to `GET /api/events/stream`.
 *
 * The browser EventSource reconnects on its own and resends `Last-Event-ID`.
 * If the first attempt fails (stream disabled or listener down), `onFallback`
 * runs once and the socket is closed so polling can take over.
 */
export function openEventStream(
  streamUrl: string,
  handlers: EventStreamHandlers,
  EventSourceImpl?: EventSourceConstructor,
): () => void {
  const Ctor = EventSourceImpl ?? (globalThis.EventSource as EventSourceConstructor | undefined);
  if (!Ctor) {
    handlers.onFallback();
    return () => undefined;
  }

  let opened = false;
  let closed = false;
  const source = new Ctor(streamUrl);

  source.onopen = () => {
    opened = true;
  };

  source.onerror = () => {
    if (opened || closed) return;
    closed = true;
    source.close();
    handlers.onFallback();
  };

  source.addEventListener('notification', (message) => {
    if (closed) return;
    try {
      const parsed = JSON.parse(message.data) as BlockchainEvent;
      const [event] = hydrateNotificationStatus([parsed]);
      if (event) handlers.onEvent(event);
    } catch {
      // Ignore a malformed record and keep the stream open.
    }
  });

  return () => {
    closed = true;
    source.close();
  };
}

/** Map a `GET /api/events` URL onto the SSE endpoint. */
export function toEventStreamUrl(eventsApiUrl: string): string | null {
  if (!/\/api\/events\/?$/.test(eventsApiUrl.split('?')[0] ?? '')) return null;
  return eventsApiUrl.replace(/\/api\/events\/?(\?.*)?$/, '/api/events/stream$1');
}
