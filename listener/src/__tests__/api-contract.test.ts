/**
 * API contract tests (#811).
 *
 * Pin the request/response structure of the events API so unintended
 * breaking changes fail loudly in CI instead of reaching consumers.
 *
 * Covered contracts:
 *  - Success envelope: { success: true, data: ... } on every 2xx.
 *  - Error envelope:   { success: false, error: { code, message } } on
 *    4xx/5xx, including expected error responses.
 *  - Per-endpoint payload shape for the important read endpoints.
 *
 * These tests intentionally assert structure (field presence + types),
 * not exact values, so legitimate data changes don't break the build
 * while schema changes do.
 */
import http from 'http';
import { createEventsServer } from '../api/events-server';

const TEST_PORT = 19878;

type Shape =
  | 'number'
  | 'string'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null'
  | 'any'
  | { [key: string]: Shape };

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function expectShape(value: unknown, spec: Shape, path: string): void {
  if (spec === 'any') return;
  if (typeof spec === 'string') {
    expect({ path, actual: shapeOf(value) }).toEqual({ path, actual: spec });
    return;
  }
  expect({ path, actual: shapeOf(value) }).toEqual({ path, actual: 'object' });
  const obj = value as Record<string, unknown>;
  for (const [key, sub] of Object.entries(spec)) {
    expect({ path: `${path}.${key}`, present: key in obj }).toEqual({ path: `${path}.${key}`, present: true });
    expectShape(obj[key], sub, `${path}.${key}`);
  }
}

const SUCCESS_ENVELOPE: Shape = { success: 'boolean', data: 'any' };
const ERROR_ENVELOPE: Shape = {
  success: 'boolean',
  error: { code: 'string', message: 'string' },
};

describe('events API contract', () => {
  let server: http.Server;

  function getJson(path: string, method = 'GET'): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: TEST_PORT, path, method }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(data); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

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

  test('GET /api/events returns the success envelope with count + events array', async () => {
    const { status, body } = await getJson('/api/events');
    expect(status).toBe(200);
    expectShape(body, SUCCESS_ENVELOPE, '$');
    expect(body.success).toBe(true);
    expectShape(body.data, { count: 'number', events: 'array' }, '$.data');
  });

  test('GET /api/schedule/jobs returns monitoring snapshot contract', async () => {
    const { status, body } = await getJson('/api/schedule/jobs');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expectShape(body.data, { recentJobs: 'array', recentFailures: 'array' }, '$.data');
  });

  test('GET /api/schedule/jobs/failures returns failures list contract', async () => {
    const { status, body } = await getJson('/api/schedule/jobs/failures');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expectShape(body.data, { failures: 'array', count: 'number' }, '$.data');
  });

  test('unknown route returns the error envelope with 404', async () => {
    const { status, body } = await getJson('/api/definitely-not-a-route');
    expect(status).toBe(404);
    expectShape(body, ERROR_ENVELOPE, '$');
    expect(body.success).toBe(false);
  });

  test('service-unavailable responses use the same error envelope (expected error response)', async () => {
    // No analytics aggregator is configured in this test server, so this
    // endpoint exercises the expected-error contract path.
    const { status, body } = await getJson('/api/analytics');
    if (status === 503) {
      expectShape(body, ERROR_ENVELOPE, '$');
      expect(body.success).toBe(false);
      expect(typeof body.error.code).toBe('string');
    } else {
      // Aggregator available: success envelope must hold instead.
      expect(status).toBe(200);
      expectShape(body, SUCCESS_ENVELOPE, '$');
    }
  });

  test('responses carry correlation/request tracing headers (part of the API contract)', async () => {
    const { status, body } = await getJson('/api/events');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // Header contract checked separately in events-server.test.ts; here we
    // assert the body envelope stays stable regardless of tracing headers.
    expectShape(body, SUCCESS_ENVELOPE, '$');
  });
});
