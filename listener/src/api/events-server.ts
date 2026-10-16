import http from 'http';
import * as StellarSDK from '@stellar/stellar-sdk';
import { eventRegistry } from '../store/event-registry';
import { preferenceStore } from '../store/preference-store';
import { PreferencesUpdateInput } from '../types/preferences';
import { NotificationAPI } from '../services/notification-api';
import { NotificationType } from '../types/scheduled-notification';
import logger from '../utils/logger';
import { generateRequestId, resolveCorrelationId } from '../utils/request-id';
import { TemplateService } from '../services/template-service';
import { handleTemplateRoutes } from './template-routes';
import { sendOk, sendErr, sendJson, ErrorCode } from '../utils/response';
import { handleApiError, ApiError } from './error-handler';
import { applyRequestContext } from '../utils/request-id';
import { TemplateService } from '../services/template-service';
import { handleTemplateRoutes } from './template-routes';
import { NotificationHistoryService } from '../services/notification-history';
import { SearchSuggestionService } from '../services/search-suggestion';
import { NotificationSearchService } from '../services/notification-search-service';
import {
  verifySignature,
  extractSignature,
  extractKeyId,
  getSecretForKey,
  collectRawBody,
  extractTimestamp,
  verifyWebhookRequest,
} from '../services/webhook-verifier';
import { WebhookSecret, RateLimitConfig, ContractConfig } from '../types';
import { RateLimiter } from './rate-limiter';
import {
  normaliseApiPath,
  applyVersionHeaders,
  buildVersionCatalog,
} from './api-version-registry';
import { getDatabase } from '../database/database';
import {
  getNotificationAnalyticsAggregator,
  NotificationAnalyticsAggregator,
} from '../services/notification-analytics-aggregator';
import { NotificationTemplateService } from '../services/notification-template-service';
import {
  TemplateNotFoundError,
  TemplateValidationError,
} from '../services/notification-template-repository';
import {
  TemplateRenderError,
} from '../services/notification-template-service';
import {
  parseTemplateUpdateBody,
  resolveRequestActor,
  serializeAuditRecord,
  serializeTemplate,
} from './template-api';
import { CreateNotificationTemplateInputOld } from '../types/notification-template';
import { BatchValidationService } from '../services/batch-validation-service';
import { handleArchiveRequest } from './archive-api';
import { ArchiveStore } from '../services/archive-store';
import { ArchiveService } from '../services/archive-service';
import { NotificationMetricsStore } from '../services/notification-metrics-store';
import { NotificationHealthMonitor } from '../services/notification-health-monitor';
import { getJobMonitor } from '../services/job-monitor';
import { NotificationImportService } from '../services/notification-import-service';
import { ResponseTimeMiddleware } from '../middleware/response-time';

export interface EventsServerOptions {
  port: number;
  corsOrigin?: string;
  stellarRpcUrl: string;
  stellarNetworkPassphrase?: string;
  contractAddresses?: ContractConfig[];
  discordWebhookUrl?: string;
  webhookSecrets?: WebhookSecret[];
  apiKeys?: Array<{ key: string; name?: string }>;
  notificationAPI?: NotificationAPI | null;
  templateService?: NotificationTemplateService | null;
  /** Scheduler-scoped template service, used to render templates for scheduled notifications. */
  schedulerTemplateService?: TemplateService | null;
  rateLimit?: RateLimitConfig;
  /**
   * Optional override for the analytics aggregator. Tests use this to inject
   * a controlled instance and reset state between cases. When omitted, the
   * process-wide default aggregator is used.
   */
  analyticsAggregator?: NotificationAnalyticsAggregator | null;
  /** Archive store for retrieval endpoints (optional). */
  archiveStore?: ArchiveStore | null;
  /** Archive service for the admin /run endpoint (optional). */
  archiveService?: ArchiveService | null;
  /** Persisted metrics snapshots for historical analytics (optional). */
  metricsStore?: NotificationMetricsStore | null;
  /** Maximum age of signed requests in seconds (default: 300 = 5 minutes). */
  signatureExpirationSeconds?: number;
  /** Optional health monitor — exposes its last report at GET /api/notifications/health. */
  healthMonitor?: NotificationHealthMonitor | null;
  /**
   * Requests slower than this threshold (ms) are logged at WARN level (#491).
   * Defaults to 1 000 ms.
   */
  slowRequestThresholdMs?: number;
  /**
   * Override the ResponseTimeMiddleware instance — primarily for testing.
   * When omitted a new instance is created using `slowRequestThresholdMs`.
   */
  responseTimeMiddleware?: ResponseTimeMiddleware | null;
}

type ServiceStatus = 'ok' | 'error' | 'not_configured';

interface ServiceHealth {
  status: ServiceStatus;
  latencyMs?: number;
  detail?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  services: {
    stellarRpc: ServiceHealth;
    discord: ServiceHealth;
    database: ServiceHealth;
    eventRegistry: { status: ServiceStatus; eventCount: number };
  };
}

const HEALTH_TIMEOUT_MS = 5000;
const NETWORK_TIP_CACHE_TTL_MS = 2000;

type IndexingStatus = 'synced' | 'syncing' | 'degraded';

interface IndexingHealthResponse {
  status: IndexingStatus;
  timestamp: string;
  indexedLedger: number | null;
  networkTipLedger: number | null;
  ledgerLag: number | null;
  /**
   * Time since the last event was ingested into the in-memory registry.
   * This serves as a lightweight proxy for ingestion latency / pipeline stalls.
   */
  processingDelayMs: number | null;
  lastIngestedAt: string | null;
  detail?: string;
}

