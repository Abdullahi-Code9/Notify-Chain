# Explicit Timezones in Scheduling Requests

Clients may include a `timezone` field when scheduling notifications (`POST /api/schedule`).

## Accepted formats

- **IANA time zone identifiers** — e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`
- **`UTC` / `GMT`** aliases

Invalid identifiers are rejected with HTTP 400 and code `INVALID_TIMEZONE`.

## Storage and display

- `executeAt` is always **stored in UTC** (ISO-8601 with `Z`).
- When `timezone` is provided with a **naive** local datetime (no `Z`/offset), that wall-clock time is interpreted in the given zone and converted to UTC before storage.
- Offset-aware / `Z` timestamps are stored as UTC; `timezone` is retained for local-time display.
- Responses may include `timezone` and `executeAtLocal` (wall time in the requested zone).

## Example

```json
{
  "executeAt": "2026-01-15T12:00:00",
  "timezone": "America/New_York",
  "payload": { "message": "hello" },
  "targetRecipient": "https://example.com/hook"
}
```

Stored `executeAt`: `2026-01-15T17:00:00.000Z`  
Display (`executeAtLocal`): `2026-01-15T12:00:00`
