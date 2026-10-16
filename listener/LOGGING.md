# Logging Guidelines

The listener uses [Winston](https://github.com/winstonjs/winston) for structured JSON logging. Every log entry follows a consistent schema to make logs machine-readable and easy to trace through the notification pipeline.

## Log Format

Each entry contains these standard fields:

| Field        | Type    | Description                                                    |
|--------------|---------|----------------------------------------------------------------|
| `timestamp`  | string  | ISO 8601 timestamp (added automatically)                       |
| `level`      | string  | Severity: `error`, `warn`, `info`, `debug`                     |
| `message`    | string  | Human-readable description of the event                        |
| `requestId`  | string  | Short UUID prefix scoped to a single poll cycle or API request |
| `correlationId` | string | UUID used to trace a single request across services (see below) |
| `durationMs` | number  | Elapsed milliseconds for timed operations                      |

Additional context fields (e.g. `contractAddress`, `eventId`) are appended as needed.

## Request IDs

A `requestId` is generated at the start of every poll cycle and every HTTP request. It is threaded through all log calls within that unit of work so you can trace a single notification from receipt to delivery.

## Correlation-ID middleware

Every HTTP request handled by the events API server (`listener/src/api/events-server.ts`) is passed through `applyRequestContext()` (`listener/src/utils/request-id.ts`) before any routing happens. It:

1. Mints a fresh `requestId` for the request (this is never reused across requests, unlike a correlation ID, which callers may deliberately pass through several hops).
2. Resolves a `correlationId` — reusing the caller's `X-Correlation-Id` request header when present, otherwise generating a new UUID. This lets a request be traced across services when the caller (a gateway, another internal service, or a retried client call) forwards its own correlation ID.
3. Echoes both back as `X-Request-Id` and `X-Correlation-Id` response headers.

```typescript
import { applyRequestContext } from '../utils/request-id';

const server = http.createServer(async (req, res) => {
  const { requestId, correlationId } = applyRequestContext(req, res);
  // ...pass requestId/correlationId into every logger call for this request
});
```

Every log call made while handling a request should include both `requestId` and `correlationId`.

```
2026-06-17T12:00:00.000Z info: Poll cycle complete {"requestId":"a1b2c3d4","durationMs":42}
2026-06-17T12:00:00.001Z info: Received events {"requestId":"a1b2c3d4","contractAddress":"CA...","count":2,"processed":2}
2026-06-17T12:00:00.002Z info: Processing event {"requestId":"a1b2c3d4","eventId":"event-1","eventName":"TaskCreated",...}
2026-06-17T12:00:00.005Z info: Sending Discord notification {"requestId":"a1b2c3d4","eventId":"event-1",...}
2026-06-17T12:00:00.120Z info: Discord notification delivered {"requestId":"a1b2c3d4","eventId":"event-1","durationMs":115}
2026-06-17T12:00:00.121Z info: Event processing complete {"requestId":"a1b2c3d4","eventId":"event-1","durationMs":119}
```

## Delivery Lifecycle Events

The following messages mark each stage of the notification pipeline:

| Stage                  | Level   | Message                                               |
|------------------------|---------|-------------------------------------------------------|
| Poll cycle start       | `info`  | `Poll cycle complete` (logged at end with duration)   |
| Events received        | `info`  | `Received events`                                     |
| Invalid payload        | `warn`  | `Skipping invalid event payload`                      |
| Event accepted         | `info`  | `Processing event`                                    |
| Discord send start     | `info`  | `Sending Discord notification`                        |
| Discord delivered      | `info`  | `Discord notification delivered`                      |
| Discord failed         | `error` | `Discord webhook failed`                              |
| Event done             | `info`  | `Event processing complete`                           |
| API request received   | `info`  | `Handling GET /api/events`                            |
| API request done       | `info`  | `GET /api/events complete`                            |
| Reconnect attempt      | `warn`  | `Attempting to reconnect`                             |
| Max retries exceeded   | `error` | `Max reconnection attempts exceeded, stopping service`|
| Scheduler batch start  | `info`  | `Processing batch of scheduled notifications`         |
| Scheduler batch done   | `info`  | `Scheduler batch complete`                            |
| Scheduled notification | `info`  | `Processing scheduled notification`                   |
| Registry at capacity   | `warn`  | `Event registry at capacity, evicting oldest events`  |

## Event registry retention

The in-memory event registry is a bounded display cache, not the source of
record for processed events. It retains at most `maxEvents` entries (10,000 by
default) and removes entries older than its TTL (24 hours by default) when the
cleanup interval runs. Insertion order determines eviction when the capacity
is reached.

An event is keyed by contract address and event ID. Re-adding an event already
in the retention window returns the existing entry without increasing memory
usage. Events evicted by capacity or TTL are still protected from replay by
the persistent `processed_events` deduplication table used by the subscriber.

## Error Formatting

Errors passed in the `error` metadata field are automatically normalized into a structured object with `message`, `name`, `stack`, and optional `cause` fields. Use the exported `formatError()` helper when formatting errors outside the logger.

```typescript
import logger, { formatError } from '../utils/logger';

try {
  await deliverNotification();
} catch (error) {
  logger.error('Delivery failed', { requestId, error });
}
```

## Configuration

Set the `LOG_LEVEL` environment variable to control verbosity:

```
LOG_LEVEL=debug   # verbose, includes all messages
LOG_LEVEL=info    # default
LOG_LEVEL=warn    # warnings and errors only
LOG_LEVEL=error   # errors only
```

In development (`NODE_ENV` not set to `production`), logs use a colorized single-line format. In production they output newline-delimited JSON, suitable for ingestion by log aggregators such as Datadog, CloudWatch, or Loki.

## Adding New Log Calls

- Always pass `requestId` if one is available in the current scope.
- Use `durationMs` for any operation that involves I/O (RPC calls, webhook delivery, DB writes).
- Prefer structured metadata over embedding values in the message string.

```typescript
// good
logger.info('Processing event', { requestId, eventId, eventName, durationMs });

// avoid
logger.info(`Processing event ${eventId} (${eventName}) took ${durationMs}ms`);
```