let cachedNetworkTip:
  | { fetchedAt: number; ledger: number | null; errorDetail?: string }
  | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('Health check timed out')), ms);
      if (t && typeof (t as any).unref === 'function') (t as any).unref();
    }),
  ]);
}

export async function checkStellarRpc(rpcUrl: string): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const server = new StellarSDK.rpc.Server(rpcUrl);
    await withTimeout(server.getHealth(), HEALTH_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkDiscord(webhookUrl: string): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const response = await withTimeout(
      fetch(webhookUrl, { method: 'GET' }),
      HEALTH_TIMEOUT_MS
    );
    if (response.ok) {
      return { status: 'ok', latencyMs: Date.now() - start };
    }
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      detail: `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkDatabase(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const db = getDatabase();
    if (!db.isConnected()) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        detail: 'Database not initialized',
      };
    }
    await withTimeout(db.get('SELECT 1 AS ok'), HEALTH_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getContractPauseStatus(
  contractAddress: string,
  stellarRpcUrl: string
): Promise<{ paused: boolean; error?: string }> {
  try {
    const server = new StellarSDK.rpc.Server(stellarRpcUrl);
    const contract = new StellarSDK.Contract(contractAddress);

    // Create a dummy account for simulation (we don't need to actually sign anything)
    const dummyKeypair = StellarSDK.Keypair.random();
    const sourceAccount = await server.getAccount(dummyKeypair.publicKey()).catch(() => {
      // If the dummy account doesn't exist, we can still simulate
      return new StellarSDK.Account(dummyKeypair.publicKey(), '0');
    });

    const tx = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: 'Test SDF Network ; September 2015', // We just need this for simulation
    })
      .addOperation(contract.call('get_paused_status'))
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);

    // Check if simulation was successful by looking for error property
    if ('error' in simulation && simulation.error) {
      const errorMsg = typeof simulation.error === 'object' && 'message' in simulation.error
        ? (simulation.error as any).message
        : 'Failed to simulate contract call';
      return {
        paused: false,
        error: errorMsg
      };
    }

    // At this point, simulation is successful and has a result property
    const simResult = (simulation as any).result;
    const value = StellarSDK.scValToNative(simResult.retval);
    return { paused: !!value };
  } catch (err) {
    return {
      paused: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

async function buildStatusResponse(options: EventsServerOptions): Promise<{
  contracts: Array<{
    address: string;
    paused: boolean;
    error?: string;
  }>;
  timestamp: string;
}> {
  const contractStatuses = await Promise.all(
    (options.contractAddresses ?? []).map(async (contractConfig) => {
      const status = await getContractPauseStatus(contractConfig.address, options.stellarRpcUrl);
      return {
        address: contractConfig.address,
        ...status
      };
    })
  );

  return {
    timestamp: new Date().toISOString(),
    contracts: contractStatuses
  };
}

async function fetchNetworkTipLedger(rpcUrl: string): Promise<{
  ledger: number | null;
  errorDetail?: string;
}> {
  if (
    cachedNetworkTip &&
    Date.now() - cachedNetworkTip.fetchedAt < NETWORK_TIP_CACHE_TTL_MS
  ) {
    return { ledger: cachedNetworkTip.ledger, errorDetail: cachedNetworkTip.errorDetail };
  }

  const start = Date.now();
  try {
    const server = new StellarSDK.rpc.Server(rpcUrl);

    // `getLatestLedger` is the most direct source of the current ledger/tip for Soroban RPC.
    // We keep extraction defensive to avoid hard-coupling to the SDK response shape.
    const latest: any = await withTimeout<any>(
      (server as any).getLatestLedger(),
      HEALTH_TIMEOUT_MS
    );
    const ledger =
      typeof latest?.sequence === 'number'
        ? latest.sequence
        : typeof latest?.ledger === 'number'
          ? latest.ledger
          : typeof latest?.latestLedger === 'number'
            ? latest.latestLedger
            : null;

    cachedNetworkTip = { fetchedAt: Date.now(), ledger };
    return { ledger };
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    cachedNetworkTip = { fetchedAt: Date.now(), ledger: null, errorDetail };
    logger.warn('Failed to fetch network tip ledger', {
      rpcUrl,
      durationMs: Date.now() - start,
      errorDetail,
    });
    return { ledger: null, errorDetail };
  }
}

function deriveIndexingStatus(args: {
  indexedLedger: number | null;
  networkTipLedger: number | null;
  processingDelayMs: number | null;
}): { status: IndexingStatus; detail?: string } {
  const { indexedLedger, networkTipLedger, processingDelayMs } = args;

  if (networkTipLedger === null) {
    return { status: 'degraded', detail: 'Unable to resolve network tip ledger.' };
  }

  if (indexedLedger === null) {
    return { status: 'syncing', detail: 'No events ingested yet.' };
  }

  const ledgerLag = Math.max(0, networkTipLedger - indexedLedger);
  const delay = processingDelayMs ?? Number.POSITIVE_INFINITY;

  if (ledgerLag === 0 && delay <= 60_000) {
    return { status: 'synced' };
  }

  if (ledgerLag <= 5 && delay <= 5 * 60_000) {
    return { status: 'syncing', detail: `Behind by ${ledgerLag} ledger(s).` };
  }

  return {
    status: 'degraded',
    detail: `Behind by ${ledgerLag} ledger(s) and last ingestion was ${Math.round(
      delay / 1000
    )}s ago.`,
  };
}

async function buildHealthResponse(options: EventsServerOptions): Promise<HealthResponse> {
  const [stellarRpc, discord, database] = await Promise.all([
    checkStellarRpc(options.stellarRpcUrl),
    options.discordWebhookUrl
      ? checkDiscord(options.discordWebhookUrl)
      : Promise.resolve<ServiceHealth>({ status: 'not_configured' }),
    checkDatabase(),
  ]);

  const eventRegistryHealth = {
    status: 'ok' as ServiceStatus,
    eventCount: eventRegistry.count(),
  };

  let overallStatus: HealthResponse['status'];
  if (stellarRpc.status === 'error' || database.status === 'error') {
    overallStatus = 'error';
  } else if (discord.status === 'error') {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'ok';
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      stellarRpc,
      discord,
      database,
      eventRegistry: eventRegistryHealth,
    },
  };
}

function isRateLimitExempt(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api/rate-limit/metrics';
}

export function createEventsServer(options: EventsServerOptions): http.Server {
  const corsOrigin = options.corsOrigin ?? 'http://localhost:5173';
  const historyService = new NotificationHistoryService();
  const suggestionService = new SearchSuggestionService();
  const notificationSearchService = new NotificationSearchService();
  const rateLimiter = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;
  // Response-time tracking (#491)
  const responseTime =
    options.responseTimeMiddleware !== undefined && options.responseTimeMiddleware !== null
      ? options.responseTimeMiddleware
      : new ResponseTimeMiddleware({ slowRequestThresholdMs: options.slowRequestThresholdMs });

  const server = http.createServer(async (req, res) => {
    // Correlation-ID middleware: mints a requestId and resolves a correlationId
    // for every request, and stamps both onto the response headers. See
    // listener/src/utils/request-id.ts and LOGGING.md for details.
    const { requestId, correlationId } = applyRequestContext(req, res);
    const startTime = Date.now();

    // Start response-time tracking for this request (#491)
    responseTime.start(res);

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Correlation-Id');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // ── API Route Versioning (#386, #984) ──────────────────────────────────
    // Normalise /api/vN/* → /api/* using the central version registry so that
    // every route handler operates on the canonical path form.  The registry
    // also applies X-API-Version, Deprecation, Sunset, and Link headers
    // automatically based on the ROUTE_CATALOG lifecycle status.
    {
      const { normalisedPath } = normaliseApiPath(url.pathname);
      url.pathname = normalisedPath;
    }
    applyVersionHeaders(req.method ?? 'GET', url.pathname, res);

    // The rate-limit metrics endpoint is an observability route and must stay
    // reachable even after a client exhausts its quota — otherwise callers
    // can't read the very metrics that explain why they are being throttled.
    const isRateLimitExempt =
      req.method === 'GET' && (pathname === '/api/rate-limit/metrics' || pathname === '/health');

    if (rateLimiter && !isRateLimitExempt) {
      const allowed = await rateLimiter.handle(req, res as any);
      if (!allowed) return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Template API routes (handled first for priority)
    // Note: route matching is handled inline below for NotificationTemplateService compatibility.
    // url.pathname is already rewritten from /api/v1/* → /api/* above
    if (options.schedulerTemplateService && url.pathname.startsWith('/api/templates')) {
      handleTemplateRoutes(req, res, requestId, options.schedulerTemplateService)
        .then((handled) => {
          if (!handled) {
            sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
          }
        })
        .catch((error) => {
          logger.error('Template route handler error', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        });
      return;
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      buildHealthResponse(options).then((health) => {
        const httpStatus = health.status === 'error' ? 503 : 200;
        sendJson(res, httpStatus, health);
      }).catch((err) => {
        logger.error('Health check failed unexpectedly', { error: err, requestId, correlationId });
        sendErr(res, 500, 'Internal health check failure', ErrorCode.INTERNAL_ERROR);
      });
      return;
    }

    // GET /api/status
    if (req.method === 'GET' && url.pathname === '/api/status') {
      buildStatusResponse(options).then((status) => {
        sendOk(res, 200, status);
      }).catch((err) => {
        logger.error('Status check failed unexpectedly', { error: err, requestId, correlationId });
        sendErr(res, 500, 'Internal status check failure', ErrorCode.INTERNAL_ERROR);
      });
      return;
    }

    // GET /api/version — version catalog and deprecation registry (#984)
    if (req.method === 'GET' && url.pathname === '/api/version') {
      sendOk(res, 200, buildVersionCatalog());
      return;
    }

    // GET /api/events
    if (req.method === 'GET' && url.pathname.startsWith('/api/events')) {
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const events =
        limit !== undefined && !Number.isNaN(limit)
          ? eventRegistry.getEvents(limit)
          : eventRegistry.getEvents();

      logger.info('Handling GET /api/events', { requestId, correlationId, limit: limit ?? 'all' });

      sendOk(res, 200, { count: eventRegistry.count(), events });

      logger.info('GET /api/events complete', {
        requestId,
        correlationId,
        returned: events.length,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // GET /api/indexing/health
    if (req.method === 'GET' && url.pathname === '/api/indexing/health') {
      const networkTip = await fetchNetworkTipLedger(options.stellarRpcUrl);
      const ingestion = eventRegistry.getIngestionSnapshot();

      const now = Date.now();
      const processingDelayMs =
        ingestion.lastIngestedAt === null ? null : Math.max(0, now - ingestion.lastIngestedAt);

      const indexedLedger = ingestion.lastIngestedLedger;
      const networkTipLedger = networkTip.ledger;
      const ledgerLag =
        indexedLedger === null || networkTipLedger === null
          ? null
          : Math.max(0, networkTipLedger - indexedLedger);

      const derived = deriveIndexingStatus({ indexedLedger, networkTipLedger, processingDelayMs });

      const response: IndexingHealthResponse = {
        status: derived.status,
        timestamp: new Date().toISOString(),
        indexedLedger,
        networkTipLedger,
        ledgerLag,
        processingDelayMs,
        lastIngestedAt: ingestion.lastIngestedAt ? new Date(ingestion.lastIngestedAt).toISOString() : null,
        detail: derived.detail ?? networkTip.errorDetail,
      };

      sendOk(res, 200, response);
      return;
    }

    // GET /api/analytics
    if (req.method === 'GET' && url.pathname === '/api/analytics') {
      const aggregator =
        options.analyticsAggregator !== undefined
          ? options.analyticsAggregator
          : getNotificationAnalyticsAggregator();

      if (!aggregator) {
        sendErr(res, 503, 'Analytics aggregator unavailable', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const snapshot = aggregator.snapshot();
      const reset = url.searchParams.get('reset') === 'true';

      logger.info('Handling GET /api/analytics', {
        requestId,
        correlationId,
        totalRecorded: snapshot.totalRecorded,
        reset,
        durationMs: Date.now() - startTime,
      });

      sendOk(res, 200, snapshot);

      if (reset) {
        aggregator.reset();
        logger.info('Analytics snapshot reset after read', { requestId, correlationId });
      }
      return;
    }

    // GET /api/analytics/history
    if (req.method === 'GET' && url.pathname === '/api/analytics/history') {
      if (!options.metricsStore) {
        sendErr(res, 503, 'Metrics store unavailable', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }
      const limitParam = url.searchParams.get('limit');
      const sinceParam = url.searchParams.get('since');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const since = sinceParam ? new Date(sinceParam) : undefined;
      options.metricsStore.getHistory(limit, since)
        .then((snapshots) => { sendOk(res, 200, { snapshots }); })
        .catch((error) => {
          logger.error('Failed to fetch metrics history', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/rate-limit/metrics
    if (req.method === 'GET' && url.pathname === '/api/rate-limit/metrics') {
      if (!rateLimiter) {
        sendJson(res, 200, {
          totalRequests: 0,
          blockedRequests: 0,
          allowedRequests: 0,
          uniqueClients: 0,
          topBlockedClients: [],
          startTime: new Date().toISOString(),
        });
        return;
      }
      sendJson(res, 200, rateLimiter.getMetrics());
      return;
    }

    // POST /api/webhooks
    if (req.method === 'POST' && url.pathname === '/api/webhooks') {
      const idempotencyKey = IdempotencyKeyService.extractKey(req.headers) ?? undefined;
      collectRawBody(req).then(async (rawBody) => {
        const sourceIp =
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          (req.socket?.remoteAddress as string | undefined);
      collectRawBody(req).then((rawBody) => {
        const signatureHeader = extractSignature(req.headers);
        const keyId = extractKeyId(req.headers);

        if (!signatureHeader) {
          logger.warn('Webhook missing signature header', { requestId, correlationId });
          sendErr(res, 401, 'Missing signature header', ErrorCode.UNAUTHORIZED);
          return;
        }

        if (!keyId) {
          logger.warn('Webhook missing key-id header', { requestId, correlationId });
          sendErr(res, 401, 'Missing key-id header', ErrorCode.UNAUTHORIZED);
          return;
        }

        const secrets = options.webhookSecrets ?? [];
        const maxAgeSeconds = options.signatureExpirationSeconds ?? 300;

        const auth = verifyWebhookRequest({
          headers: req.headers as Record<string, string | string[] | undefined>,
          rawBody,
          secrets,
          sourceIp,
          requestId,
          correlationId,
          maxAgeSeconds,
        });

        if (!auth.authenticated) {
          res.writeHead(auth.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: auth.message, code: auth.errorCode }));
        if (!secret) {
          logger.warn('Webhook unknown key-id', { requestId, correlationId, keyId });
          sendErr(res, 401, 'Unknown key-id', ErrorCode.UNAUTHORIZED);
          return;
        }

        try {
          const acceptWebhook = async (): Promise<{ status: string; verified: boolean }> => {
            logger.info('Webhook received and signature verified', {
              requestId,
              correlationId,
              keyId: auth.keyId,
              timestampVerified: auth.timestampVerified,
              sourceIp,
              contentLength: rawBody.length,
              idempotencyKey,
            });
            return { status: 'accepted', verified: true };
          };

          if (options.idempotencyService && idempotencyKey) {
            const outcome = await options.idempotencyService.processWithIdempotency(
              idempotencyKey,
              rawBody,
              acceptWebhook,
              { requestId, correlationId }
            );
            const statusCode = outcome.isDuplicate ? 200 : 202;
            res.writeHead(statusCode, {
              'Content-Type': 'application/json',
              'X-Idempotent-Replay': outcome.isDuplicate ? 'true' : 'false',
            });
            res.end(JSON.stringify({
              ...(outcome.result as object),
              replay: outcome.isDuplicate,
            }));
          } else {
            const result = await acceptWebhook();
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          if (err instanceof IdempotencyKeyReuseError) {
            logger.warn('Webhook rejected: idempotency key reused with different body', {
              requestId, correlationId, idempotencyKey,
            });
            res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, code: err.code }));
        if (timestampHeader) {
          const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
          if (!isTimestampValid(timestamp, maxAgeSeconds)) {
            logger.warn('Webhook request signature expired', { requestId, correlationId, keyId, timestamp });
            sendErr(res, 401, 'Request signature expired', ErrorCode.UNAUTHORIZED);
            return;
          }
          throw err;
        }
      }).catch((err) => {
        if (err instanceof IdempotencyKeyReuseError) {
          res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, code: err.code }));
          return;
        }
        logger.error('Failed to read webhook body', { requestId, correlationId, error: err instanceof Error ? err.message : String(err) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read request body', code: 'BODY_READ_FAILED' }));

        if (!verifySignature(rawBody, signatureHeader, secret)) {
          logger.warn('Webhook invalid signature', { requestId, correlationId, keyId });
          sendErr(res, 401, 'Invalid signature', ErrorCode.UNAUTHORIZED);
          return;
        }

        logger.info('Webhook received and verified', { requestId, correlationId, keyId });
        sendOk(res, 202, { status: 'accepted' });
      }).catch((err) => {
        logger.error('Failed to read webhook body', { requestId, correlationId, error: err });
        sendErr(res, 400, 'Failed to read request body', ErrorCode.BAD_REQUEST);
      });
      return;
    }

    // POST /api/notifications/validate-batch
    if (req.method === 'POST' && url.pathname === '/api/notifications/validate-batch') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || 'null');
          const batch = Array.isArray(data) ? data : data?.notifications;
          const validator = new BatchValidationService();
          const result = validator.validate(batch);

          if (!result.valid) {
            sendOk(res, 400, result);
            logger.warn('Batch validation rejected', { requestId, correlationId, errorCount: result.errors.length });
            return;
          }

          sendOk(res, 200, result);
          logger.info('Batch validation passed', { requestId, correlationId, processedCount: result.processedCount });
        } catch (error) {
          logger.error('Failed to validate notification batch', { error, requestId, correlationId });
          sendOk(res, 400, {
            valid: false,
            processedCount: 0,
            errors: [{ index: -1, code: 'PARSE_ERROR', message: 'Request body must be valid JSON.' }],
          });
        }
      });
      return;
    }

    // POST /api/notifications/import — bulk import from JSON or CSV
    if (req.method === 'POST' && url.pathname === '/api/notifications/import') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const apiKeyHeader = req.headers['x-api-key'];
      if (options.apiKeys && options.apiKeys.length > 0) {
        const provided = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
        const allowed = options.apiKeys.some((k) => k.key === provided);
        if (!allowed) {
          sendErr(res, 401, 'Unauthorized', ErrorCode.UNAUTHORIZED);
          return;
        }
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const contentType = req.headers['content-type'] || '';
          const importer = new NotificationImportService(options.notificationAPI!);
          const summary = await importer.importFromBody(body, contentType, { requestId });
          sendOk(res, 200, summary);
          logger.info('Bulk notification import finished', {
            requestId,
            correlationId,
            imported: summary.imported,
            skipped: summary.skipped,
          });
        } catch (error) {
          logger.error('Failed to import notifications', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        }
      });
      return;
    }

    // POST /api/schedule
    if (req.method === 'POST' && url.pathname === '/api/schedule') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const idempotencyKey = IdempotencyKeyService.extractKey(req.headers) ?? undefined;
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);

          if (!data.executeAt || !data.payload || !data.targetRecipient) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: executeAt, payload, targetRecipient', code: 'MISSING_FIELDS' }));
            sendErr(res, 400, 'Missing required fields: executeAt, payload, targetRecipient', ErrorCode.BAD_REQUEST);
            return;
          }

          const executeAt = new Date(data.executeAt);
          if (isNaN(executeAt.getTime())) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'executeAt is not a valid date', code: 'INVALID_DATE' }));
            sendErr(res, 400, 'executeAt is not a valid date', ErrorCode.BAD_REQUEST);
            return;
          }

          const schedule = async (): Promise<{ id: number }> => {
            const notificationId = await options.notificationAPI!.scheduleNotification({
              payload: data.payload,
              notificationType: data.notificationType || NotificationType.DISCORD,
              targetRecipient: data.targetRecipient,
              executeAt,
              maxRetries: data.maxRetries,
              priority: data.priority,
              eventId: data.eventId,
              contractAddress: data.contractAddress,
              metadata: data.metadata,
            });
            logger.info('Notification scheduled via API', {
              requestId, correlationId, notificationId, executeAt: data.executeAt,
            });
            return { id: notificationId };
          };

          if (options.idempotencyService && idempotencyKey) {
            const outcome = await options.idempotencyService.processWithIdempotency(
              idempotencyKey,
              data,
              schedule,
              { requestId, correlationId }
            );
            const statusCode = outcome.isDuplicate ? 200 : 201;
            res.writeHead(statusCode, {
              'Content-Type': 'application/json',
              'X-Idempotent-Replay': outcome.isDuplicate ? 'true' : 'false',
            });
            res.end(JSON.stringify({
              id: (outcome.result as { id: number }).id,
              replay: outcome.isDuplicate,
            }));
            return;
          }

          const { id } = await schedule();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id }));
        } catch (error) {
          if (error instanceof IdempotencyKeyReuseError) {
            logger.warn('Schedule API rejected request: idempotency key body mismatch', {
              requestId, correlationId, idempotencyKey,
            });
            res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message, code: error.code }));
            return;
          }
          logger.error('Failed to schedule notification', {
            error: error instanceof Error ? error.message : String(error),
            requestId, correlationId,
          });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (error as Error).message, code: 'SCHEDULE_FAILED' }));
          sendOk(res, 201, { id: notificationId });
          logger.info('Notification scheduled via API', { requestId, correlationId, notificationId, executeAt: data.executeAt });
        } catch (error) {
          const anyError = error as any;
          if (anyError?.name === 'PayloadTooLargeError') {
            logger.warn('Payload too large', {
              error,
              requestId,
              correlationId,
              payloadSizeBytes: anyError.payloadSizeBytes,
              maxSizeBytes: anyError.maxSizeBytes,
            });
            sendErr(res, 413, anyError.message, ErrorCode.PAYLOAD_TOO_LARGE);
            return;
          }
          logger.error('Failed to schedule notification', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        }
      });
      return;
    }

    // GET /api/schedule/stats
    if (req.method === 'GET' && url.pathname === '/api/schedule/stats') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      options.notificationAPI.getStatistics()
        .then((stats) => { sendOk(res, 200, stats); })
        .catch((error) => {
          logger.error('Failed to get scheduler stats', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/schedule/execution-metrics
    if (req.method === 'GET' && url.pathname === '/api/schedule/execution-metrics') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }
      (options.notificationAPI as any).getExecutionMetrics()
        .then((metrics: unknown) => { sendOk(res, 200, metrics); })
        .catch((error: Error) => {
          logger.error('Failed to get execution metrics', { error, requestId, correlationId });
          sendErr(res, 500, error.message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/schedule/retry-distribution
    if (req.method === 'GET' && url.pathname === '/api/schedule/retry-distribution') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }
      (options.notificationAPI as any).getRetryDistribution()
        .then((distribution: unknown) => { sendOk(res, 200, distribution); })
        .catch((error: Error) => {
          logger.error('Failed to get retry distribution', { error, requestId, correlationId });
          sendErr(res, 500, error.message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/schedule/jobs — background job monitoring snapshot
    if (req.method === 'GET' && url.pathname === '/api/schedule/jobs') {
      const monitor = getJobMonitor();
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 25, 1), 200) : 25;
      sendOk(res, 200, {
        ...monitor.getSnapshot(),
        recentJobs: monitor.listRecentJobs(limit),
        recentFailures: monitor.listFailures(limit),
      });
      return;
    }

    // GET /api/schedule/jobs/failures — failed job log
    if (req.method === 'GET' && url.pathname === '/api/schedule/jobs/failures') {
      const monitor = getJobMonitor();
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : 50;
      sendOk(res, 200, { failures: monitor.listFailures(limit), count: monitor.listFailures(limit).length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/schedule/execution-metrics') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      options.notificationAPI.getExecutionMetrics()
        .then((metrics) => {
          sendOk(res, 200, metrics);
        })
        .catch((error) => {
          logger.error('Failed to get execution metrics', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        });
      return;
    }

    // GET /api/schedule/retry-distribution
    if (req.method === 'GET' && url.pathname === '/api/schedule/retry-distribution') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      options.notificationAPI.getRetryDistribution()
        .then((distribution) => {
          sendOk(res, 200, distribution);
        })
        .catch((error) => {
          logger.error('Failed to get retry distribution', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        });
      return;
    }

    // GET /api/schedule/retry-statistics
    if (req.method === 'GET' && url.pathname === '/api/schedule/retry-statistics') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      options.notificationAPI.getRetryStatistics()
        .then((stats) => {
          sendOk(res, 200, stats);
        })
        .catch((error) => {
          logger.error('Failed to get retry statistics', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        });
      return;
    }

    // GET /api/schedule/queue — queue visibility: list pending jobs
    // Returns jobs currently waiting in the queue with id, type, enqueued
    // time (createdAt), scheduled delivery time (executeAt), priority, and
    // retryCount.  Accepts an optional ?limit= query param (default 100).
    if (req.method === 'GET' && url.pathname === '/api/schedule/queue') {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 100)) : undefined;

      options.notificationAPI.getPendingJobs(limit)
        .then((jobs) => {
          logger.info('Handling GET /api/schedule/queue', {
            requestId,
            correlationId,
            count: jobs.length,
            durationMs: Date.now() - startTime,
          });
          sendOk(res, 200, { count: jobs.length, jobs });
        })
        .catch((error) => {
          logger.error('Failed to get pending jobs', { error, requestId, correlationId });
          handleApiError(res, error, requestId, correlationId);
        });
      return;
    }

    // GET /api/schedule/:id
    if (req.method === 'GET' && url.pathname.startsWith('/api/schedule/')) {
      if (!options.notificationAPI) {
        sendErr(res, 503, 'Scheduler not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const id = parseInt(url.pathname.split('/').pop() || '', 10);
      if (isNaN(id)) {
        sendErr(res, 400, 'Invalid notification ID', ErrorCode.BAD_REQUEST);
        return;
      }

      options.notificationAPI.getNotification(id)
        .then((notification) => {
          if (!notification) {
            sendErr(res, 404, 'Notification not found', ErrorCode.NOT_FOUND);
            return;
          }
          sendOk(res, 200, notification);
        })
        .catch((error) => {
          logger.error('Failed to get notification', { error, requestId, correlationId, id });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    function isValidApiKey(apiKey: string | undefined, allowedKeys: Array<{ key: string; name?: string }> | undefined): boolean {
      if (!allowedKeys || allowedKeys.length === 0) {
        // If no API keys are configured, allow unauthenticated access is allowed (for backward compatibility)
        return true;
      }
      if (!apiKey) {
        return false;
      }
      return allowedKeys.some(k => k.key === apiKey);
    }

    // Get notification delivery history endpoint
    if (req.method === 'GET' && req.url?.startsWith('/api/notifications/history')) {
      const apiKey = req.headers['x-api-key'] as string | undefined;
      if (!isValidApiKey(apiKey, options.apiKeys)) {
        sendErr(res, 401, 'Unauthorized: Invalid or missing API key', ErrorCode.UNAUTHORIZED);
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const offset = url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;
      const cursor = url.searchParams.get('cursor') || undefined;
      const status = url.searchParams.get('status') as 'SUCCESS' | 'FAILED' | 'RETRY' | null;
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');

      logger.info('Handling GET /api/notifications/history', {
        requestId, correlationId, limit, offset, cursor, status, startDate, endDate,
      });

      historyService.getHistory({
        limit, offset, cursor,
        status: status || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      })
        .then((result) => {
          sendJson(res, 200, result);
          logger.info('GET /api/notifications/history complete', {
            requestId, total: result.total, durationMs: Date.now() - startTime,
            requestId,
            correlationId,
            total: result.total,
            durationMs: Date.now() - startTime,
          });
        })
        .catch((error) => {
          logger.error('Failed to retrieve notification history', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/notifications/search
    if (req.method === 'GET' && url.pathname === '/api/notifications/search') {
      const q = url.searchParams.get('q') ?? undefined;
      const sender = url.searchParams.get('sender') ?? undefined;
      const txHash = url.searchParams.get('txHash') ?? undefined;
      const eventId = url.searchParams.get('eventId') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      const type = url.searchParams.get('type') ?? undefined;
      const startDate = url.searchParams.get('startDate') ?? undefined;
      const endDate = url.searchParams.get('endDate') ?? undefined;
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const offset = url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;
      const rawSortBy = url.searchParams.get('sortBy') ?? undefined;
      const sortBy = (rawSortBy === 'oldest' || rawSortBy === 'status') ? rawSortBy : 'newest';

      logger.info('Handling GET /api/notifications/search', {
        requestId,
        correlationId,
        q,
        sender,
        txHash,
        eventId,
        status,
        type,
        startDate,
        endDate,
        limit,
        offset,
        sortBy,
      });

      notificationSearchService.search({ q, sender, txHash, eventId, status, type, startDate, endDate, limit, offset })
      notificationSearchService.search({
        q,
        sender,
        txHash,
        eventId,
        status,
        type,
        startDate,
        endDate,
        limit,
        offset,
        sortBy,
      })
        .then((result) => {
          sendOk(res, 200, result);
          logger.info('GET /api/notifications/search complete', { requestId, total: result.total, durationMs: Date.now() - startTime });
        })
        .catch((error) => {
          logger.error('Failed to search notifications', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/search/suggestions
    if (req.method === 'GET' && url.pathname === '/api/search/suggestions') {
      const q = url.searchParams.get('q') || '';
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;

      logger.info('Handling GET /api/search/suggestions', { requestId, correlationId, q, limit });

      suggestionService.getSuggestions(q, limit)
        .then((result) => {
          sendOk(res, 200, result);
          logger.info('GET /api/search/suggestions complete', {
            requestId,
            correlationId,
            durationMs: Date.now() - startTime,
          });
        })
        .catch((error) => {
          logger.error('Failed to retrieve search suggestions', { error, requestId, correlationId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/templates
    if (req.method === 'GET' && url.pathname === '/api/templates') {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      logger.info('Handling GET /api/templates', { requestId, correlationId });
      (options.templateService as any).listAll()
        .then((templates: any[]) => { sendOk(res, 200, templates.map(serializeTemplate)); })
        .catch((error: Error) => {
          logger.error('Failed to list templates', { error, requestId, correlationId });
          sendErr(res, 500, error.message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/templates/:id/audit
    const templateAuditMatch = url.pathname.match(/^\/api\/templates\/([^/]+)\/audit$/);
    if (req.method === 'GET' && templateAuditMatch) {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const templateId = decodeURIComponent(templateAuditMatch[1]);
      logger.info('Handling GET /api/templates/:id/audit', { requestId, correlationId, templateId });

      (options.templateService as any).getAuditHistory(templateId)
        .then(async (records: any[]) => {
          const template = await (options.templateService as any).getById(templateId);
          if (!template && records.length === 0) {
            sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
            return;
          }
          sendOk(res, 200, { templateId, records: records.map(serializeAuditRecord) });
        })
        .catch((error: Error) => {
          logger.error('Failed to load template audit history', { error, requestId, correlationId, templateId });
          sendErr(res, 500, error.message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // GET /api/templates/:id
    const getTemplateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
    if (req.method === 'GET' && getTemplateMatch) {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const templateId = decodeURIComponent(getTemplateMatch[1]);
      logger.info('Handling GET /api/templates/:id', { requestId, correlationId, templateId });

      (options.templateService as any).getById(templateId)
        .then((template: any) => {
          if (!template) {
            sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
            return;
          }
          sendOk(res, 200, serializeTemplate(template));
        })
        .catch((error: Error) => {
          logger.error('Failed to load template', { error, requestId, correlationId, templateId });
          sendErr(res, 500, error.message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // PUT /api/templates/:id
    if (req.method === 'PUT' && getTemplateMatch) {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const templateId = decodeURIComponent(getTemplateMatch[1]);
      const actor = resolveRequestActor(req);
      logger.info('Handling PUT /api/templates/:id', { requestId, correlationId, templateId, actor });

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body) as unknown;
            const input = parseTemplateUpdateBody(parsed);
            const updated = await (options.templateService as any).update(templateId, input, actor);
            logger.info('PUT /api/templates/:id complete', {
              requestId, correlationId, templateId, actor, durationMs: Date.now() - startTime,
            });
            sendOk(res, 200, serializeTemplate(updated));
          } catch (error) {
            if (error instanceof SyntaxError) {
              sendErr(res, 400, 'Invalid JSON', ErrorCode.PARSE_ERROR);
              return;
            }
            if (error instanceof TemplateNotFoundError) {
              sendErr(res, 404, error.message, ErrorCode.NOT_FOUND);
              return;
            }
            if (error instanceof TemplateValidationError || (error instanceof Error && error.message.startsWith('Invalid body'))) {
              sendErr(res, 400, (error as Error).message, ErrorCode.BAD_REQUEST);
              return;
            }
            logger.error('Failed to update template', { error, requestId, correlationId, templateId, actor });
            sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
          }
        })();
      });
      return;
    }

    // DELETE /api/templates/:id
    const deleteTemplateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteTemplateMatch) {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const templateId = decodeURIComponent(deleteTemplateMatch[1]);
      logger.info('Handling DELETE /api/templates/:id', { requestId, correlationId, templateId });

      (options.templateService as any).delete(templateId)
        .then(() => { sendOk(res, 200, { deleted: true }); })
        .catch((error: any) => {
          if (error instanceof TemplateNotFoundError) {
            sendErr(res, 404, error.message, ErrorCode.NOT_FOUND);
            return;
          }
          logger.error('Failed to delete template', { error, requestId, correlationId, templateId });
          sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
        });
      return;
    }

    // POST /api/templates
    if (req.method === 'POST' && url.pathname === '/api/templates') {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      logger.info('Handling POST /api/templates', { requestId, correlationId });
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body) as CreateNotificationTemplateInputOld;
            if (!parsed?.id || !parsed?.name || !parsed?.type || !parsed?.body) {
              sendErr(res, 400, 'Invalid body: id, name, type, and body are required', ErrorCode.BAD_REQUEST);
              return;
            }

            const created = await (options.templateService as any).create(parsed);
            sendOk(res, 201, serializeTemplate(created));
          } catch (error) {
            if (error instanceof SyntaxError) {
              sendErr(res, 400, 'Invalid JSON', ErrorCode.PARSE_ERROR);
              return;
            }
            if (error instanceof TemplateValidationError) {
              sendErr(res, 400, error.message, ErrorCode.BAD_REQUEST);
              return;
            }
            logger.error('Failed to create template', { error, requestId, correlationId });
            sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
          }
        })();
      });
      return;
    }

    // POST /api/templates/:id/render
    const templateRenderMatch = url.pathname.match(/^\/api\/templates\/([^/]+)\/render$/);
    if (req.method === 'POST' && templateRenderMatch) {
      if (!options.templateService) {
        sendErr(res, 503, 'Template service not enabled', ErrorCode.SERVICE_UNAVAILABLE);
        return;
      }

      const templateId = decodeURIComponent(templateRenderMatch[1]);
      logger.info('Handling POST /api/templates/:id/render', { requestId, correlationId, templateId });

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = body ? JSON.parse(body) as Record<string, string> : {};
            const template = await (options.templateService as any).getById(templateId);
            if (!template) {
              sendErr(res, 404, `Template not found: ${templateId}`, ErrorCode.NOT_FOUND);
              return;
            }
            const rendered = (options.templateService as any).renderTemplate(template, parsed);
            sendOk(res, 200, rendered);
          } catch (error) {
            if (error instanceof SyntaxError) {
              sendErr(res, 400, 'Invalid JSON', ErrorCode.PARSE_ERROR);
              return;
            }
            if (error instanceof TemplateRenderError) {
              sendErr(res, 422, error.message, ErrorCode.UNPROCESSABLE);
              return;
            }
            logger.error('Failed to render template', { error, requestId, correlationId, templateId });
            sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
          }
        })();
      });
      return;
    }

    // GET /api/preferences/:userId
    const getPrefsMatch = url.pathname.match(/^\/api\/preferences\/([^/]+)$/);
    if (req.method === 'GET' && getPrefsMatch) {
      const userId = decodeURIComponent(getPrefsMatch[1]);
      logger.info('Handling GET /api/preferences/:userId', { requestId, correlationId, userId });
      const prefs = preferenceStore.get(userId);
      sendOk(res, 200, prefs);
      return;
    }

    // PUT /api/preferences/:userId
    const putPrefsMatch = url.pathname.match(/^\/api\/preferences\/([^/]+)$/);
    if (req.method === 'PUT' && putPrefsMatch) {
      const userId = decodeURIComponent(putPrefsMatch[1]);
      logger.info('Handling PUT /api/preferences/:userId', { requestId, correlationId, userId });
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const input: PreferencesUpdateInput = JSON.parse(body);
          if (!input || typeof input.categories !== 'object') {
            logger.warn('PUT /api/preferences/:userId invalid body', { requestId, correlationId, userId });
            sendErr(res, 400, 'Invalid body: expected { categories: { [key]: boolean } }', ErrorCode.BAD_REQUEST);
            return;
          }
          const updated = preferenceStore.update(userId, input);
          logger.info('PUT /api/preferences/:userId complete', { requestId, correlationId, userId, durationMs: Date.now() - startTime });
          sendOk(res, 200, updated);
        } catch {
          logger.error('PUT /api/preferences/:userId invalid JSON', { requestId, correlationId, userId });
          sendErr(res, 400, 'Invalid JSON', ErrorCode.PARSE_ERROR);
        }
      });
      return;
    }

    // GET /api/archive, GET /api/archive/:id, POST /api/archive/run
    if (options.archiveStore && (url.pathname === '/api/archive' || url.pathname.startsWith('/api/archive/'))) {
      const handled = await handleArchiveRequest(req, res, {
        store: options.archiveStore,
        service: options.archiveService,
      }, requestId);
      if (handled) return;
    }

// GET /api/metrics/response-time — expose response-time counters (#491)
     if (req.method === 'GET' && url.pathname === '/api/metrics/response-time') {
       const metrics = responseTime.getMetrics();
       const reset = url.searchParams.get('reset') === 'true';
       sendOk(res, 200, metrics);
       if (reset) {
         responseTime.resetMetrics();
         logger.info('Response-time metrics reset', { requestId });
       }
       return;
     }

     logger.warn('Unhandled request', {
       requestId,
       correlationId,
       method: req.method,
       url: req.url,
     });
     sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
     responseTime.finish(req, res, requestId, 404);
  });

  if (rateLimiter) {
    const originalClose = server.close.bind(server);
    server.close = (callback?: (err?: Error) => void) => {
      rateLimiter.destroy();
      return originalClose(callback);
    };
  }

  return server;
}

export function startEventsServer(options: EventsServerOptions): http.Server {
  const server = createEventsServer(options);
  server.listen(options.port, () => {
    logger.info('Events API server listening', { port: options.port });
  });
  return server;
}
