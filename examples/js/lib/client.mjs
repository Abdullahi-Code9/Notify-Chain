/**
 * Minimal, dependency-free HTTP client for the NotifyChain listener API.
 *
 * Uses only Node built-ins: global `fetch` (Node 18+, stable in 22+) and
 * `node:crypto`. No axios / node-fetch / dotenv.
 *
 * Everything here mirrors the real listener implementation:
 *   - `listener/src/utils/response.ts`        → success/error envelopes
 *   - `listener/src/utils/request-id.ts`      → X-Request-Id / X-Correlation-Id
 *   - `listener/src/api/api-key-auth.ts`      → X-API-Key header
 *   - `listener/src/services/webhook-verifier.ts` → HMAC-SHA256 scheme
 *   - `listener/src/errors/api-error-codes.ts` → stable error codes
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Default listener base URL (`EVENTS_API_PORT` defaults to 8787). */
export const DEFAULT_BASE_URL = 'http://localhost:8787';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Reads example configuration from the environment with safe local defaults.
 * See `examples/.env.example` for every variable.
 */
export function loadConfig(env = process.env) {
  const maxAgeSeconds = Number(env.WEBHOOK_TIMESTAMP_MAX_AGE_SECONDS ?? '300');
  return {
    baseUrl: env.EVENTS_API_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.EVENTS_API_KEY ?? '',
    webhookSecret: env.WEBHOOK_SECRET ?? 'whsec_example_secret',
    webhookKeyId: env.WEBHOOK_KEY_ID ?? 'default',
    webhookTimestampMaxAgeSeconds: Number.isFinite(maxAgeSeconds) ? maxAgeSeconds : 300,
    receiverPort: Number(env.EXAMPLE_RECEIVER_PORT ?? '8790'),
  };
}

/** Masks a secret for logging without leaking it. */
export function maskSecret(value) {
  if (!value) return '(unset)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for transport failures and for HTTP responses the caller opts to treat as errors. */
export class ListenerApiError extends Error {
  constructor(message, { status, code, details, correlationId, body } = {}) {
    super(message);
    this.name = 'ListenerApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.correlationId = correlationId;
    this.body = body;
  }
}

/**
 * Normalises the two error shapes the listener actually emits:
 *
 *   1. Standard envelope (most routes, via `sendErr`):
 *        { success: false, error: { code, message, details, correlation_id } }
 *   2. Bare shape (route handlers that write the body directly — e.g.
 *      `/api/schedule*` and `/api/webhooks` auth failures):
 *        { error: "human message", code: "MACHINE_CODE" }
 *
 * Returns `null` when the body carries no recognisable error.
 */
export function extractApiError(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.error && typeof body.error === 'object') {
    return {
      code: body.error.code ?? body.code ?? null,
      message: body.error.message ?? null,
      details: body.error.details ?? [],
      correlationId: body.error.correlation_id ?? null,
    };
  }
  if (typeof body.error === 'string') {
    return {
      code: body.code ?? null,
      message: body.error,
      details: body.details ?? [],
      correlationId: body.correlation_id ?? null,
    };
  }
  return null;
}

/**
 * Unwraps the listener's success envelope (`{ success: true, data }`).
 * Falls back to the raw body for endpoints that do not use the envelope
 * (e.g. `/api/notifications/history`, `/health`, `POST /api/schedule`).
 */
