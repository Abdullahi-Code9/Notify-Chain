import http from 'http';
import { DisplayEvent } from '../types/display-event';
import { EventRegistry } from '../store/event-registry';

/**
 * Optional live event feed (Server-Sent Events).
 *
 * Enable with `EVENT_STREAM_ENABLED=true`. The endpoint is
 * `GET /api/events/stream`. While it is disabled the path responds 404 and
 * dashboards keep polling `GET /api/events`.
 *
 * Each newly stored registry event is one SSE record:
 *
 * ```
 * id: <contractAddress>:<eventId>
 * event: notification
 * data: <DisplayEvent JSON>
 *
 * ```
 *
 * `id` is the registry key. Browsers resend it as the `Last-Event-ID` request
 * header after a disconnect. The server replays registry events that arrived
 * after that id, then continues with live events. A connection with no
 * `Last-Event-ID` receives only events stored after it connects (clients load
 * history from `GET /api/events`). An unknown id, for example after eviction,
 * replays the current registry so the client can catch up.
 *
 * A `: keepalive` comment is written on a fixed interval so idle proxies do
 * not close the socket. When the request or response closes, the subscriber
 * is removed and the keepalive timer is cleared.
 */
export const EVENT_STREAM_PATH = '/api/events/stream';

export interface EventStreamOptions {
  /** Milliseconds between `: keepalive` comments. Default 15000. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function eventStreamId(event: DisplayEvent): string {
  return `${event.contractAddress}:${event.eventId}`;
}

export function formatSseEvent(event: DisplayEvent): string {
  return `id: ${eventStreamId(event)}\nevent: notification\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Attach one SSE client to `registry`. Returns a function that drops the
 * client; the HTTP close path calls it automatically.
 */
export function handleEventStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: EventRegistry,
  options: EventStreamOptions = {},
): () => void {
  const heartbeatMs =
    options.heartbeatMs && options.heartbeatMs > 0 ? options.heartbeatMs : DEFAULT_HEARTBEAT_MS;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.statusCode = 200;

  const sent = new Set<string>();
  let closed = false;

  const writeEvent = (event: DisplayEvent): void => {
    if (closed) return;
    const id = eventStreamId(event);
    if (sent.has(id)) return;
    sent.add(id);
    res.write(formatSseEvent(event));
  };

  const unsubscribe = registry.subscribe(writeEvent);

  const lastEventId = headerValue(req.headers['last-event-id']);
  for (const event of eventsAfter(registry, lastEventId)) {
    writeEvent(event);
  }

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  return cleanup;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value && value.length > 0 ? value : undefined;
}

function eventsAfter(registry: EventRegistry, lastEventId: string | undefined): DisplayEvent[] {
  if (!lastEventId) return [];
  const events = registry.getEvents();
  const index = events.findIndex((event) => eventStreamId(event) === lastEventId);
  if (index === -1) return events;
  return events.slice(index + 1);
}
