# NotifyChain Listener — API Usage Cookbook

> **Companion to [`API.md`](API.md).** The reference
> document lists every endpoint, header, and response shape. This cookbook
> shows how to combine those endpoints to ship common workflows. Every
> example is a real `curl` invocation you can paste into a terminal once
> the listener is running on `http://localhost:8787`.

---

## Table of contents

1. [Setup — first 60 seconds](#setup--first-60-seconds)
2. [Workflow 1 — stream live contract events](#workflow-1--stream-live-contract-events)
3. [Workflow 2 — schedule a future notification](#workflow-2--schedule-a-future-notification)
4. [Workflow 3 — accept signed webhooks](#workflow-3--accept-signed-webhooks)
5. [Workflow 4 — manage per-user notification preferences](#workflow-4--manage-per-user-notification-preferences)
6. [Workflow 5 — health-check a deployment](#workflow-5--health-check-a-deployment)
7. [Workflow 6 — diagnose a failing request](#workflow-6--diagnose-a-failing-request)
8. [Workflow 7 — recover from a Discord outage](#workflow-7--recover-from-a-discord-outage)
9. [Troubleshooting matrix](#troubleshooting-matrix)
10. [Field reference (one-page summary)](#field-reference-one-page-summary)

---

## Setup — first 60 seconds

```bash
# 1. Clone the repo
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain/listener

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   STELLAR_RPC_URL=https://soroban-testnet.stellar.org
#   EVENTS_API_PORT=8787
#   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
# Optional:
#   NOTIFICATION_API_KEY=my-shared-secret  (enables X-API-Key checks)

# 4. Build and start
npm run build
npm start
```

Verify the listener is up:

```bash
curl -sS http://localhost:8787/health | jq
```

Expected output:

```json
{
  "status": "ok",
  "timestamp": "2026-06-21T16:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "ok", "latencyMs": 142 },
    "discord": { "status": "ok", "latencyMs": 56 },
    "eventRegistry": { "status": "ok", "eventCount": 0 }
  }
}
```

If `status` is anything other than `ok`, jump to
[Workflow 5 — health-check a deployment](#workflow-5--health-check-a-deployment)
or the [Troubleshooting matrix](#troubleshooting-matrix).

---

## Workflow 1 — stream live contract events

The listener polls the Stellar RPC node for contract events, deduplicates
them, and exposes the resulting stream on `GET /api/events`. The most
common use case is to tail this endpoint to feed a dashboard, a Slack
notifier, or a downstream analytics pipeline.

### Tail the event stream with curl + jq

```bash
# Latest 5 events, pretty-printed
curl -sS 'http://localhost:8787/api/events?limit=5' | jq '.events[] | {eventId, contractAddress, topic, value, ledger}'
```

### Live feed (optional Server-Sent Events)

When the listener is started with `EVENT_STREAM_ENABLED=true`, dashboards can
subscribe instead of polling:

```bash
curl -N http://localhost:8787/api/events/stream
```

Each record uses this format:

```
id: <contractAddress>:<eventId>
event: notification
data: {"eventId":"...","contractAddress":"...","eventName":"...","ledger":1,"type":"contract","topic":[],"value":"...","receivedAt":0}

```

Reconnect by sending the last id in the `Last-Event-ID` header. The server
replays anything newer, then resumes live delivery. A `: keepalive` comment
is sent about every 15 seconds. When the client disconnects, the listener
drops that subscriber. If the flag is off, this path returns 404 and the poll
loop below remains the way to read events.

### Poll on an interval (cron / watch loop)

```bash
# Refresh every 5 seconds; show only events newer than the last seen ID
LAST_ID=0
while true; do
  curl -sS "http://localhost:8787/api/events?limit=20" \
    | jq --argjson last "$LAST_ID" \
        '.events[] | select((.eventId | tonumber) > $last) | {eventId, topic, contractAddress}'
  sleep 5
done
```

### Read a single event by ID

```bash
curl -sS 'http://localhost:8787/api/events?limit=200' \
  | jq '.events[] | select(.eventId == "1234")'
```

### Filter to one contract (client-side)

```bash
CONTRACT="CCEMX6ABCDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
curl -sS 'http://localhost:8787/api/events?limit=100' \
  | jq --arg c "$CONTRACT" '.events[] | select(.contractAddress == $c)'
```

> **Tip:** The listener does not filter server-side by contract address.
> Pull a generous `limit` and filter client-side unless you are willing
> to fork the listener and add a query parameter.

---

## Workflow 2 — schedule a future notification

Use `POST /api/schedule` to queue a one-shot notification that will fire
at a specific wall-clock time. Common use cases: a "bounty expires in
24h" reminder, a "milestone review window opens" ping, or a delayed
Discord announcement tied to a contract event.

### Schedule a Discord reminder for tomorrow

```bash
# ISO 8601 timestamp 24h in the future
WHEN=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%S.000Z)

curl -sS -X POST http://localhost:8787/api/schedule \
  -H 'Content-Type: application/json' \
  -d "{
    \"executeAt\": \"$WHEN\",
    \"payload\": { \"content\": \"Reminder: Task #42 has 24h left to submit.\" },
    \"targetRecipient\": \"$DISCORD_WEBHOOK_URL\",
    \"notificationType\": \"discord\",
    \"maxRetries\": 3,
    \"priority\": 1
  }"
```

Expected response (status `201 Created`):

```json
{ "id": 42 }
```

### Look up the scheduled notification

```bash
curl -sS http://localhost:8787/api/schedule/42 | jq
```

```json
{
  "id": 42,
  "executeAt": "2026-06-22T16:00:00.000Z",
  "payload": { "content": "Reminder: Task #42 has 24h left to submit." },
  "targetRecipient": "https://discord.com/api/webhooks/...",
  "notificationType": "discord",
  "status": "pending",
  "retries": 0,
  "maxRetries": 3,
  "priority": 1,
  "eventId": null,
  "contractAddress": null,
  "metadata": null,
  "createdAt": 1718640000000
}
```

### Check queue health

```bash
curl -sS http://localhost:8787/api/schedule/stats | jq
```

```json
{ "total": 100, "pending": 20, "delivered": 75, "failed": 5 }
```

A `failed > 0` value usually means Discord is rejecting deliveries
— see [Workflow 7 — recover from a Discord outage](#workflow-7--recover-from-a-discord-outage).

### Chain a notification to a contract event

```bash
# After observing event #1234 from contract CCEMX6..., schedule a follow-up
EVENT_ID="1234"
CONTRACT="CCEMX6..."

curl -sS -X POST http://localhost:8787/api/schedule \
  -H 'Content-Type: application/json' \
  -d "{
    \"executeAt\": \"$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z)\",
    \"payload\": { \"content\": \"Did anyone pick up task #1234 yet?\" },
    \"targetRecipient\": \"$DISCORD_WEBHOOK_URL\",
    \"eventId\": \"$EVENT_ID\",
    \"contractAddress\": \"$CONTRACT\"
  }"
```

---

## Workflow 3 — accept signed webhooks

`POST /api/webhooks` is for upstream systems that want to push events
*into* NotifyChain (rather than have NotifyChain poll them). Every
incoming request must carry an HMAC-SHA256 signature computed with a
pre-shared secret.

### Sign a payload from bash

```bash
SECRET="my-shared-secret"
KEY_ID="prod-2026-06"
BODY='{"event":"task_created","taskId":42}'

# HMAC-SHA256 hex of the raw body
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex \
  | awk '{print $NF}')

curl -sS -X POST http://localhost:8787/api/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: $KEY_ID" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
```

Expected response (`202 Accepted`):

```json
{ "status": "accepted" }
```

### Sign a payload from Node.js

```javascript
import crypto from 'node:crypto';
import fetch from 'node-fetch';

const SECRET = process.env.WEBHOOK_SECRET;
const KEY_ID = process.env.WEBHOOK_KEY_ID;
const body = JSON.stringify({ event: 'task_created', taskId: 42 });

const sig = crypto
  .createHmac('sha256', SECRET)
  .update(body)
  .digest('hex');

const res = await fetch('http://localhost:8787/api/webhooks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Key-Id': KEY_ID,
    'X-Signature': sig,
  },
  body,
});
console.log(res.status, await res.text());
```

### Verify the signature locally before sending

If you keep getting `"Invalid signature"` responses:

```bash
# 1. Print what the listener actually receives (it reads the raw body, not parsed JSON)
echo -n "$BODY" | xxd | head -3

# 2. Re-compute the signature with the SAME bytes
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
echo "Computed: $SIG"

# 3. Compare to a known-good signature from the listener logs
#    (look for "requestId=..." matching your last 401)
```

Common causes of signature mismatch:

- JSON re-serialization (key order, whitespace, escaped unicode)
- Hashing the parsed JSON object instead of the raw body bytes
- Trailing newline in `$BODY` (use `printf '%s'`, not `echo`)

---

## Workflow 4 — manage per-user notification preferences

NotifyChain lets each user opt in or out of notification categories
(Discord, webhook, etc.). Preferences default to **enabled** when not
explicitly set.

### Read a user's current preferences

```bash
curl -sS http://localhost:8787/api/preferences/alice | jq
```

```json
{
  "userId": "alice",
  "categories": { "discord": true },
  "updatedAt": 1718640000000
}
```

### Disable a category for a user

```bash
curl -sS -X PUT http://localhost:8787/api/preferences/alice \
  -H 'Content-Type: application/json' \
  -d '{ "categories": { "discord": false } }'
```

### Re-enable a single category without touching others

```bash
# Specifying only the keys you want to change leaves the rest untouched.
curl -sS -X PUT http://localhost:8787/api/preferences/alice \
  -H 'Content-Type: application/json' \
  -d '{ "categories": { "discord": true } }'
```

> **Note:** this PUT is a *patch*, not a *replace*. Unspecified
> categories keep their current value. If you need to wipe a user back
> to defaults, see the [preferences API reference](API.md#put-apipreferencesuserid).

---

## Workflow 5 — health-check a deployment

`GET /health` returns the live status of every dependency the listener
needs. Use it in uptime monitors, container readiness probes, and CI
smoke tests.

### Plain uptime check

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:8787/health
# Expect: 200 when healthy, 503 when degraded
```

### Detailed health dump (every dependency)

```bash
curl -sS http://localhost:8787/health | jq '.services'
```

```json
{
  "stellarRpc":      { "status": "ok",   "latencyMs": 142 },
  "discord":         { "status": "ok",   "latencyMs": 56  },
  "eventRegistry":   { "status": "ok",   "eventCount": 200 }
}
```

### Kubernetes readiness probe

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 8787
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

> A `503` response means **not ready** — Kubernetes will remove the pod
> from service endpoints. A `200` with `status: "error"` is treated as
> healthy by HTTP-level probes; if you need stricter semantics, grep
> the body for `"status":"ok"`.

---

## Workflow 6 — diagnose a failing request

Every response — success or failure — carries two correlation headers:

| Header             | Source                                |
|--------------------|---------------------------------------|
| `X-Request-Id`     | Server-generated UUID for the request |
| `X-Correlation-Id` | Caller-supplied (or auto-generated)   |

### Echo your own trace ID into the request

```bash
curl -sS -D - http://localhost:8787/api/events?limit=5 \
  -H 'X-Correlation-Id: front-42' \
  | head -20
```

The server will log the same ID:

```
[INFO]  requestId=8b4c3d2e correlationId=front-42 GET /api/events 200 12ms
```

### Find the server-side log for a failed request

```bash
# 1. Capture the X-Request-Id from a failing call
curl -sS -D - -X POST http://localhost:8787/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{ "executeAt": "not-a-date", "payload": {}, "targetRecipient": "x" }' \
  | tee /tmp/resp.txt
# (read X-Request-Id from /tmp/resp.txt)

# 2. Grep the listener logs
grep "requestId=$REQ_ID" listener.log
```

### Map a status code to a likely cause

| Code | Most common cause                               | First thing to try                              |
|------|-------------------------------------------------|-------------------------------------------------|
| 400  | Missing required field or invalid date format   | Re-read [Workflow 2](#workflow-2--schedule-a-future-notification) request body shape |
| 401  | Bad HMAC signature or missing X-API-Key         | [Workflow 3 — verify signature](#workflow-3--accept-signed-webhooks) |
| 404  | Unknown endpoint or notification ID             | Confirm the URL matches [`API.md`](API.md) |
| 429  | Rate limit exceeded                             | Back off and retry after `Retry-After` seconds  |
| 500  | Internal exception (DB lock, panic, etc.)       | Capture `X-Request-Id` and grep listener logs   |
| 503  | Scheduler disabled, or upstream RPC unreachable | Check `notificationAPI` config / `STELLAR_RPC_URL` |

---

## Workflow 7 — recover from a Discord outage

When the Discord webhook endpoint is rate-limiting or down, scheduled
notifications will sit in `pending` until they exceed `maxRetries` and
flip to `failed`. The listener retries with exponential backoff
automatically, but you can monitor and intervene.

### Detect the outage

```bash
# A growing failed count is the smoking gun
curl -sS http://localhost:8787/api/schedule/stats | jq '.failed'

# A spike in 'discord' service latency from /health is an early warning
curl -sS http://localhost:8787/health | jq '.services.discord'
# { "status": "error", "latencyMs": 5001, "detail": "..." }
```

### Check whether the listener is auto-retrying

```bash
# Look for "retries" > 0 in scheduled notifications
curl -sS 'http://localhost:8787/api/schedule/42' | jq '{id, status, retries, maxRetries}'
# { "id": 42, "status": "pending", "retries": 2, "maxRetries": 3 }
```

### When Discord recovers, manually re-queue failed notifications

```bash
# 1. Find failed notifications
curl -sS 'http://localhost:8787/api/schedule/stats' | jq

# 2. For each failed ID, schedule a fresh delivery
#    (the API does not support "retry this one" — re-POST with the
#    same payload and a new executeAt in the near future)
FAILED_ID=87
ORIG=$(curl -sS "http://localhost:8787/api/schedule/$FAILED_ID")

curl -sS -X POST http://localhost:8787/api/schedule \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --argjson orig "$ORIG" \
    --arg when "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{
      executeAt: $when,
      payload: $orig.payload,
      targetRecipient: $orig.targetRecipient,
      notificationType: $orig.notificationType,
      maxRetries: 3,
      priority: $orig.priority
    }')"
```

### Prevent future incidents

- Add a `/health` monitor with an alert when `services.discord.status != "ok"` for more than 60 seconds.
- Set `maxRetries: 5` (or higher) for any notification you cannot afford to lose.
- Subscribe your downstream service to the listener's event stream (Workflow 1) and re-derive notifications client-side; that way a listener-level delivery failure does not mean the message is lost.

---

## Troubleshooting matrix

| Symptom | Check | Likely fix |
|---|---|---|
| `GET /health` returns `503` | `services.stellarRpc.detail` | Point `STELLAR_RPC_URL` at a healthy node |
| `GET /health` returns `503` | `services.discord.detail` | Verify `DISCORD_WEBHOOK_URL` is correct and not revoked |
| `GET /api/events` returns empty | `STELLAR_NETWORK_PASSPHRASE` matches the events you expect | Set to `Test SDF Network ; September 2015` for testnet |
| `POST /api/schedule` returns `503 Scheduler not enabled` | Service was started without the `notificationAPI` option | Restart with `--features scheduler` (or set `ENABLE_SCHEDULER=true`) |
| `POST /api/webhooks` returns `401 Unknown key-id` | Listener has no registered secret for the supplied `X-Key-Id` | Add the key to the listener config (see `WEBHOOK_KEYS` env) |
| `POST /api/webhooks` returns `401 Invalid signature` | Body bytes don't match what was signed | Sign the raw body, not a re-serialized JSON object |
| `POST /api/schedule` returns `400 Missing required fields` | One of `executeAt`, `payload`, `targetRecipient` is missing or null | See [Workflow 2 — request body](#workflow-2--schedule-a-future-notification) |
| `GET /api/schedule/:id` returns `404 Notification not found` | The ID was purged, or the scheduler was not running when it was scheduled | Re-schedule with `POST /api/schedule` |
| `429` on every request | You forgot the `X-API-Key` header; limiter falls back to IP and your IP is shared | Pass `X-API-Key: $NOTIFICATION_API_KEY` |
| Listener logs spam `Webhook missing signature header` | An external system is hitting `/api/webhooks` unsigned | Either configure that system to sign, or block it upstream |

For full schema details and the complete error reference, see
[`API.md`](API.md).

---

## Field reference (one-page summary)

### `POST /api/schedule` required fields

| Field             | Type   | Notes                                               |
|-------------------|--------|-----------------------------------------------------|
| `executeAt`       | string | ISO 8601 datetime                                   |
| `payload`         | object | Arbitrary data forwarded to the notification handler |
| `targetRecipient` | string | Discord webhook URL or similar delivery target      |

### `POST /api/webhooks` required headers

| Header         | Value                                        |
|----------------|----------------------------------------------|
| `Content-Type` | `application/json`                            |
| `X-Key-Id`     | Identifier selecting which secret to use     |
| `X-Signature`  | HMAC-SHA256 hex of the raw request body      |

### Correlation headers (every response)

| Header             | Notes                                              |
|--------------------|----------------------------------------------------|
| `X-Request-Id`     | Server-generated UUID — grep listener logs by this |
| `X-Correlation-Id` | Echoed back if you supply `X-Correlation-Id`      |

### Useful environment variables

| Variable                  | Purpose                                          |
|---------------------------|--------------------------------------------------|
| `EVENTS_API_PORT`         | HTTP port (default `8787`)                       |
| `STELLAR_RPC_URL`         | Soroban RPC endpoint to poll                     |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` for testnet |
| `DISCORD_WEBHOOK_URL`     | Default delivery target                          |
| `NOTIFICATION_API_KEY`    | Required for `X-API-Key` rate-limit identity     |
| `WEBHOOK_KEYS`            | JSON map of `keyId -> secret` for inbound webhooks |

---

## See also

- [`API.md`](API.md) — full request/response reference for every endpoint
- [`../NOTIFICATION_FAILURE_RECOVERY.md`](../NOTIFICATION_FAILURE_RECOVERY.md) — retry lifecycle, configuration, and recovery
- [`../NOTIFICATION_PAYLOAD_SCHEMA.md`](../NOTIFICATION_PAYLOAD_SCHEMA.md) — notification payload schema and interpretation
- [`../SCHEDULED-NOTIFICATIONS-DELIVERY.md`](../SCHEDULED-NOTIFICATIONS-DELIVERY.md) — scheduler internals and tuning
- [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) — general listener troubleshooting
