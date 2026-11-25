import http from 'http';
import type { AddressInfo } from 'net';
import { handleCredentialRoutes } from './credentials-api';
import { authorizeRequest, type ApiKeyEntry } from './api-key-auth';
import { ApiCredentialService } from '../services/api-credential-service';
import { runWithRequestCorrelation } from '../middleware/correlation';
import { sendErr, sendOk, ErrorCode } from '../utils/response';
import type { ApiScope } from '../types/api-credential';

jest.mock('../utils/logger', () => {
  const actual = jest.requireActual('../utils/logger');
  return {
    __esModule: true,
    ...actual,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

const ADMIN_KEY = 'legacy-admin-key-123';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/**
 * Minimal server mirroring the events server's wiring: credential routes plus
 * two scope-protected endpoints.
 */
function buildServer(
  credentialService: ApiCredentialService,
  apiKeys: ApiKeyEntry[] | undefined,
): http.Server {
  const protectedRoutes: Record<string, readonly ApiScope[]> = {
    '/api/stats': ['stats:read'],
    '/api/export': ['events:read', 'notifications:read'],
  };

  return http.createServer((req, res) =>
    runWithRequestCorrelation(req, res, async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (await handleCredentialRoutes(req, res, url, { credentialService, apiKeys })) return;

      const scopes = protectedRoutes[url.pathname];
      if (!scopes) {
        sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
        return;
      }
      const auth = await authorizeRequest(req, {
        apiKeys,
        credentialService,
        requiredScopes: scopes,
      });
      if (!auth.allowed) {
        sendErr(res, auth.status, auth.message, auth.code, auth.details);
        return;
      }
      sendOk(res, 200, { ok: true, principal: auth.principal.type });
    }),
  );
}

describe('scoped API credentials', () => {
  let server: http.Server;
  let port: number;
  let credentialService: ApiCredentialService;
  let apiKeys: ApiKeyEntry[] | undefined;

  async function start(keys: ApiKeyEntry[] | undefined): Promise<void> {
    apiKeys = keys;
    credentialService = new ApiCredentialService();
    server = buildServer(credentialService, apiKeys);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(
    method: string,
    path: string,
    options: { key?: string; body?: unknown; correlationId?: string } = {},
  ): Promise<Res> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.key) headers['X-API-Key'] = options.key;
      if (options.correlationId) headers['X-Correlation-Id'] = options.correlationId;
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (payload) headers['Content-Type'] = 'application/json';

      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
          }),
        );
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function issue(scopes: ApiScope[], name = 'integration'): Promise<Res> {
    return call('POST', '/api/credentials', { key: ADMIN_KEY, body: { name, scopes } });
  }

  describe('with a static admin key configured', () => {
    beforeEach(() => start([{ key: ADMIN_KEY, name: 'admin' }]));

    it('creates a credential and returns the secret key once with 201', async () => {
      const res = await issue(['stats:read']);
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.success).toBe(true);
      expect(res.body.data.apiKey).toMatch(/^nck_/);
      expect(res.body.data.scopes).toEqual(['stats:read']);
    });

    it('never returns the secret from list or get', async () => {
      const created = (await issue(['stats:read'])).body.data;

      const list = await call('GET', '/api/credentials', { key: ADMIN_KEY });
      const one = await call('GET', `/api/credentials/${created.id}`, { key: ADMIN_KEY });

      expect(list.status).toBe(200);
      expect(list.body.data.count).toBe(1);
      expect(one.status).toBe(200);
      expect(one.body.data.id).toBe(created.id);
      for (const view of [list.body.data.credentials[0], one.body.data]) {
        expect(view).not.toHaveProperty('apiKey');
        expect(view).not.toHaveProperty('secretHash');
      }
      expect(JSON.stringify(list.body)).not.toContain(created.apiKey);
      expect(JSON.stringify(one.body)).not.toContain(created.apiKey);
    });

    it('allows a request whose credential holds the required scope', async () => {
      const { apiKey } = (await issue(['stats:read'])).body.data;
      const res = await call('GET', '/api/stats', { key: apiKey });
      expect(res.status).toBe(200);
      expect(res.body.data.principal).toBe('credential');
    });

    it('rejects a credential missing the required scope with 403 INVALID_PERMISSIONS', async () => {
      const { apiKey } = (await issue(['events:read'])).body.data;
      const res = await call('GET', '/api/stats', { key: apiKey, correlationId: 'req-403' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_PERMISSIONS');
      expect(res.body.error.correlation_id).toBe('req-403');
      expect(res.body.error.details).toEqual([
        { requiredScopes: ['stats:read'], missingScopes: ['stats:read'] },
      ]);
    });

    it('requires every scope when an endpoint lists several', async () => {
      const partial = (await issue(['events:read'])).body.data.apiKey;
      const full = (await issue(['events:read', 'notifications:read'])).body.data.apiKey;

      const denied = await call('GET', '/api/export', { key: partial });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details[0].missingScopes).toEqual(['notifications:read']);

      expect((await call('GET', '/api/export', { key: full })).status).toBe(200);
    });

    it('keeps full access for static (legacy) keys', async () => {
      const res = await call('GET', '/api/export', { key: ADMIN_KEY });
      expect(res.status).toBe(200);
      expect(res.body.data.principal).toBe('legacy');
    });

    it('rejects a forged scoped key with 401 UNAUTHORIZED', async () => {
      const forged = `nck_${'a'.repeat(16)}_${'B'.repeat(43)}`;
      const res = await call('GET', '/api/stats', { key: forged });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects a revoked credential with 401', async () => {
      const created = (await issue(['stats:read'])).body.data;
      expect((await call('GET', '/api/stats', { key: created.apiKey })).status).toBe(200);

      const del = await call('DELETE', `/api/credentials/${created.id}`, { key: ADMIN_KEY });
      expect(del.status).toBe(200);
      expect(del.body.data.revokedAt).not.toBeNull();
      expect(del.body.data).not.toHaveProperty('apiKey');

      expect((await call('GET', '/api/stats', { key: created.apiKey })).status).toBe(401);
    });

    it('requires credentials:manage to manage credentials', async () => {
      const { apiKey } = (await issue(['stats:read'])).body.data;
      const res = await call('GET', '/api/credentials', { key: apiKey });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_PERMISSIONS');
    });

    it('prevents a scoped manager from granting scopes it does not hold', async () => {
      const manager = (await issue(['credentials:manage', 'events:read'])).body.data.apiKey;

      const escalate = await call('POST', '/api/credentials', {
        key: manager,
        body: { name: 'escalate', scopes: ['webhooks:manage'] },
      });
      expect(escalate.status).toBe(403);
      expect(escalate.body.error.code).toBe('INVALID_PERMISSIONS');

      const allowed = await call('POST', '/api/credentials', {
        key: manager,
        body: { name: 'reader', scopes: ['events:read'] },
      });
      expect(allowed.status).toBe(201);
    });

    it('returns VALIDATION_ERROR with per-field details for bad input', async () => {
      const res = await call('POST', '/api/credentials', {
        key: ADMIN_KEY,
        body: { name: '', scopes: ['nope'] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'name' }),
          expect.objectContaining({ field: 'scopes' }),
        ]),
      );
    });

    it('returns 404 NOT_FOUND for unknown credential ids', async () => {
      const res = await call('GET', `/api/credentials/${'0'.repeat(16)}`, { key: ADMIN_KEY });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 405 METHOD_NOT_ALLOWED for unsupported methods', async () => {
      const res = await call('PUT', '/api/credentials', { key: ADMIN_KEY, body: {} });
      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
      expect(res.headers.allow).toBe('GET, POST');
    });

    it('rejects unauthenticated management requests with 401', async () => {
      const res = await call('GET', '/api/credentials');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('X-API-Key');
    });
  });

  describe('with no static keys configured (dev mode)', () => {
    beforeEach(() => start(undefined));

    it('refuses to mint credentials without authentication', async () => {
      const res = await call('POST', '/api/credentials', {
        body: { name: 'x', scopes: ['events:read'] },
      });
      expect(res.status).toBe(401);
      expect(credentialService.hasActiveCredentials()).toBe(false);
    });

    it('keeps protected endpoints open while no credentials exist', async () => {
      const res = await call('GET', '/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.data.principal).toBe('anonymous');
    });

    it('starts enforcing once a scoped credential exists', async () => {
      const created = await credentialService.create({ name: 'ci', scopes: ['events:read'] });

      expect((await call('GET', '/api/stats')).status).toBe(401);
      expect((await call('GET', '/api/stats', { key: created.apiKey })).status).toBe(403);
      expect((await call('GET', '/api/export', { key: 'some-random-key' })).status).toBe(401);
    });
  });
});