export function unwrapEnvelope(body) {
  if (body && typeof body === 'object' && body.success === true && 'data' in body) {
    return body.data;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Webhook signature scheme (exact mirror of webhook-verifier.ts)
// ---------------------------------------------------------------------------

const SIGNATURE_PREFIX = 'sha256=';
const SIGNING_SEPARATOR = '.';
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

/** `timestamp + "." + payload` (or bare `payload` when no timestamp). */
export function buildSigningInput(payload, timestamp) {
  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    return `${timestamp}${SIGNING_SEPARATOR}${payload}`;
  }
  return payload;
}

/** Produces `sha256=<hex>` over the signing input. */
export function computeWebhookSignature(payload, secret, timestamp) {
  const signingInput = buildSigningInput(payload, timestamp);
  const hex = createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/** True when a bare-integer timestamp header is within the freshness window. */
export function isTimestampValid(timestampHeader, maxAgeSeconds) {
  if (typeof timestampHeader !== 'string' || !TIMESTAMP_PATTERN.test(timestampHeader)) {
    return false;
  }
  const requestTimestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(requestTimestamp)) return false;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const requestAge = currentTimestamp - requestTimestamp;
  // Reject stale (> maxAge) and far-future (< -60s clock skew) timestamps.
  return requestAge <= maxAgeSeconds && requestAge >= -60;
}

/**
 * Verifies an incoming webhook signature using a timing-safe comparison,
 * mirroring `verifySignature` in `listener/src/services/webhook-verifier.ts`.
 *
 * @returns `{ valid: boolean, reason?: string }`
 */
export function verifyWebhookSignature({
  payload,
  signatureHeader,
  secret,
  timestampHeader,
  maxAgeSeconds = 300,
  requireTimestamp = true,
}) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, reason: 'missing_signature_header' };
  }
  // Prefix is compared case-insensitively — several senders emit `SHA256=`.
  if (signatureHeader.slice(0, SIGNATURE_PREFIX.length).toLowerCase() !== SIGNATURE_PREFIX) {
    return { valid: false, reason: 'invalid_signature_prefix' };
  }

  const hasTimestamp =
    timestampHeader !== undefined && timestampHeader !== null && timestampHeader !== '';
  if (hasTimestamp && maxAgeSeconds !== undefined) {
    if (!isTimestampValid(timestampHeader, maxAgeSeconds)) {
      return { valid: false, reason: 'timestamp_expired' };
    }
  }

  const signingInput = buildSigningInput(payload, timestampHeader);
  const expectedSig = createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  const providedSig = signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase();

  if (expectedSig.length !== providedSig.length) {
    return { valid: false, reason: 'signature_length_mismatch' };
  }
  const match = timingSafeEqual(
    Buffer.from(expectedSig, 'utf8'),
    Buffer.from(providedSig, 'utf8'),
  );
  if (!match) return { valid: false, reason: 'hmac_mismatch' };

  if (!hasTimestamp && requireTimestamp) {
    return { valid: false, reason: 'missing_timestamp' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Tiny listener client. Every method returns the raw parsed response plus the
 * `X-Request-Id` / `X-Correlation-Id` tracing headers, and never throws on a
 * non-2xx HTTP status (only on transport failures). Callers inspect `status`.
 */
export class ListenerClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]   Listener base URL.
   * @param {string} [options.apiKey]    Value for the `X-API-Key` header.
   * @param {string} [options.correlationId] Default `X-Correlation-Id` to send.
   * @param {typeof fetch} [options.fetchImpl] Injectable fetch (for tests/retries).
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', correlationId, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.correlationId = correlationId;
    this.fetchImpl = fetchImpl;
  }

  /** Builds a request URL with the given path and query params. */
  buildUrl(path, query) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /** Builds the headers the listener expects for an authenticated request. */
  buildHeaders({ body, correlationId } = {}) {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const cid = correlationId ?? this.correlationId;
    if (cid) headers['X-Correlation-Id'] = cid;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /**
   * Performs a request. Resolves with:
   *   { status, ok, headers, requestId, correlationId, raw, data, malformed }
   * where `data` is parsed JSON (or `undefined`) and `malformed` is true when
   * the body was non-empty but not valid JSON.
   */
  async request(method, path, { query, body, headers, correlationId } = {}) {
    const url = this.buildUrl(path, query);
    const mergedHeaders = { ...this.buildHeaders({ body, correlationId }), ...(headers ?? {}) };
    // A string body is sent verbatim (needed so the signed webhook bytes match
    // the signature); anything else is JSON-serialised.
    const bodyText =
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

    let response;
    try {
      response = await this.fetchImpl(url, { method, headers: mergedHeaders, body: bodyText });
    } catch (err) {
      throw new ListenerApiError(
        `Network error calling ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const raw = await response.text();
    let data;
    let malformed = false;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        malformed = true;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      requestId: response.headers.get('x-request-id'),
      correlationId: response.headers.get('x-correlation-id'),
      raw,
      data,
      malformed,
    };
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, options) {
    return this.request('POST', path, options);
  }

  // -- Endpoint helpers -----------------------------------------------------

  /** `GET /health` — listener + dependency status (NOT enveloped). */
  health() {
    return this.get('/health');
  }

  /**
   * `GET /api/events` — newest-first events (no API key required).
   * @param {{ limit?: number }} [options] limit default 20, max 100.
   */
  getEvents({ limit } = {}) {
    return this.get('/api/events', { query: { limit } });
  }

  /**
   * `GET /api/events/history` — events in an inclusive ledger range.
   * Both `fromLedger` and `toLedger` are required; span ≤ 10 000 ledgers.
   */
  getEventsByLedgerRange(fromLedger, toLedger) {
    return this.get('/api/events/history', {
      query: { fromLedger, toLedger },
    });
  }

  /**
   * `GET /api/notifications/history` — paginated delivery execution records.
   * Requires an API key when the listener has `API_KEYS` configured.
   * @param {{ limit?: number, offset?: number, cursor?: string, status?: 'SUCCESS'|'FAILED'|'RETRY', startDate?: string, endDate?: string }} [options]
   */
  getNotificationHistory(options = {}) {
    return this.get('/api/notifications/history', { query: options });
  }

  /**
   * `POST /api/schedule` — create a scheduled notification.
   * Requires `executeAt`, `payload`, `targetRecipient`. Returns
   * `{ id, executeAt, timezone, executeAtLocal }` on 201.
   */
  scheduleNotification(body) {
    return this.post('/api/schedule', { body });
  }

  /**
   * `POST /api/webhooks` — signed webhook ingress. Signs `payload` with the
   * given secret and sends the `X-Webhook-*` headers the listener verifies.
   */
  sendSignedWebhook(payload, { secret, keyId, timestamp } = {}) {
    const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signature = computeWebhookSignature(raw, secret, ts);
    return this.request('POST', '/api/webhooks', {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Key-Id': keyId,
        'X-Webhook-Timestamp': ts,
      },
      body: raw,
    });
  }
}

/** Convenience: a client with a freshly generated correlation id. */
export function createClient(options = {}) {
  return new ListenerClient({ correlationId: randomUUID(), ...options });
}
