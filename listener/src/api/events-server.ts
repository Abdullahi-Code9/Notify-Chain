import crypto from 'crypto';
import http from 'http';
import { DEFAULT_MAX_BODY_BYTES, enforceBodyLimit } from '../middleware/body-limit';
import { validateContentType } from '../middleware/content-type';
import { runWithRequestCorrelation } from '../middleware/correlation';
import { eventRegistry } from '../store/event-registry';
import { preferenceStore } from '../store/preference-store';
import { getDatabase } from '../database/database';
import logger from '../utils/logger';
import { sendJson, sendOk, sendErr, ErrorCode } from '../utils/response';
import { NotificationAnalyticsAggregator } from '../services/notification-analytics-aggregator';
import { applyVersionHeaders, normaliseApiPath } from './api-version-registry';

export interface EventsServerOptions {
  port?: number;
  isProduction?: boolean;
  stellarRpcUrl?: string;
  stellarNetwork?: string;
  stellarNetworkPassphrase?: string;
  contractAddresses?: Array<{ address: string; events?: string[]; userId?: string; paused?: boolean }>;
  discordWebhookUrl?: string;
  webhookSecrets?: Array<{ id: string; secret: string }>;
  analyticsAggregator?: NotificationAnalyticsAggregator;
  metricsStore?: { getHistory?: (limit?: number, since?: string) => Promise<unknown[]> };
  notificationAPI?: unknown;
  api?: { maxBodyBytes?: number };
}

export interface HealthServiceStatus {
  status: 'ok' | 'error' | 'degraded' | 'not_configured';
  detail?: string;
  latencyMs?: number;
  [key: string]: unknown;
}

export type HealthStatus = 'ok' | 'degraded' | 'error';

const DEFAULT_BODY_LIMIT = DEFAULT_MAX_BODY_BYTES;
const MAX_EVENT_LIMIT = 100;
const MAX_BATCH_SIZE = 500;

function normalizeContractEntry(contract: string | { address: string; events?: string[]; userId?: string; paused?: boolean }): { address: string } {
  if (typeof contract === 'string') {
    return { address: contract };
  }
  return { address: contract.address };
}

function parseQueryInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1) return 1;
  return Math.min(parsed, max);
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === 'ok';
}

export async function checkDatabase(): Promise<HealthServiceStatus> {
  const started = Date.now();
  try {
    const db = getDatabase();
    if (typeof (db as any).isConnected === 'function' && !(db as any).isConnected()) {
      return { status: 'error', detail: 'Database not initialized', latencyMs: Date.now() - started };
    }
    if (typeof (db as any).get === 'function') {
      await (db as any).get('SELECT 1');
    }
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'Database unavailable',
      latencyMs: Date.now() - started,
    };
  }
}

export async function checkStellarRpc(rpcUrl: string): Promise<HealthServiceStatus> {
  const started = Date.now();
  try {
    const StellarSDK = await import('@stellar/stellar-sdk');
    const server = new (StellarSDK.rpc as any).Server(rpcUrl);
    const health = await server.getHealth();
    const status = health?.status === 'healthy' || health?.status === 'ok' ? 'ok' : 'error';
    return { status, latencyMs: Date.now() - started, detail: status === 'ok' ? undefined : String(health?.status ?? 'unhealthy') };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'RPC unavailable',
      latencyMs: Date.now() - started,
    };
  }
}

export async function checkDiscord(webhookUrl?: string): Promise<HealthServiceStatus> {
  if (!webhookUrl) {
    return { status: 'not_configured' };
  }

  const started = Date.now();
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'healthcheck' }),
    });

    if (!response.ok) {
      return {
        status: 'error',
        detail: `HTTP ${response.status}`,
        latencyMs: Date.now() - started,
      };
    }

    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'Discord webhook unavailable',
      latencyMs: Date.now() - started,
    };
  }
}

function sendAccessibleHeaders(res: http.ServerResponse, isProduction: boolean = false): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Signature, X-Webhook-Key-Id, X-Webhook-Timestamp, X-Correlation-Id, X-Request-Id');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function statusFromServiceMap(services: Record<string, HealthServiceStatus>): HealthStatus {
  const values = Object.values(services);
  if (values.some((svc) => svc.status === 'error')) return 'error';
  if (values.some((svc) => svc.status === 'degraded' || svc.status === 'not_configured')) return 'degraded';
  return 'ok';
}

function signHmac(secret: string, payload: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
}

function verifyWebhookSignature(payload: string, signature: string, secret: string, timestamp?: string): { valid: boolean; code?: string; message?: string } {
  const provided = signature.trim();
  const headerTimestamp = timestamp?.trim();

  if (headerTimestamp) {
    const now = Math.floor(Date.now() / 1000);
    const ts = Number.parseInt(headerTimestamp, 10);
    if (!Number.isFinite(ts)) {
      return { valid: false, code: 'AUTH_INVALID_TIMESTAMP', message: 'Invalid timestamp header' };
    }
    if (Math.abs(now - ts) > 600) {
      return { valid: false, code: 'AUTH_TIMESTAMP_EXPIRED', message: 'Request signature expired' };
    }
    const expected = signHmac(secret, `${headerTimestamp}.${payload}`);
    if (provided !== expected) {
      return { valid: false, code: 'AUTH_INVALID_SIGNATURE', message: 'Invalid signature' };
    }
    return { valid: true };
  }

  const legacyExpected = signHmac(secret, payload);
  if (provided !== legacyExpected) {
    return { valid: false, code: 'AUTH_INVALID_SIGNATURE', message: 'Invalid signature' };
  }
  return { valid: true };
}

