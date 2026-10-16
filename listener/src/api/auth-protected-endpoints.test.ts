/**
 * Authentication behaviour across every protected NotifyChain API endpoint.
 *
 * Protected endpoints and their schemes:
 *   - GET  /api/notifications/history   — X-API-Key
 *   - POST /api/notifications/import    — X-API-Key
 *   - POST /api/webhooks                — HMAC-SHA256 signature + timestamp
 *
 * Each scheme is exercised for: missing credentials, invalid credentials,
 * expired credentials, valid credentials and other unauthorized access
 * attempts (credential in the wrong place, tampering, replay, etc.).
 */
import http from 'http';
import { createEventsServer, EventsServerOptions } from './events-server';
import { Database, getDatabase } from '../database/database';
import { computeWebhookSignature } from '../services/webhook-verifier';
import { NotificationAPI } from '../services/notification-api';

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    })),
  },
}), { virtual: true });

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  sanitizeUrl: (u: string) => u,
}));

const PRIMARY_KEY = 'nc_live_primary_0123456789abcdef';
const SECONDARY_KEY = 'nc_live_secondary_fedcba9876543210';
const ROTATED_OUT_KEY = 'nc_live_rotated_out_key_000000000';

const WEBHOOK_KEY_ID = 'partner-1';
const WEBHOOK_SECRET = 'whsec_partner_1_secret_value';

