import http from 'http';
import { createEventsServer } from './events-server';
import { getMimeType, isJsonContentType, validateContentType } from '../middleware/content-type';
import { NotificationAPI } from '../services/notification-api';
import { NotificationType } from '../types/scheduled-notification';

jest.mock(
  '@stellar/stellar-sdk',
  () => ({
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
      })),
    },
  }),
  { virtual: true },
);

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  sanitizeUrl: jest.fn((url: string) => url),
}));

describe('Content-Type Handling Utilities', () => {
  describe('getMimeType', () => {
    it('normalizes simple MIME types to lowercase', () => {
      expect(getMimeType('application/json')).toBe('application/json');
      expect(getMimeType('APPLICATION/JSON')).toBe('application/json');
      expect(getMimeType('text/csv')).toBe('text/csv');
    });

    it('strips parameters such as charset', () => {
      expect(getMimeType('application/json; charset=utf-8')).toBe('application/json');
      expect(getMimeType('application/json;charset=UTF-8')).toBe('application/json');
      expect(getMimeType('text/csv; header=present')).toBe('text/csv');
    });

    it('handles arrays and undefined/empty headers safely', () => {
      expect(getMimeType(['application/json; charset=utf-8'])).toBe('application/json');
      expect(getMimeType(undefined)).toBeNull();
      expect(getMimeType('')).toBeNull();
      expect(getMimeType('   ')).toBeNull();
    });
  });

  describe('isJsonContentType', () => {
    it('identifies valid JSON MIME types regardless of charset parameters', () => {
      expect(isJsonContentType('application/json')).toBe(true);
      expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
      expect(isJsonContentType('APPLICATION/JSON; CHARSET=UTF-8')).toBe(true);
    });

    it('rejects non-JSON MIME types', () => {
      expect(isJsonContentType('text/plain')).toBe(false);
      expect(isJsonContentType('application/xml')).toBe(false);
      expect(isJsonContentType('text/csv')).toBe(false);
      expect(isJsonContentType(undefined)).toBe(false);
    });
  });
});

describe('API Content-Type Handling (Integration #647)', () => {
  let server: http.Server;
  let mockNotificationAPI: any;

  beforeEach((done) => {
    jest.clearAllMocks();

    mockNotificationAPI = {
      scheduleNotification: jest.fn().mockResolvedValue(42),
      maxPayloadSizeBytes: 65536,
    };

    server = createEventsServer({
      port: 0,
      stellarRpcUrl: 'http://localhost:8000',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      notificationAPI: mockNotificationAPI as unknown as NotificationAPI,
    });

    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    server.close(done);
  });

  function makeRequest(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: string | object;
    } = {},
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
    return new Promise((resolve, reject) => {
      const port = (server.address() as { port: number }).port;
      const payload =
        options.body !== undefined
          ? typeof options.body === 'string'
            ? options.body
            : JSON.stringify(options.body)
          : undefined;

      const reqHeaders: Record<string, string> = {
        ...(options.headers ?? {}),
      };

      if (payload !== undefined && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = String(Buffer.byteLength(payload));
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: reqHeaders,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed: any;
            try {
              parsed = data ? JSON.parse(data) : {};
            } catch {
              parsed = data;
            }
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: parsed,
            });
          });
        },
      );

      req.on('error', reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }

  describe('AC 1: JSON responses consistently expose the appropriate content type', () => {
    it('sets Content-Type: application/json on GET /health', async () => {
      const res = await makeRequest('GET', '/health');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('sets Content-Type: application/json on GET /api/status', async () => {
      const res = await makeRequest('GET', '/api/status');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('sets Content-Type: application/json on GET /api/events', async () => {
      const res = await makeRequest('GET', '/api/events');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('sets Content-Type: application/json on 404 responses', async () => {
      const res = await makeRequest('GET', '/api/non-existent-route');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    });

    it('does not set Content-Type on OPTIONS (204 No Content)', async () => {
      const res = await makeRequest('OPTIONS', '/api/events');
      expect(res.status).toBe(204);
      expect(res.headers['content-type']).toBeUndefined();
    });
  });

  describe('AC 2: Unsupported request content types are handled correctly (HTTP 415)', () => {
    it('rejects POST /api/schedule with text/plain as 415 Unsupported Media Type', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text body',
      });

      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.error?.message).toContain('Unsupported Content-Type');
      expect(mockNotificationAPI.scheduleNotification).not.toHaveBeenCalled();
    });

    it('rejects POST /api/schedule with application/xml as 415 Unsupported Media Type', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        headers: { 'Content-Type': 'application/xml' },
        body: '<xml></xml>',
      });

      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects POST /api/notifications/validate-batch with text/plain as 415', async () => {
      const res = await makeRequest('POST', '/api/notifications/validate-batch', {
        headers: { 'Content-Type': 'text/plain' },
        body: 'invalid batch payload',
      });

      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects POST /api/notifications/import with application/xml as 415', async () => {
      const res = await makeRequest('POST', '/api/notifications/import', {
        headers: { 'Content-Type': 'application/xml' },
        body: '<notifications></notifications>',
      });

      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects PUT /api/preferences/:userId with text/html as 415', async () => {
      const res = await makeRequest('PUT', '/api/preferences/alice', {
        headers: { 'Content-Type': 'text/html' },
        body: '<html></html>',
      });

      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'UNSUPPORTED_MEDIA_TYPE');
    });
  });

  describe('AC 3: Existing API clients remain compatible', () => {
    it('accepts POST /api/schedule with Content-Type: application/json', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        headers: { 'Content-Type': 'application/json' },
        body: {
          executeAt: new Date(Date.now() + 60000).toISOString(),
          payload: { message: 'hello' },
          targetRecipient: 'user123',
        },
      });

      expect(res.status).toBe(201);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('id', 42);
    });

    it('accepts POST /api/schedule with Content-Type: application/json; charset=utf-8', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: {
          executeAt: new Date(Date.now() + 60000).toISOString(),
          payload: { message: 'hello utf8' },
          targetRecipient: 'user123',
        },
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id', 42);
    });

    it('accepts POST /api/schedule when Content-Type is omitted but payload is valid JSON', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        body: {
          executeAt: new Date(Date.now() + 60000).toISOString(),
          payload: { message: 'no content-type' },
          targetRecipient: 'user123',
        },
      });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id', 42);
    });

    it('accepts POST /api/notifications/import with text/csv', async () => {
      const csvData = 'recipient,channel,message\nalice,discord,Hello\n';
      const res = await makeRequest('POST', '/api/notifications/import', {
        headers: { 'Content-Type': 'text/csv' },
        body: csvData,
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.data).toHaveProperty('format', 'csv');
    });

    it('allows GET requests without Content-Type header', async () => {
      const res = await makeRequest('GET', '/api/events');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Edge Cases & Malformed JSON Handling', () => {
    it('returns 400 Bad Request with PARSE_ERROR when payload is invalid JSON', async () => {
      const res = await makeRequest('POST', '/api/schedule', {
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json: not valid',
      });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toHaveProperty('code', 'PARSE_ERROR');
    });
  });
});