function validateBatch(body: unknown): { valid: boolean; processedCount: number; errors: Array<{ code: string; message: string; index?: number }> } {
  const items = Array.isArray(body) ? body : [];
  const errors: Array<{ code: string; message: string; index?: number }> = [];
  const recipients = new Set<string>();

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ code: 'INVALID_ITEM', message: `Item at index ${index} is not an object` });
      continue;
    }

    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const recipient = typeof entry.recipient === 'string' ? entry.recipient.trim() : '';
    const channel = typeof entry.channel === 'string' ? entry.channel.trim() : '';
    const message = typeof entry.message === 'string' ? entry.message.trim() : '';

    if (!id || !recipient || !channel || !message) {
      errors.push({ code: 'MISSING_FIELD', message: `Missing required fields for item ${index}`, index });
      continue;
    }

    if (recipients.has(recipient)) {
      errors.push({ code: 'DUPLICATE_RECIPIENT', message: `Duplicate recipient: ${recipient}`, index });
      continue;
    }
    recipients.add(recipient);
  }

  return {
    valid: errors.length === 0,
    processedCount: items.length,
    errors,
  };
}

export function createEventsServer(options: EventsServerOptions = {}): http.Server {
  const bodyLimitBytes = options.api?.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  const configContractAddresses = options.contractAddresses ?? [];
  const webhookSecrets = new Map((options.webhookSecrets ?? []).map((entry) => [entry.id, entry.secret]));
  const analyticsAggregator = options.analyticsAggregator ?? new NotificationAnalyticsAggregator();
  const metricsStore = options.metricsStore ?? null;
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { normalisedPath } = normaliseApiPath(url.pathname);
    const pathname = normalisedPath;
    sendAccessibleHeaders(res, isProduction);
    applyVersionHeaders(req.method ?? 'GET', pathname, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);
    if (bodyMethods.has((req.method ?? 'GET').toUpperCase())) {
      if (!validateContentType(req, res, ['application/json'])) {
        return;
      }
      const limitCheck = enforceBodyLimit(req, res, {
        maxBytes: bodyLimitBytes,
        onRejected: (reason, observedBytes) => {
          logger.warn('Rejected oversized request body', { reason, observedBytes, path: pathname });
        },
      });
      if (!limitCheck.allowed) {
        return;
      }
    }

    if (pathname === '/health') {
      const services: Record<string, HealthServiceStatus> = {
        stellarRpc: await checkStellarRpc(options.stellarRpcUrl ?? 'http://localhost:8000'),
        discord: await checkDiscord(options.discordWebhookUrl),
        database: await checkDatabase(),
        eventRegistry: { status: eventRegistry.count() > 0 ? 'ok' : 'ok', eventCount: eventRegistry.count() },
      };
      const overall = statusFromServiceMap(services);
      const httpStatus = overall === 'error' ? 503 : 200;
      sendJson(res, httpStatus, {
        status: overall,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(((Date.now() - (globalThis as any).__notifyStartTs) / 1000).toFixed(3)) || 0,
        version: process.env.npm_package_version ?? 'unknown',
        services,
      });
      return;
    }

    if (pathname === '/api/status') {
      const contracts = (configContractAddresses ?? []).map((contract) => normalizeContractEntry(contract));
      sendOk(res, 200, {
        timestamp: new Date().toISOString(),
        contracts: contracts.map((item) => ({
          address: item.address,
          paused: false,
        })),
      });
      return;
    }

    if (pathname === '/api/events') {
      const limit = parseQueryInt(url.searchParams.get('limit') ?? undefined, 20, MAX_EVENT_LIMIT);
      const items = eventRegistry.getEvents(limit);
      sendOk(res, 200, { count: eventRegistry.count(), events: items });
      return;
    }

    if (pathname === '/api/indexing/health') {
      const snapshot = eventRegistry.getIngestionSnapshot();
      const indexedLedger = snapshot.lastIngestedLedger ?? null;
      const networkTipLedger = snapshot.maxLedgerSeen ?? null;
      const ledgerLag = indexedLedger !== null && networkTipLedger !== null ? Math.max(networkTipLedger - indexedLedger, 0) : null;
      const lastIngestedAt = snapshot.lastIngestedAt !== null ? new Date(snapshot.lastIngestedAt).toISOString() : null;
      const processingDelayMs = snapshot.lastIngestedAt !== null ? Math.max(Date.now() - snapshot.lastIngestedAt, 0) : null;

      let status: 'synced' | 'syncing' | 'degraded' = 'syncing';
      if (indexedLedger !== null && networkTipLedger !== null) {
        status = ledgerLag !== null && ledgerLag <= 5 ? 'synced' : 'degraded';
      } else if (indexedLedger !== null || networkTipLedger !== null) {
        status = 'syncing';
      }

      sendOk(res, 200, {
        status,
        timestamp: new Date().toISOString(),
        indexedLedger,
        networkTipLedger,
        ledgerLag,
        processingDelayMs,
        lastIngestedAt,
      });
      return;
    }

    if (pathname.startsWith('/api/preferences/')) {
      const userId = pathname.split('/api/preferences/')[1]?.split('/')[0];
      if (!userId) {
        sendErr(res, 404, 'Preference user not found', ErrorCode.NOT_FOUND);
        return;
      }

      if (req.method === 'GET') {
        sendOk(res, 200, preferenceStore.get(userId));
        return;
      }

      if (req.method === 'PUT') {
        try {
          const input = (await readJsonBody(req)) as Record<string, unknown>;
          if (!input || typeof input !== 'object' || !('categories' in input) || typeof (input as any).categories !== 'object') {
            sendErr(res, 400, 'Invalid body: expected { categories: { [key]: boolean } }', ErrorCode.BAD_REQUEST, { field: 'categories' });
            return;
          }
          const updated = preferenceStore.update(userId, input as { categories: Record<string, boolean> });
          sendOk(res, 200, updated);
          return;
        } catch (error) {
          sendErr(res, 400, error instanceof Error ? error.message : 'Invalid JSON', ErrorCode.PARSE_ERROR, []);
          return;
        }
      }
    }

    if (pathname === '/api/webhooks' && req.method === 'POST') {
      const payload = await readJsonBody(req).catch(() => undefined);
      const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
      const keyId = req.headers['x-webhook-key-id'];
      const signature = req.headers['x-webhook-signature'];
      const timestamp = req.headers['x-webhook-timestamp'];

      if (!keyId || Array.isArray(keyId)) {
        sendErr(res, 401, 'Missing key-id header', 'AUTH_MISSING_KEY_ID');
        return;
      }
      if (!signature || Array.isArray(signature)) {
        sendErr(res, 401, 'Missing signature header', 'AUTH_MISSING_SIGNATURE');
        return;
      }
      const secret = webhookSecrets.get(keyId);
      if (!secret) {
        sendErr(res, 401, 'Unknown key-id', 'AUTH_UNKNOWN_KEY_ID');
        return;
      }
      const verification = verifyWebhookSignature(rawBody, signature, secret, Array.isArray(timestamp) ? timestamp[0] : timestamp);
      if (!verification.valid) {
        sendErr(res, 401, verification.message ?? 'Invalid signature', verification.code ?? 'AUTH_INVALID_SIGNATURE');
        return;
      }

      sendOk(res, 202, { status: 'accepted', verified: true });
      return;
    }

    if (pathname === '/api/analytics') {
      const snapshot = analyticsAggregator.snapshot();
      const reset = url.searchParams.get('reset') === 'true';
      if (reset) {
        analyticsAggregator.reset();
      }
      sendOk(res, 200, snapshot);
      return;
    }

    if (pathname === '/api/analytics/history') {
      if (!metricsStore || typeof metricsStore.getHistory !== 'function') {
        sendOk(res, 200, { count: 0, snapshots: [] });
        return;
      }
      const limit = parseQueryInt(url.searchParams.get('limit') ?? undefined, 10, 100);
      const since = url.searchParams.get('since') ?? undefined;
      const snapshots = await metricsStore.getHistory(limit, since);
      sendOk(res, 200, { count: Array.isArray(snapshots) ? snapshots.length : 0, snapshots: Array.isArray(snapshots) ? snapshots : [] });
      return;
    }

    if (pathname === '/api/notifications/validate-batch') {
      try {
        const body = await readJsonBody(req);
        const result = validateBatch(body);
        const payload = {
          success: true,
          data: {
            valid: result.valid,
            processedCount: result.processedCount,
            errors: result.errors,
          },
        };
        sendJson(res, result.valid ? 200 : 200, payload);
        return;
      } catch {
        sendErr(res, 400, 'Failed to read request body', ErrorCode.PARSE_ERROR);
        return;
      }
    }

    sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
  };

  const server = http.createServer((req, res) => {
    runWithRequestCorrelation(req, res, (requestContext) => {
      void handleRequest(req, res).catch((error: unknown) => {
        logger.error('Unhandled error in events server request handler', { error, requestId: requestContext.requestId, correlationId: requestContext.correlationId });
        if (!res.headersSent) {
          sendErr(res, 500, 'Internal server error', ErrorCode.INTERNAL_ERROR, undefined, requestContext.correlationId);
        }
      });
    });
  });

  const startupTs = Date.now();
  (globalThis as any).__notifyStartTs ??= startupTs;

  return server;
}

export function startEventsServer(options: EventsServerOptions = {}): http.Server {
  const server = createEventsServer(options);
  server.listen(options.port ?? 0, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null && 'port' in address ? address.port : options.port ?? 0;
    logger.info('Events API server listening', { port });
  });
  return server;
}
