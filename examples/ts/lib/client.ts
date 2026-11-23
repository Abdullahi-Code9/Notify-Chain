/**
 * Minimal, dependency-free HTTP client for the NotifyChain listener API.
 *
 * TypeScript mirror of `../js/lib/client.mjs`, with real interfaces for the
 * response shapes the listener actually returns:
 *   - listener/src/utils/response.ts            → success/error envelopes
 *   - listener/src/utils/request-id.ts          → X-Request-Id / X-Correlation-Id
 *   - listener/src/api/api-key-auth.ts          → X-API-Key header
 *   - listener/src/services/webhook-verifier.ts → HMAC-SHA256 scheme
 *   - listener/src/types/display-event.ts       → DisplayEvent
 *   - listener/src/services/notification-history.ts → history records
 *
 * Only Node built-ins are used: global `fetch` and `node:crypto`.
 * Written with erasable-only syntax so Node 22.6+/24 can run it directly
 * (`node ts/01-setup-and-config.ts`).
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Default listener base URL (`EVENTS_API_PORT` defaults to 8787). */
export const DEFAULT_BASE_URL = 'http://localhost:8787';

// ---------------------------------------------------------------------------
// Response shape interfaces (mirror the listener source)
// ---------------------------------------------------------------------------

/** A stored contract event — `listener/src/types/display-event.ts`. */
export interface DisplayEvent {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: string[];
  value: string;
  txHash?: string;
  receivedAt: number;
}

/** Success envelope — `listener/src/utils/response.ts`. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/** Error body — `listener/src/utils/response.ts` + `errors/api-error-codes.ts`. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
  correlation_id?: string;
}

/** Error envelope. */
export interface ApiError {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** `GET /api/events` → `data`. */
export interface EventsData {
  count: number;
  events: DisplayEvent[];
}

/** `GET /api/events/history` → `data`. */
export interface EventsHistoryData {
  count: number;
  startLedger: number;
  endLedger: number;
  events: DisplayEvent[];
}

/** One delivery execution record — `listener/src/services/notification-history.ts`. */
export interface NotificationHistoryRecord {
  id: number;
  scheduledNotificationId: number;
  executionAttempt: number;
  executionTime: string;
  status: 'SUCCESS' | 'FAILED' | 'RETRY';
  errorMessage: string | null;
  responseDuration: number | null;
}

/** `GET /api/notifications/history` response (returned directly, NOT enveloped). */
export interface PaginatedHistoryResponse {
  records: NotificationHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
  itemCount: number;
  totalPages: number;
  nextCursor?: string | null;
}

/** `POST /api/schedule` request body. */
export interface ScheduleRequest {
  payload: Record<string, unknown>;
  targetRecipient: string;
  executeAt: string;
  notificationType?: 'discord' | 'email' | 'webhook' | 'sms';
  maxRetries?: number;
  priority?: number;
  eventId?: string;
  contractAddress?: string;
  metadata?: Record<string, unknown>;
}

/** `POST /api/schedule` response (returned directly, NOT enveloped). */
export interface ScheduleResponse {
  id: number;
  executeAt: string;
  timezone: string;
  executeAtLocal: string;
}

/** `POST /api/webhooks` success response. */
export interface WebhookAcceptedResponse {
  status: string;
  verified?: boolean;
}

/** Normalised form of either error shape the listener emits. */
export interface NormalizedApiError {
  code: string | null;
  message: string | null;
  details: unknown;
  correlationId: string | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExampleConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  webhookKeyId: string;
  webhookTimestampMaxAgeSeconds: number;
  receiverPort: number;
}

/** Reads example configuration from the environment with safe local defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExampleConfig {
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
export function maskSecret(value: string): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for transport failures. */
export class ListenerApiError extends Error {
  readonly status?: number;
  readonly code?: string | null;

