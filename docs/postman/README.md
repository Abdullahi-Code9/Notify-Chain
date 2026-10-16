# NotifyChain Postman Collection (#992)

This directory contains the official Postman collection and environment file for the
NotifyChain Listener HTTP API.

## Files

| File | Purpose |
|------|---------|
| `notify-chain-api.postman_collection.json` | All public API endpoints, grouped by workflow |
| `notify-chain-local.postman_environment.json` | Environment variables for a local development instance |

---

## Quick start

### 1. Start a local listener instance

```bash
cd listener
cp .env.example .env          # edit .env with your Stellar RPC URL and Discord webhook
npm install
npm run dev
```

The server starts on `http://localhost:3000` by default.

### 2. Import into Postman

1. Open Postman (desktop or web).
2. Click **Import** (top-left).
3. Drag-and-drop both JSON files, or click **Select Files** and select them.
4. The collection `NotifyChain API — Public Workflows` and the environment
   `NotifyChain — Local` will appear in the sidebar.

### 3. Select the environment

In the top-right environment dropdown select **NotifyChain — Local**.

### 4. Verify connectivity

Open the **Infrastructure → Health check** request and click **Send**.  
You should receive a `200 OK` response with `"status": "ok"`.

---

## Collection variables

All secrets and per-environment values are parameterized — no hardcoded credentials exist
in the collection. Update the values in the **NotifyChain — Local** environment to match
your local configuration.

| Variable | Default | Where configured on the server |
|----------|---------|-------------------------------|
| `base_url` | `http://localhost:3000` | `listener/.env` → `PORT` |
| `api_key` | `dev-api-key-1` | `listener/.env` → `API_KEYS` |
| `webhook_secret` | `change-me-in-production` | `listener/.env` → `WEBHOOK_SECRETS` |
| `webhook_key_id` | `key-1` | `listener/.env` → `WEBHOOK_SECRETS` (the `id` field) |
| `schedule_id` | `1` | Set automatically after `POST /api/v1/schedule` |
| `template_id` | `1` | Set automatically after `POST /api/v1/templates` |
| `user_id` | `user-123` | Your application's user identifier |

---

## Automatic HMAC signing (webhooks)

The **Webhooks → Accept signed webhook** request includes a **Pre-request Script**
that automatically computes a valid HMAC-SHA256 signature before sending:

```javascript
// signingInput = '<timestamp>.<raw-body>'
const signingInput = timestamp + '.' + rawBody;
const hex = CryptoJS.HmacSHA256(signingInput, webhook_secret).toString(CryptoJS.enc.Hex);
pm.request.headers.upsert({ key: 'X-Webhook-Signature', value: 'sha256=' + hex });
pm.request.headers.upsert({ key: 'X-Webhook-Key-Id',    value: keyId });
pm.request.headers.upsert({ key: 'X-Webhook-Timestamp', value: timestamp });
```

This mirrors the documented signature format in
`listener/src/services/webhook-verifier.ts` and the
[Webhook Consumer Verification Example](../listener/src/examples/webhook-consumer-verification-example.ts).

---

## Folder structure

| Folder | Endpoints |
|--------|-----------|
| **Infrastructure** | `GET /health` |
| **Events** | `GET /api/v1/events`, `GET /api/v1/indexing/health`, `GET /api/v1/status` |
| **Webhooks** | `POST /api/v1/webhooks` (signed) |
| **Notifications — Scheduling** | `POST /api/v1/schedule`, `GET/DELETE /api/v1/schedule/:id`, stats, metrics, queue |
| **Notifications — History & Search** | history, search, health, validate-batch, import, suggestions |
| **Analytics** | analytics snapshot + history, rate-limit metrics |
| **Templates** | Full CRUD + render + stats |
| **Preferences** | `GET/PUT /api/v1/preferences/:userId` |
| **Archive** | list, get, run |

---

## Running the full workflow

The recommended order for a clean-slate local run:

1. **Health check** — confirm the server is up
2. **Create template** — creates `template_id` variable
3. **Render template** — verify template substitution works
4. **Schedule a notification** — creates `schedule_id` variable
5. **Scheduler statistics** — confirm the job is queued
6. **Get scheduled notification** — inspect the created job
7. **Accept signed webhook** — verify the HMAC signing pipeline
8. **Notification history** — see delivered records

---

## API versioning

All endpoints in this collection use the `/api/v1/` prefix.  
The server responds with `X-API-Version: v1` on every response.

Unversioned `/api/` routes work identically — see
[`docs/api-versioning.md`](../api-versioning.md) for the full versioning policy.
