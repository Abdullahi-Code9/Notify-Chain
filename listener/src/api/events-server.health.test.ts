import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import {
  createEventsServer,
  checkStellarRpc,
  checkDiscord,
  checkDatabase,
} from './events-server';
import { eventRegistry } from '../store/event-registry';

const mockGetHealth = jest.fn() as jest.MockedFunction<() => Promise<unknown>>;
const mockDbPing = jest.fn() as jest.MockedFunction<() => Promise<void>>;
const mockDbIsConnected = jest.fn() as jest.MockedFunction<() => boolean>;

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: mockGetHealth,
    })),
  },
}), { virtual: true });

jest.mock('../store/event-registry', () => ({
  eventRegistry: { getEvents: jest.fn(() => []), count: jest.fn(() => 0) },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../database/database', () => ({
  getDatabase: jest.fn(() => ({
    isConnected: mockDbIsConnected,
    get: mockDbPing,
  })),
}));

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(global as any).fetch = mockFetch;

const BASE_OPTIONS = {
  port: 0,
  stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
  stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
  contractAddresses: [] as [],
};

function makeRequest(
  server: http.Server,
  path: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(
  options: Parameters<typeof createEventsServer>[0]
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createEventsServer(options);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
}

describe('GET /health', () => {
  let server: http.Server;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbIsConnected.mockReturnValue(true);
    mockDbPing.mockResolvedValue(undefined);
    (eventRegistry.count as jest.Mock).mockReturnValue(5);
    mockGetHealth.mockResolvedValue({ status: 'healthy' });
  });

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('returns 200 and status ok when all dependencies are healthy', async () => {
    server = await startServer(BASE_OPTIONS);
    const { status, body } = await makeRequest(server, '/health');
    const health = body as any;

    expect(status).toBe(200);
    expect(health.status).toBe('ok');
    expect(health.services.stellarRpc.status).toBe('ok');
    expect(health.services.discord.status).toBe('not_configured');
    expect(health.services.database.status).toBe('ok');
    expect(health.services.eventRegistry).toEqual({ status: 'ok', eventCount: 5 });
    expect(health.timestamp).toBeDefined();
    expect(typeof health.uptimeSeconds).toBe('number');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // version field is included in every health response (#624)
    expect(health.version).toMatch(/^\d+\.\d+\.\d+.*$|^unknown$/);
  });

  it('returns 503 and status error when Stellar RPC is unreachable', async () => {
    mockGetHealth.mockRejectedValue(new Error('connection refused'));

    server = await startServer(BASE_OPTIONS);
    const { status, body } = await makeRequest(server, '/health');
    const health = body as any;

    expect(status).toBe(503);
    expect(health.status).toBe('error');
    expect(health.services.stellarRpc.status).toBe('error');
    expect(health.services.stellarRpc.detail).toBe('connection refused');
  });

  it('returns 503 and status error when database ping fails', async () => {
    mockDbIsConnected.mockReturnValue(false);

    server = await startServer(BASE_OPTIONS);
    const { status, body } = await makeRequest(server, '/health');
    const health = body as any;

    expect(status).toBe(503);
    expect(health.status).toBe('error');
    expect(health.services.database.status).toBe('error');
    expect(health.services.database.detail).toBe('Database not initialized');
  });

  it('returns 200 and status degraded when Discord webhook is down', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

    server = await startServer({
      ...BASE_OPTIONS,
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
    });
    const { status, body } = await makeRequest(server, '/health');
    const health = body as any;

    expect(status).toBe(200);
    expect(health.status).toBe('degraded');
    expect(health.services.discord.status).toBe('error');
    expect(health.services.discord.detail).toBe('HTTP 503');
    expect(health.services.database.status).toBe('ok');
  });

  it('returns 200 and status ok when Discord webhook is reachable', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);

    server = await startServer({
      ...BASE_OPTIONS,
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
    });
    const { status, body } = await makeRequest(server, '/health');
    const health = body as any;

    expect(status).toBe(200);
    expect(health.status).toBe('ok');
    expect(health.services.discord.status).toBe('ok');
    expect(typeof health.services.stellarRpc.latencyMs).toBe('number');
    expect(typeof health.services.discord.latencyMs).toBe('number');
    expect(typeof health.services.database.latencyMs).toBe('number');
  });
});

describe('checkDatabase', () => {
  beforeEach(() => {
    mockDbIsConnected.mockReset();
    mockDbPing.mockReset();
  });

  it('returns ok when the database responds to ping', async () => {
    mockDbIsConnected.mockReturnValue(true);
    mockDbPing.mockResolvedValue(undefined);
    const result = await checkDatabase();
    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error when the database is not initialized', async () => {
    mockDbIsConnected.mockReturnValue(false);
    const result = await checkDatabase();
    expect(result.status).toBe('error');
    expect(result.detail).toBe('Database not initialized');
  });
});

describe('checkStellarRpc', () => {
  beforeEach(() => {
    mockGetHealth.mockReset();
  });

  it('returns ok when getHealth resolves', async () => {
    mockGetHealth.mockResolvedValue({ status: 'healthy' });
    const result = await checkStellarRpc('https://soroban-testnet.stellar.org:443');
    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error when getHealth rejects', async () => {
    mockGetHealth.mockImplementation(() => Promise.reject(new Error('timeout')));
    const result = await checkStellarRpc('https://soroban-testnet.stellar.org:443');
    expect(result.status).toBe('error');
    expect(result.detail).toBe('timeout');
  });
});

describe('checkDiscord', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns ok for a 200 response', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    const result = await checkDiscord('https://discord.com/api/webhooks/123/abc');
    expect(result.status).toBe('ok');
  });

  it('returns error for a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 } as Response);
    const result = await checkDiscord('https://discord.com/api/webhooks/123/abc');
    expect(result.status).toBe('error');
    expect(result.detail).toBe('HTTP 401');
  });

  it('returns error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const result = await checkDiscord('https://discord.com/api/webhooks/123/abc');
    expect(result.status).toBe('error');
    expect(result.detail).toBe('network error');
  });
});
