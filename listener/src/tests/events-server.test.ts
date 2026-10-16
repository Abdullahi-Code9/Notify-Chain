import http from 'http';
import { createEventsServer } from '../api/events-server';

const TEST_PORT = 19876;

function makeRequest(
  path: string,
  options: { headers?: Record<string, string>; method?: string; port?: number } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  options: { headers?: Record<string, string>; method?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: options.port ?? TEST_PORT, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          let body = data;
          try { body = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
    );
    req.on('error', reject);
    req.end();
  });
}

describe('correlation ID propagation', () => {
  let server: http.Server;

  beforeAll((done) => {
    server = createEventsServer({
      port: TEST_PORT,
      stellarRpcUrl: 'http://localhost:8000',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    server.listen(TEST_PORT, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  test('generates a correlation ID when none is provided', async () => {
    const { headers } = await makeRequest('/api/events');
    expect(headers['x-correlation-id']).toBeTruthy();
  });

  test('echoes back the caller-supplied correlation ID', async () => {
    const myId = 'my-trace-abc123';
    const { headers } = await makeRequest('/api/events', {
      headers: { 'x-correlation-id': myId },
    });
    expect(headers['x-correlation-id']).toBe(myId);
  });

  test('always includes x-request-id alongside correlation ID', async () => {
    const { headers } = await makeRequest('/api/events');
    expect(headers['x-request-id']).toBeTruthy();
    expect(headers['x-correlation-id']).toBeTruthy();
    expect(headers['x-request-id']).not.toBe(headers['x-correlation-id']);
  });

  test('correlation ID flows through on 404 responses', async () => {
    const myId = 'trace-404-test';
    const { status, headers } = await makeRequest('/no-such-route', {
      headers: { 'x-correlation-id': myId },
    });
    expect(status).toBe(404);
    expect(headers['x-correlation-id']).toBe(myId);
  });
});

describe('security headers', () => {
describe('GET /api/events pagination', () => {
  let server: http.Server;

  beforeAll((done) => {
    server = createEventsServer({
      port: TEST_PORT,
      stellarRpcUrl: 'http://localhost:8000',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });
    server.listen(TEST_PORT, done);
    
    // Add 150 mock events to the registry
    const { eventRegistry } = require('../store/event-registry');
    for (let i = 0; i < 150; i++) {
      eventRegistry.addEvent({
        eventId: `0000000000000000-${i}`,
        contractAddress: 'CCEMX6JKPEUGYAOU4YZP3WBXGPWK7AEFDEDLRXFIDIJPQFMRXTHUVIO',
        eventName: 'autoshare_created',
        ledger: 1000 + i,
        type: 'contract',
        topic: ['test'],
        value: 'test',
        txHash: '0x123',
        receivedAt: Date.now()
      });
    }
  });

  afterAll((done) => {
    server.close(done);
  });

  test('sets baseline headers on preflight responses without changing cache policy', async () => {
    const { status, headers } = await makeRequest('/api/events', { method: 'OPTIONS' });

    expect(status).toBe(204);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['cache-control']).toBeUndefined();
  });

  test('sets baseline headers on not-found responses', async () => {
    const { status, headers } = await makeRequest('/no-such-route');

    expect(status).toBe(404);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('sets HSTS only when production is explicitly enabled', async () => {
    const productionServer = createEventsServer({
      port: 0,
      isProduction: true,
      stellarRpcUrl: 'http://localhost:8000',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
    });

    await new Promise<void>((resolve) => productionServer.listen(0, '127.0.0.1', resolve));

    try {
      const address = productionServer.address() as { port: number };
      const { headers } = await makeRequest('/no-such-route', { port: address.port });

      expect(headers['strict-transport-security']).toBe('max-age=31536000');
    } finally {
      await new Promise<void>((resolve) => productionServer.close(() => resolve()));
    }
  test('defaults to 20 items when limit is not provided', async () => {
    const { status, body } = await makeRequest('/api/events');
    expect(status).toBe(200);
    expect(body.events.length).toBe(20);
    expect(body.count).toBeGreaterThanOrEqual(150);
  });

  test('respects limit when provided within bounds', async () => {
    const { status, body } = await makeRequest('/api/events?limit=50');
    expect(status).toBe(200);
    expect(body.events.length).toBe(50);
  });

  test('caps excessively large limit at 100', async () => {
    const { status, body } = await makeRequest('/api/events?limit=200');
    expect(status).toBe(200);
    expect(body.events.length).toBe(100);
  });

  test('handles negative limits by falling back to minimum (1)', async () => {
    const { status, body } = await makeRequest('/api/events?limit=-10');
    expect(status).toBe(200);
    expect(body.events.length).toBe(1);
  });
  
  test('handles invalid limit by falling back to default', async () => {
    const { status, body } = await makeRequest('/api/events?limit=invalid');
    expect(status).toBe(200);
    expect(body.events.length).toBe(20);
  });
});