const BASE_OPTIONS: EventsServerOptions = {
  port: 0,
  stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
  stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
  contractAddresses: [],
  apiKeys: [
    { key: PRIMARY_KEY, name: 'primary' },
    { key: SECONDARY_KEY, name: 'secondary' },
  ],
  webhookSecrets: [{ id: WEBHOOK_KEY_ID, secret: WEBHOOK_SECRET }],
  // Stub scheduler so the import endpoint gets past the availability check.
  notificationAPI: {
    scheduleNotification: jest.fn().mockResolvedValue({ id: 1 }),
  } as unknown as NotificationAPI,
};

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  server: http.Server,
  opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const req = http.request(
      { host: '127.0.0.1', port, path: opts.path, method: opts.method, headers: opts.headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: unknown = data;
          try { body = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode!, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function startServer(options: EventsServerOptions): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createEventsServer(options);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function expectUnauthorized(res: Response): void {
  expect(res.status).toBe(401);
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('UNAUTHORIZED');
  expect(res.headers['www-authenticate']).toMatch(/X-API-Key/);
}

// ── X-API-Key protected endpoints ───────────────────────────────────────────

const API_KEY_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: string; headers?: http.OutgoingHttpHeaders }> = [
  { name: 'GET /api/notifications/history', method: 'GET', path: '/api/notifications/history' },
  { name: 'GET /api/v1/notifications/history', method: 'GET', path: '/api/v1/notifications/history' },
  {
    name: 'POST /api/notifications/import',
    method: 'POST',
    path: '/api/notifications/import',
    body: '[]',
    headers: { 'Content-Type': 'application/json' },
  },
  {
    name: 'POST /api/v1/notifications/import',
    method: 'POST',
    path: '/api/v1/notifications/import',
    body: '[]',
    headers: { 'Content-Type': 'application/json' },
  },
];

describe('API-key protected endpoints', () => {
  let db: Database;
  let server: http.Server;

  beforeAll(async () => {
    db = getDatabase(':memory:');
    await db.initialize();
    server = await startServer(BASE_OPTIONS);
  });

  afterAll(async () => {
    await closeServer(server);
    await db.close();
  });

  describe.each(API_KEY_ENDPOINTS)('$name', (endpoint) => {
    const send = (headers: http.OutgoingHttpHeaders = {}, path = endpoint.path) =>
      request(server, {
        method: endpoint.method,
        path,
        body: endpoint.body,
        headers: { ...endpoint.headers, ...headers },
      });

    it('rejects missing credentials with 401', async () => {
      const res = await send();
      expectUnauthorized(res);
      expect(res.body.error.message).toMatch(/missing API key/i);
    });

    it('rejects an empty X-API-Key header with 401', async () => {
      const res = await send({ 'X-API-Key': '' });
      expectUnauthorized(res);
    });

    it('rejects invalid credentials with 401', async () => {
      const res = await send({ 'X-API-Key': 'nc_live_not_a_real_key' });
      expectUnauthorized(res);
      expect(res.body.error.message).toMatch(/invalid API key/i);
    });

    it('rejects expired (rotated-out) credentials with 401', async () => {
      const res = await send({ 'X-API-Key': ROTATED_OUT_KEY });
      expectUnauthorized(res);
    });

    it('accepts the primary valid key', async () => {
      const res = await send({ 'X-API-Key': PRIMARY_KEY });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    it('accepts any other configured key', async () => {
      const res = await send({ 'X-API-Key': SECONDARY_KEY });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    });

    describe('unauthorized access attempts', () => {
      it.each([
        ['a prefix of a valid key', PRIMARY_KEY.slice(0, -1)],
        ['a valid key with extra characters', `${PRIMARY_KEY}x`],
        ['a valid key with different case', PRIMARY_KEY.toUpperCase()],
        // Leading/trailing whitespace is stripped by HTTP itself, so test an
        // embedded space, which does reach the application.
        ['a valid key with embedded whitespace', `${PRIMARY_KEY.slice(0, 8)} ${PRIMARY_KEY.slice(8)}`],
        ['the webhook secret instead of an API key', WEBHOOK_SECRET],
      ])('rejects %s', async (_label, key) => {
        expectUnauthorized(await send({ 'X-API-Key': key }));
      });

      it('rejects a valid key sent as a Bearer token', async () => {
        expectUnauthorized(await send({ Authorization: `Bearer ${PRIMARY_KEY}` }));
      });

      it('rejects a valid key sent in the query string', async () => {
        const sep = endpoint.path.includes('?') ? '&' : '?';
        expectUnauthorized(await send({}, `${endpoint.path}${sep}api_key=${PRIMARY_KEY}`));
      });

      it('rejects ambiguous duplicate X-API-Key headers', async () => {
        const res = await new Promise<Response>((resolve, reject) => {
          const { port } = server.address() as { port: number };
          const req = http.request(
            { host: '127.0.0.1', port, path: endpoint.path, method: endpoint.method },
            (r) => {
              let data = '';
              r.on('data', (c) => (data += c));
              r.on('end', () => resolve({ status: r.statusCode!, headers: r.headers, body: JSON.parse(data) }));
            },
          );
          req.on('error', reject);
          req.setHeader('X-API-Key', ['nc_live_not_a_real_key', PRIMARY_KEY]);
          if (endpoint.headers) {
            for (const [k, v] of Object.entries(endpoint.headers)) req.setHeader(k, v as string);
          }
          if (endpoint.body !== undefined) req.write(endpoint.body);
          req.end();
        });
        expectUnauthorized(res);
      });

      it('does not leak protected data in the 401 body', async () => {
        const res = await send({ 'X-API-Key': 'wrong' });
        expect(res.body).not.toHaveProperty('data');
        expect(res.body).not.toHaveProperty('records');
        expect(JSON.stringify(res.body)).not.toContain(PRIMARY_KEY);
      });
    });
  });

  it('checks credentials before revealing that the scheduler is disabled', async () => {
    const noScheduler = await startServer({ ...BASE_OPTIONS, notificationAPI: null });
    try {
      const unauth = await request(noScheduler, {
        method: 'POST',
        path: '/api/notifications/import',
        body: '[]',
        headers: { 'Content-Type': 'application/json' },
      });
      expectUnauthorized(unauth);

      const auth = await request(noScheduler, {
        method: 'POST',
        path: '/api/notifications/import',
        body: '[]',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': PRIMARY_KEY },
      });
      expect(auth.status).toBe(503);
    } finally {
      await closeServer(noScheduler);
    }
  });

  it('allows access when no API keys are configured (backward compatibility)', async () => {
    const open = await startServer({ ...BASE_OPTIONS, apiKeys: [] });
    try {
      const res = await request(open, { method: 'GET', path: '/api/notifications/history' });
      expect(res.status).toBe(200);
    } finally {
      await closeServer(open);
    }
  });

  it('leaves public endpoints reachable without credentials', async () => {
    const res = await request(server, { method: 'GET', path: '/api/events' });
    expect(res.status).not.toBe(401);
  });
});

// ── HMAC-signed webhook endpoint ────────────────────────────────────────────

describe('POST /api/webhooks (HMAC signature auth)', () => {
  let server: http.Server;
  const body = JSON.stringify({ event: 'notification.created', id: 'n-1' });
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));

  function signedHeaders(
    overrides: Partial<{ keyId: string | null; secret: string; timestamp: string | null; signedBody: string; signature: string }> = {},
  ): http.OutgoingHttpHeaders {
    const timestamp = overrides.timestamp === undefined ? nowSeconds() : overrides.timestamp;
    const signature =
      overrides.signature ??
      computeWebhookSignature(overrides.signedBody ?? body, overrides.secret ?? WEBHOOK_SECRET, timestamp ?? undefined);
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
    };
    const keyId = overrides.keyId === undefined ? WEBHOOK_KEY_ID : overrides.keyId;
    if (keyId !== null) headers['X-Webhook-Key-Id'] = keyId;
    if (timestamp !== null) headers['X-Webhook-Timestamp'] = timestamp;
    return headers;
  }

  const post = (headers: http.OutgoingHttpHeaders, payload = body) =>
    request(server, { method: 'POST', path: '/api/webhooks', headers, body: payload });

  beforeAll(async () => {
    server = await startServer({ ...BASE_OPTIONS, signatureExpirationSeconds: 300 });
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it('rejects missing credentials (no signature) with 401', async () => {
    const res = await post({ 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MISSING_SIGNATURE');
  });

  it('rejects a signature without a key id with 401', async () => {
    const res = await post(signedHeaders({ keyId: null }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MISSING_KEY_ID');
  });

  it('rejects invalid credentials (wrong secret) with 401', async () => {
    const res = await post(signedHeaders({ secret: 'whsec_attacker_guess' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('rejects an unknown key id with 401', async () => {
    const res = await post(signedHeaders({ keyId: 'partner-unknown' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_UNKNOWN_KEY_ID');
  });

  it('rejects a malformed signature with 401', async () => {
    const res = await post(signedHeaders({ signature: 'md5=abc' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_SIGNATURE_FORMAT');
  });

  it('rejects expired credentials (stale timestamp) with 401', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    const res = await post(signedHeaders({ timestamp: stale }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('rejects timestamps too far in the future with 401', async () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const res = await post(signedHeaders({ timestamp: future }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('rejects a non-numeric timestamp with 401', async () => {
    const res = await post(signedHeaders({ timestamp: 'yesterday' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('accepts valid credentials with 202', async () => {
    const res = await post(signedHeaders());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted', verified: true });
  });

  describe('unauthorized access attempts', () => {
    it('rejects a tampered body signed for different content', async () => {
      const res = await post(signedHeaders(), JSON.stringify({ event: 'notification.created', id: 'n-2' }));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_SIGNATURE');
    });

    it('rejects replaying a signature with a refreshed timestamp', async () => {
      const oldTs = String(Math.floor(Date.now() / 1000) - 120);
      const oldSignature = computeWebhookSignature(body, WEBHOOK_SECRET, oldTs);
      const res = await post(signedHeaders({ signature: oldSignature, timestamp: nowSeconds() }));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_SIGNATURE');
    });

    it('rejects stripping the timestamp from a timestamp-bound signature', async () => {
      const ts = nowSeconds();
      const signature = computeWebhookSignature(body, WEBHOOK_SECRET, ts);
      const res = await post(signedHeaders({ signature, timestamp: null }));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_SIGNATURE');
    });

    it('rejects an API key presented instead of a signature', async () => {
      const res = await post({ 'Content-Type': 'application/json', 'X-API-Key': PRIMARY_KEY });
      expect(res.status).toBe(401);
    });

    it('does not echo the secret or expected signature in the 401 body', async () => {
      const res = await post(signedHeaders({ secret: 'whsec_attacker_guess' }));
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(WEBHOOK_SECRET);
      expect(text).not.toContain(computeWebhookSignature(body, WEBHOOK_SECRET, nowSeconds()).slice(7));
    });
  });
});
