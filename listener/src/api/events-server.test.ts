import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import crypto from 'crypto';
import { createEventsServer, checkStellarRpc, checkDiscord } from './events-server';
import { eventRegistry } from '../store/event-registry';
import { NotificationAnalyticsAggregator } from '../services/notification-analytics-aggregator';
import { NotificationMetricsStore } from '../services/notification-metrics-store';
import { NotificationType } from '../types/scheduled-notification';
import { Database, getDatabase, resetDatabaseSingleton } from '../database/database';

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn(),
      simulateTransaction: jest.fn(),
      getAccount: jest.fn().mockRejectedValue(new Error('not found') as never),
    })),
    isSuccessfulSim: jest.fn(),
  },
  Keypair: { random: jest.fn(() => ({ publicKey: () => 'GAXXX' })) },
  Account: jest.fn(),
  Contract: jest.fn(() => ({ call: jest.fn() })),
  TransactionBuilder: jest.fn(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: '100',
  scValToNative: jest.fn(),
}), { virtual: true });
import { preferenceStore } from '../store/preference-store';

jest.mock('../store/preference-store', () => {
  const store = {
    get: jest.fn(),
    update: jest.fn(),
    isCategoryEnabled: jest.fn(),
  };
  return { preferenceStore: store };
});

jest.mock('../store/event-registry', () => ({
  eventRegistry: { getEvents: jest.fn(() => []), count: jest.fn(() => 0) },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  sanitizeUrl: jest.fn((url: string) => url),
}));

const mockStore = preferenceStore as jest.Mocked<typeof preferenceStore>;

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Preference API endpoints', () => {
  let server: http.Server;

  beforeEach((done) => {
    jest.clearAllMocks();
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  describe('GET /api/preferences/:userId', () => {
    it('returns preferences for the given user', async () => {
      const prefs = { userId: 'alice', categories: { discord: true }, updatedAt: 1000 };
      mockStore.get.mockReturnValue(prefs);

      const res = await request(server, 'GET', '/api/preferences/alice');

      expect(res.status).toBe(200);
      expect((res.body as any).success).toBe(true);
      expect((res.body as any).data).toEqual(prefs);
      expect(mockStore.get).toHaveBeenCalledWith('alice');
    });
  });

  describe('PUT /api/preferences/:userId', () => {
    it('updates and returns preferences', async () => {
      const updated = { userId: 'alice', categories: { discord: false }, updatedAt: 2000 };
      mockStore.update.mockReturnValue(updated);

      const res = await request(server, 'PUT', '/api/preferences/alice', {
        categories: { discord: false },
      });

      expect(res.status).toBe(200);
      expect((res.body as any).success).toBe(true);
      expect((res.body as any).data).toEqual(updated);
      expect(mockStore.update).toHaveBeenCalledWith('alice', { categories: { discord: false } });
    });

    it('returns 400 for invalid JSON body', async () => {
      const port = (server.address() as { port: number }).port;
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/api/preferences/alice', method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Content-Length': 8 } },
          (r) => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode! }));
          }
        );
        req.on('error', reject);
        req.write('not-json');
        req.end();
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when categories field is missing', async () => {
      const res = await request(server, 'PUT', '/api/preferences/alice', { foo: 'bar' });
      expect(res.status).toBe(400);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unrecognised paths', async () => {
      const res = await request(server, 'GET', '/api/unknown');
      expect(res.status).toBe(404);
    });
  });
});