  constructor(
    message: string,
    options: { status?: number; code?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ListenerApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalises the two error shapes the listener emits. */
export function extractApiError(body: unknown): NormalizedApiError | null {
  if (!isRecord(body)) return null;
  const errorField = body.error;
  if (isRecord(errorField)) {
    return {
      code: typeof errorField.code === 'string' ? errorField.code : (typeof body.code === 'string' ? body.code : null),
      message: typeof errorField.message === 'string' ? errorField.message : null,
      details: errorField.details ?? [],
      correlationId: typeof errorField.correlation_id === 'string' ? errorField.correlation_id : null,
    };
  }
  if (typeof errorField === 'string') {
    return {
      code: typeof body.code === 'string' ? body.code : null,
      message: errorField,
      details: body.details ?? [],
      correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : null,
    };
  }
  return null;
}

/** Unwraps a success envelope, or returns the body unchanged. */
export function unwrapEnvelope<T>(body: unknown): T {
  if (isRecord(body) && body.success === true && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Webhook signature scheme (exact mirror of webhook-verifier.ts)
// ---------------------------------------------------------------------------

const SIGNATURE_PREFIX = 'sha256=';
const SIGNING_SEPARATOR = '.';
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

export function buildSigningInput(payload: string, timestamp?: string): string {
  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    return `${timestamp}${SIGNING_SEPARATOR}${payload}`;
  }
  return payload;
}

export function computeWebhookSignature(payload: string, secret: string, timestamp?: string): string {
  const signingInput = buildSigningInput(payload, timestamp);
  const hex = createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

export function isTimestampValid(timestampHeader: string, maxAgeSeconds: number): boolean {
  if (typeof timestampHeader !== 'string' || !TIMESTAMP_PATTERN.test(timestampHeader)) {
    return false;
  }
  const requestTimestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(requestTimestamp)) return false;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const requestAge = currentTimestamp - requestTimestamp;
  return requestAge <= maxAgeSeconds && requestAge >= -60;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface VerifyWebhookOptions {
  payload: string;
  signatureHeader: string | undefined;
  secret: string;
  timestampHeader?: string | undefined;
  maxAgeSeconds?: number;
  requireTimestamp?: boolean;
}

export function verifyWebhookSignature({
  payload,
  signatureHeader,
  secret,
  timestampHeader,
  maxAgeSeconds = 300,
  requireTimestamp = true,
}: VerifyWebhookOptions): WebhookVerificationResult {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, reason: 'missing_signature_header' };
  }
  if (signatureHeader.slice(0, SIGNATURE_PREFIX.length).toLowerCase() !== SIGNATURE_PREFIX) {
    return { valid: false, reason: 'invalid_signature_prefix' };
  }

  const hasTimestamp =
    timestampHeader !== undefined && timestampHeader !== null && timestampHeader !== '';
  if (hasTimestamp && maxAgeSeconds !== undefined) {
    if (!isTimestampValid(timestampHeader as string, maxAgeSeconds)) {
      return { valid: false, reason: 'timestamp_expired' };
    }
  }

  const signingInput = buildSigningInput(payload, timestampHeader);
  const expectedSig = createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  const providedSig = signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase();

  if (expectedSig.length !== providedSig.length) {
    return { valid: false, reason: 'signature_length_mismatch' };
  }
  const match = timingSafeEqual(Buffer.from(expectedSig, 'utf8'), Buffer.from(providedSig, 'utf8'));
  if (!match) return { valid: false, reason: 'hmac_mismatch' };

  if (!hasTimestamp && requireTimestamp) {
    return { valid: false, reason: 'missing_timestamp' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  correlationId?: string;
}

export interface RequestResult {
  status: number;
  ok: boolean;
  headers: Headers;
  requestId: string | null;
  correlationId: string | null;
  raw: string;
  data: unknown;
  malformed: boolean;
}

export interface ListenerClientOptions {
  baseUrl?: string;
  apiKey?: string;
  correlationId?: string;
  fetchImpl?: typeof fetch;
}

export class ListenerClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly correlationId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', correlationId, fetchImpl = fetch }: ListenerClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.correlationId = correlationId;
    this.fetchImpl = fetchImpl;
  }

  /** Builds a request URL with the given path and query params. */
  buildUrl(path: string, query?: Record<string, QueryValue>): URL {
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
  buildHeaders({ body, correlationId }: { body?: unknown; correlationId?: string } = {}): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const cid = correlationId ?? this.correlationId;
    if (cid) headers['X-Correlation-Id'] = cid;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /** Performs a request; never throws on a non-2xx HTTP status. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<RequestResult> {
    const url = this.buildUrl(path, options.query);
    const mergedHeaders: Record<string, string> = {
      ...this.buildHeaders({ body: options.body, correlationId: options.correlationId }),
      ...(options.headers ?? {}),
    };
    // A string body is sent verbatim (so signed bytes match the signature).
    const bodyText =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, headers: mergedHeaders, body: bodyText });
    } catch (err) {
      throw new ListenerApiError(
        `Network error calling ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const raw = await response.text();
    let data: unknown;
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

  get(path: string, options?: RequestOptions): Promise<RequestResult> {
    return this.request('GET', path, options);
  }

  post(path: string, options?: RequestOptions): Promise<RequestResult> {
    return this.request('POST', path, options);
  }

  // -- Endpoint helpers -----------------------------------------------------

  /** `GET /health` — not enveloped. */
  health(): Promise<RequestResult> {
    return this.get('/health');
  }

  /** `GET /api/events?limit=N` — limit default 20, max 100. */
  getEvents({ limit }: { limit?: number } = {}): Promise<RequestResult> {
    return this.get('/api/events', { query: { limit } });
  }

  /** `GET /api/events/history?fromLedger&toLedger` — both required, span ≤ 10 000. */
  getEventsByLedgerRange(fromLedger: number, toLedger: number): Promise<RequestResult> {
    return this.get('/api/events/history', { query: { fromLedger, toLedger } });
  }

  /** `GET /api/notifications/history` — requires an API key when configured. */
  getNotificationHistory(
    options: {
      limit?: number;
      offset?: number;
      cursor?: string;
      status?: 'SUCCESS' | 'FAILED' | 'RETRY';
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<RequestResult> {
    return this.get('/api/notifications/history', { query: options });
  }

  /** `POST /api/schedule` — requires executeAt, payload, targetRecipient. */
  scheduleNotification(body: ScheduleRequest): Promise<RequestResult> {
    return this.post('/api/schedule', { body });
  }

  /** `POST /api/webhooks` — signs the payload and sends the `X-Webhook-*` headers. */
  sendSignedWebhook(
    payload: unknown,
    { secret, keyId, timestamp }: { secret: string; keyId: string; timestamp?: string },
  ): Promise<RequestResult> {
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

/** Convenience: a client with a generated correlation id. */
export function createClient(options: ListenerClientOptions = {}): ListenerClient {
  return new ListenerClient({ correlationId: randomUUID(), ...options });
}