describe('GET /health', () => {
  let server: http.Server;

  beforeEach((done) => {
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'https://rpc.example.test',
      stellarNetwork: 'testnet',
      stellarNetworkPassphrase: 'secret passphrase',
      discordWebhookUrl: 'https://discord.example.test/webhook/secret',
      contractAddresses: [],
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  it('returns the configured network without exposing sensitive configuration', async () => {
    const res = await request(server, 'GET', '/health');
    const body = res.body as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.network).toBe('testnet');
    expect(body).not.toHaveProperty('stellarNetworkPassphrase');
    expect(JSON.stringify(body)).not.toContain('secret passphrase');
    expect(JSON.stringify(body)).not.toContain('rpc.example.test');
    expect(JSON.stringify(body)).not.toContain('discord.example.test');
    expect(body).toEqual(expect.objectContaining({ status: 'ok', timestamp: expect.any(String), services: expect.any(Object) }));
  });
});

function computeSignatureLegacy(payload: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${sig}`;
}

function computeSignatureBound(payload: string, secret: string, timestamp: string): string {
  const signingInput = `${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  return `sha256=${sig}`;
}

function makePostRequest(
  server: http.Server,
  path: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function startServer(options: any): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = createEventsServer(options);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

const BASE_OPTIONS = {
  port: 0,
  stellarRpcUrl: 'https://test',
  stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
  contractAddresses: []
};

describe('POST /api/webhooks', () => {
  let server: http.Server;
  const secrets = [
    { id: 'key-1', secret: 'whsec_test_secret' },
    { id: 'key-2', secret: 'whsec_other_secret' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('accepts a webhook with a valid timestamp-bound signature', async () => {
    const payload = JSON.stringify({ event: 'test', data: { foo: 'bar' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeSignatureBound(payload, 'whsec_test_secret', timestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': timestamp,
    });

    expect(status).toBe(202);
    expect((body as any).status).toBe('accepted');
    expect((body as any).verified).toBe(true);
  });

  it('rejects a legacy signature when a timestamp IS provided (anti-replay: timestamp binding)', async () => {
    // Attacker takes a captured legacy signature (no timestamp) and sends it with a
    // fresh timestamp header, hoping the server will skip binding. Must reject.
    const payload = JSON.stringify({ event: 'test' });
    const legacySignature = computeSignatureLegacy(payload, 'whsec_test_secret');
    const freshTimestamp = Math.floor(Date.now() / 1000).toString();

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': legacySignature,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': freshTimestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_INVALID_SIGNATURE');
    expect((body as any).success).toBe(false);
  });

  it('rejects a timestamp-bound signature when the timestamp header is removed (anti-replay)', async () => {
    // Attacker captures a request with a bound signature, then strips the
    // timestamp header in order to bypass expiration + reuse it later.
    // Must reject because signing-input no longer matches.
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const boundSignature = computeSignatureBound(payload, 'whsec_test_secret', timestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': boundSignature,
      'X-Webhook-Key-Id': 'key-1',
      // Deliberately no timestamp header
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('rejects a webhook with an expired timestamp', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString(); // 10 minutes old
    const signature = computeSignatureBound(payload, 'whsec_test_secret', oldTimestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': oldTimestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('rejects a webhook with a forged timestamp (signed for ts=A, header claims ts=B)', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const realTs = Math.floor(Date.now() / 1000).toString();
    const forgedTs = (parseInt(realTs, 10) + 5).toString();
    const signatureForRealTs = computeSignatureBound(payload, 'whsec_test_secret', realTs);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signatureForRealTs,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': forgedTs,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('rejects a webhook with an invalid signature (wrong secret)', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeSignatureBound(payload, 'WRONG_SECRET', timestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': timestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_INVALID_SIGNATURE');
    expect((body as any).success).toBe(false);
    expect((body as any).error.message).toBe('Invalid signature');
  });

  it('rejects when signature header is missing', async () => {
    const payload = JSON.stringify({ event: 'test' });

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Key-Id': 'key-1',
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_MISSING_SIGNATURE');
    expect((body as any).success).toBe(false);
    expect((body as any).error.message).toBe('Missing signature header');
  });

  it('rejects when key-id header is missing', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeSignatureBound(payload, 'whsec_test_secret', timestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Timestamp': timestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_MISSING_KEY_ID');
    expect((body as any).success).toBe(false);
    expect((body as any).error.message).toBe('Missing key-id header');
  });

  it('rejects when key-id is unknown', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeSignatureBound(payload, 'whsec_test_secret', timestamp);

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': 'unknown-key',
      'X-Webhook-Timestamp': timestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_UNKNOWN_KEY_ID');
    expect((body as any).success).toBe(false);
    expect((body as any).error.message).toBe('Unknown key-id');
  });

  it('rejects when no webhook secrets are configured', async () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeSignatureBound(payload, 'whsec_test_secret', timestamp);

    server = await startServer(BASE_OPTIONS);
    const { status, body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': 'key-1',
      'X-Webhook-Timestamp': timestamp,
    });

    expect(status).toBe(401);
    expect((body as any).code).toBe('AUTH_UNKNOWN_KEY_ID');
  });

  it('logs authentication failures with structured context', async () => {
    const logger = (await import('../utils/logger')).default;
    const payload = JSON.stringify({ event: 'test' });

    server = await startServer({ ...BASE_OPTIONS, webhookSecrets: secrets });
    const { body } = await makePostRequest(server, '/api/webhooks', payload, {
      'X-Webhook-Key-Id': 'key-1',
    });

    expect(logger.warn).toHaveBeenCalled();
    expect((body as any).success).toBe(false);
    expect((body as any).error.message).toBe('Missing signature header');
  });

  it('returns 404 for POST to other paths', async () => {
    const payload = JSON.stringify({ event: 'test' });

    server = await startServer(BASE_OPTIONS);
    const { status, body } = await makePostRequest(server, '/api/events', payload, {});

    expect(status).toBe(404);
  });
});

describe('GET /api/analytics', () => {
  let server: http.Server;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = null as unknown as http.Server;
    }
  });

  it('returns an empty snapshot when no records are recorded', async () => {
    const aggregator = new NotificationAnalyticsAggregator();
    aggregator.reset();
    server = await startServer({ ...BASE_OPTIONS, analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/analytics');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    const data = (res.body as any).data as Record<string, unknown>;
    expect(data.totalRecorded).toBe(0);
    expect(data.windowStart).toBeDefined();
    expect(data.windowEnd).toBeDefined();
    expect(data.overall).toBeDefined();
    expect(data.byType).toEqual([]);
    expect(data.byContract).toEqual([]);
    expect(Array.isArray(data.hourlyBuckets)).toBe(true);
    expect((data.hourlyBuckets as unknown[]).length).toBeGreaterThan(0);
    for (const bucket of data.hourlyBuckets as Array<{ total: number; success: number; failure: number }>) {
      expect(bucket.total).toBe(0);
      expect(bucket.success).toBe(0);
      expect(bucket.failure).toBe(0);
    }
    expect(data.errorBreakdown).toEqual({});
  });

  it('returns aggregated metrics from recorded outcomes', async () => {
    const aggregator = new NotificationAnalyticsAggregator({ bucketSizeMs: 60_000 });
    aggregator.reset();
    const now = Date.now();
    const baseTs = now;
    aggregator.record({ notificationType: NotificationType.DISCORD, contractAddress: 'CABC', outcome: 'success', durationMs: 120, timestamp: baseTs });
    aggregator.record({ notificationType: NotificationType.DISCORD, contractAddress: 'CABC', outcome: 'failure', durationMs: 240, errorReason: 'HTTP 500', timestamp: baseTs + 1000 });
    aggregator.record({ notificationType: NotificationType.WEBHOOK, outcome: 'retry', durationMs: 0, timestamp: baseTs + 2000 });
    server = await startServer({ ...BASE_OPTIONS, analyticsAggregator: aggregator });

    const res = await request(server, 'GET', '/api/analytics');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    const data = (res.body as any).data as Record<string, any>;
    expect(data.totalRecorded).toBe(3);
    expect(data.byType.length).toBeGreaterThan(0);
    const discordRow = data.byType.find((r: any) => r.notificationType === NotificationType.DISCORD);
    expect(discordRow).toBeDefined();
    expect(discordRow.total).toBe(2);
    expect(discordRow.success).toBe(1);
    expect(discordRow.failure).toBe(1);
    expect(discordRow.successRate).toBeCloseTo(0.5);
    const contractRow = data.byContract.find((r: any) => r.contractAddress === 'CABC');
    expect(contractRow).toBeDefined();
    expect(contractRow.total).toBe(2);
    expect(data.errorBreakdown['HTTP 500']).toBe(1);
  });

  it('clears aggregator state when reset=true is supplied', async () => {
    const aggregator = new NotificationAnalyticsAggregator();
    aggregator.reset();
    aggregator.record({ notificationType: NotificationType.DISCORD, outcome: 'success', durationMs: 50, timestamp: Date.now() });
    server = await startServer({ ...BASE_OPTIONS, analyticsAggregator: aggregator });

    const first = await request(server, 'GET', '/api/analytics');
    expect((first.body as any).data.totalRecorded).toBe(1);

    const reset = await request(server, 'GET', '/api/analytics?reset=true');
    expect(reset.status).toBe(200);
    expect((reset.body as any).data.totalRecorded).toBe(1); // snapshot returned BEFORE reset

    const after = await request(server, 'GET', '/api/analytics');
    expect((after.body as any).data.totalRecorded).toBe(0);
  });

  it('returns persisted historical snapshots via /api/analytics/history', async () => {
    const aggregator = new NotificationAnalyticsAggregator();
    aggregator.reset();
    const getHistory = jest.fn() as jest.MockedFunction<NotificationMetricsStore['getHistory']>;
    getHistory.mockResolvedValue([
      { id: 1, capturedAt: '2026-06-26T00:00:00.000Z', snapshot: aggregator.snapshot() },
    ]);
    const metricsStore = { getHistory } as unknown as NotificationMetricsStore;

    server = await startServer({ ...BASE_OPTIONS, analyticsAggregator: aggregator, metricsStore });

    const res = await request(server, 'GET', '/api/analytics/history?limit=10');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data.snapshots).toHaveLength(1);
    expect(getHistory).toHaveBeenCalledWith(10, undefined);
  });
});

describe('POST /api/notifications/validate-batch', () => {
  let server: http.Server;

  beforeEach((done) => {
    jest.clearAllMocks();
    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  it('accepts a valid notification batch', async () => {
    const res = await request(server, 'POST', '/api/notifications/validate-batch', [
      { id: 'n1', recipient: 'user_a', channel: 'discord', message: 'Hello' },
      { id: 'n2', recipient: 'user_b', channel: 'webhook', message: 'Hi' },
    ]);

    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data).toMatchObject({ valid: true, processedCount: 2, errors: [] });
  });

  it('rejects batches with duplicate recipients and missing fields', async () => {
    const res = await request(server, 'POST', '/api/notifications/validate-batch', [
      { id: 'n1', recipient: 'user_a', channel: 'discord', message: 'Hello' },
      { id: 'n2', recipient: 'user_a', channel: 'webhook', message: 'Duplicate' },
      { id: '', recipient: '', channel: 'email', message: '' },
    ]);

    expect(res.status).toBe(400);
    const data = (res.body as any).data as { valid: boolean; errors: Array<{ code: string }> };
    expect(data.valid).toBe(false);
    expect(data.errors.some((e) => e.code === 'DUPLICATE_RECIPIENT')).toBe(true);
    expect(data.errors.some((e) => e.code === 'MISSING_FIELD' || e.code === 'EMPTY_FIELD')).toBe(true);
  });
});

class InMemoryIdempotencyRepo {
  private store = new Map<
    string,
    { requestHash: string; response: any; notificationId: number; expiresAt: number }
  >();

  getCachedResponse(idempotencyKey: string) {
    const entry = this.store.get(idempotencyKey);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(idempotencyKey);
      return null;
    }
    return {
      notificationId: entry.notificationId,
      isDuplicate: true,
      response: entry.response,
    };
  }

  validateRequestHash(idempotencyKey: string, requestBody: any) {
    const entry = this.store.get(idempotencyKey);
    if (!entry) return true;
    const currentHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex');
    return currentHash === entry.requestHash;
  }

  storeResponse(
    idempotencyKey: string,
    requestBody: any,
    notificationId: number,
    response: any,
    expirationMinutes: number = 24 * 60
  ) {
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex');
    this.store.set(idempotencyKey, {
      requestHash,
      response,
      notificationId,
      expiresAt: Date.now() + expirationMinutes * 60 * 1000,
    });
    return Promise.resolve(1);
  }

  cleanupExpiredKeys() {
    let count = 0;
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt < now) {
        this.store.delete(k);
        count++;
      }
    }
    return Promise.resolve(count);
  }

  getStats() {
    return Promise.resolve({
      total: this.store.size,
      processed: this.store.size,
      expired: 0,
      oldestKey: this.store.size > 0 ? this.store.keys().next().value : null,
    });
  }
}

describe('REPLAY ATTACK PROTECTION — /api/webhooks with Idempotency-Key', () => {
  const secrets = [{ id: 'key-replay', secret: 'whsec_replay_abc' }];

  function buildIdempotencyService() {
    const { IdempotencyKeyService } = require('../services/idempotency-key-service');
    const repo = new InMemoryIdempotencyRepo();
    return {
      service: new IdempotencyKeyService(repo as any),
      repo,
    };
  }

  it('REPLAY #1 — exact same request sent twice returns cached response on second call (200 not 202)', async () => {
    const { service } = buildIdempotencyService();
    const server = await startServer({
      ...BASE_OPTIONS,
      webhookSecrets: secrets,
      idempotencyService: service,
    });
    try {
      const body = JSON.stringify({ event: 'delivery', notificationId: 'n-100' });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = computeSignatureBound(body, secrets[0].secret, ts);
      const idemKey = 'idem-abc-0001';

      const first = await makePostRequest(server, '/api/webhooks', body, {
        'X-Webhook-Signature': sig,
        'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts,
        'Idempotency-Key': idemKey,
      });

      expect(first.status).toBe(202);
      expect((first.body as any).replay).toBe(false);
      expect((first.body as any).verified).toBe(true);

      const second = await makePostRequest(server, '/api/webhooks', body, {
        'X-Webhook-Signature': sig,
        'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts,
        'Idempotency-Key': idemKey,
      });

      expect(second.status).toBe(200);
      expect((second.body as any).replay).toBe(true);
      expect((second.body as any).status).toBe('accepted');
    } finally {
      await closeServer(server);
    }
  });

  it('REPLAY #2 — same Idempotency-Key with DIFFERENT body → 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    const { service } = buildIdempotencyService();
    const server = await startServer({
      ...BASE_OPTIONS,
      webhookSecrets: secrets,
      idempotencyService: service,
    });
    try {
      const body1 = JSON.stringify({ action: 'send', to: 'alice', amount: 10 });
      const body2 = JSON.stringify({ action: 'send', to: 'attacker', amount: 1000000 });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig1 = computeSignatureBound(body1, secrets[0].secret, ts);
      const sig2 = computeSignatureBound(body2, secrets[0].secret, ts);
      const idemKey = 'idem-conflict-0002';

      const first = await makePostRequest(server, '/api/webhooks', body1, {
        'X-Webhook-Signature': sig1,
        'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts,
        'Idempotency-Key': idemKey,
      });
      expect(first.status).toBe(202);

      const second = await makePostRequest(server, '/api/webhooks', body2, {
        'X-Webhook-Signature': sig2,
        'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts,
        'Idempotency-Key': idemKey,
      });

      expect(second.status).toBe(409);
      expect((second.body as any).code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    } finally {
      await closeServer(server);
    }
  });

  it('REPLAY #3 — three identical requests → #1=202, #2=200(replay), #3=200(replay)', async () => {
    const { service } = buildIdempotencyService();
    const server = await startServer({
      ...BASE_OPTIONS,
      webhookSecrets: secrets,
      idempotencyService: service,
    });
    try {
      const body = JSON.stringify({ event: 'keepalive', id: 'x-9' });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = computeSignatureBound(body, secrets[0].secret, ts);
      const idemKey = 'idem-triple-0003';

      const r1 = await makePostRequest(server, '/api/webhooks', body, {
        'X-Webhook-Signature': sig, 'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts, 'Idempotency-Key': idemKey,
      });
      const r2 = await makePostRequest(server, '/api/webhooks', body, {
        'X-Webhook-Signature': sig, 'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts, 'Idempotency-Key': idemKey,
      });
      const r3 = await makePostRequest(server, '/api/webhooks', body, {
        'X-Webhook-Signature': sig, 'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': ts, 'Idempotency-Key': idemKey,
      });

      expect(r1.status).toBe(202);
      expect((r1.body as any).replay).toBe(false);
      expect(r2.status).toBe(200);
      expect((r2.body as any).replay).toBe(true);
      expect(r3.status).toBe(200);
      expect((r3.body as any).replay).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('REPLAY #4 — Layer 2 timestamp binding rejects a captured request replayed without valid signature', async () => {
    const { service } = buildIdempotencyService();
    const server = await startServer({
      ...BASE_OPTIONS,
      webhookSecrets: secrets,
      idempotencyService: service,
    });
    try {
      const capturedBody = JSON.stringify({ event: 'original' });
      const capturedTs = (Math.floor(Date.now() / 1000) - 1000).toString(); // 1000s old
      const capturedSig = computeSignatureBound(capturedBody, secrets[0].secret, capturedTs);

      // Replay the captured request — Layer 2 (timestamp expiry) must reject it
      // BEFORE idempotency is even consulted.
      const replay = await makePostRequest(server, '/api/webhooks', capturedBody, {
        'X-Webhook-Signature': capturedSig,
        'X-Webhook-Key-Id': secrets[0].id,
        'X-Webhook-Timestamp': capturedTs,
        'Idempotency-Key': 'any-key-wont-matter',
      });

      expect(replay.status).toBe(401);
      expect((replay.body as any).code).toBe('AUTH_TIMESTAMP_EXPIRED');
    } finally {
      await closeServer(server);
    }
  });
});

describe('GET /api/search/suggestions API', () => {
  let server: http.Server;
  let db: Database;

  beforeEach(async () => {
    await resetDatabaseSingleton();
    db = getDatabase(':memory:');
    await db.initialize();

    await db.run('DELETE FROM processed_events');
    await db.run('DELETE FROM scheduled_notifications');
    await db.run('DELETE FROM notification_templates');

    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await resetDatabaseSingleton();
  });

  it('returns suggestions successfully from the API', async () => {
    await db.run(
      `INSERT INTO scheduled_notifications 
       (payload, notification_type, target_recipient, execute_at, contract_address)
       VALUES (?, ?, ?, ?, ?)`,
      [JSON.stringify({}), 'discord', 'test-user-recipient', '2026-06-24T12:00:00Z', 'C-Address']
    );

    const res = await request(server, 'GET', '/api/search/suggestions?q=test');
    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    expect((res.body as any).data).toHaveProperty('recipients');
    expect((res.body as any).data.recipients).toContain('test-user-recipient');
  });

  it('supports limit query parameter', async () => {
    for (let i = 1; i <= 5; i++) {
      await db.run(
        `INSERT INTO scheduled_notifications 
         (payload, notification_type, target_recipient, execute_at)
         VALUES (?, ?, ?, ?)`,
        [JSON.stringify({}), 'discord', `user-${i}`, '2026-06-24T12:00:00Z']
      );
    }

    const res = await request(server, 'GET', '/api/search/suggestions?q=user&limit=2');
    expect(res.status).toBe(200);
    expect((res.body as any).data.recipients.length).toBe(2);
  });
});
