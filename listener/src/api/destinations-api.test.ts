import http from 'http';
import { PassThrough } from 'stream';
import { Database } from '../database/database';
import { ApiCredentialService } from '../services/api-credential-service';
import { DestinationService } from '../services/destination-service';
import { handleCredentialRoutes } from './credentials-api';
import { handleDestinationRoutes } from './destinations-api';
import { normaliseApiPath, ROUTE_CATALOG } from './api-version-registry';
import { type ApiKeyEntry } from './api-key-auth';
import { runWithRequestCorrelation } from '../middleware/correlation';
import { sendErr, ErrorCode } from '../utils/response';
import { DEFAULT_LEGACY_DESTINATION_OWNER_ID } from '../migrations/008-destination-ownership';

jest.mock('../utils/logger', () => {
  const actual = jest.requireActual('../utils/logger');
  return {
    __esModule: true,
    ...actual,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    sanitizeUrl: (u: string) => u,
  };
});

interface HttpRes {
  status: number;
  headers: Record<string, string | string[]>;
  body: any;
}

const KEY_USER_A = 'nc_user_a_static_key_0001';
const KEY_USER_B = 'nc_user_b_static_key_0002';

function dispatchRequest(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
  method: string,
  path: string,
  options: { key?: string; body?: unknown } = {},
): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough() as unknown as http.IncomingMessage;
    const headers: Record<string, string> = {};
    if (options.key) headers['x-api-key'] = options.key;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (payload !== undefined) headers['content-type'] = 'application/json';

    stream.method = method;
    stream.url = path;
    stream.headers = headers;
    (stream as any).socket = { remoteAddress: '127.0.0.1' };

    const resHeaders: Record<string, string | string[]> = {};
    let statusCode = 200;
    let responseBody = '';

    const res = {
      statusCode,
      setHeader(name: string, value: string | string[]) {
        resHeaders[name.toLowerCase()] = value;
      },
      getHeader(name: string) {
        return resHeaders[name.toLowerCase()];
      },
      removeHeader(name: string) {
        delete resHeaders[name.toLowerCase()];
      },
      writeHead(code: number, hdrs?: Record<string, string | string[]>) {
        statusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[k.toLowerCase()] = v;
          }
        }
        return this;
      },
      write(chunk: unknown) {
        responseBody += String(chunk);
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) responseBody += String(chunk);
        try {
          resolve({
            status: statusCode,
            headers: resHeaders,
            body: responseBody ? JSON.parse(responseBody) : null,
          });
        } catch (err) {
          reject(err);
        }
      },
    } as unknown as http.ServerResponse;

    handler(stream, res).catch(reject);

    process.nextTick(() => {
      if (payload !== undefined) {
        (stream as unknown as PassThrough).write(payload);
      }
      (stream as unknown as PassThrough).end();
    });
  });
}

describe('destinations API ownership enforcement', () => {
  let db: Database;
  let credentialService: ApiCredentialService;
  let destinationService: DestinationService;
  const apiKeys: ApiKeyEntry[] = [
    { key: KEY_USER_A, name: 'user-a' },
    { key: KEY_USER_B, name: 'user-b' },
  ];

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    await runWithRequestCorrelation(req, res, async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      url.pathname = normaliseApiPath(url.pathname).normalisedPath;

      if (await handleCredentialRoutes(req, res, url, { credentialService, apiKeys })) return;
      if (
        await handleDestinationRoutes(req, res, url, {
          destinationService,
          credentialService,
          apiKeys,
        })
      ) {
        return;
      }
      sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
    });
  };

  const call = (method: string, path: string, options?: { key?: string; body?: unknown }) =>
    dispatchRequest(handle, method, path, options);

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
    credentialService = new ApiCredentialService();
    destinationService = new DestinationService({
      db,
      testSender: async () => ({ success: true, message: 'Delivered', latencyMs: 15 }),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('isolates destinations across users and prevents unauthorized modification/deletion', async () => {
    // User A creates a destination
    const createRes = await call('POST', '/api/destinations', {
      key: KEY_USER_A,
      body: {
        provider: 'webhook',
        displayName: 'Alpha Hook',
        settings: { url: 'https://alpha.example.com/hook' },
        secrets: { signingSecret: 'alpha-signing-secret-1234' },
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.headers['cache-control']).toBe('no-store');
    expect(createRes.body.ownerId).toMatch(/^legacy:/);
    expect(createRes.body.secrets.signingSecret).toEqual({ isSet: true, last4: '1234' });
    const destId = createRes.body.id;

    // User A sees it; User B does not
    const listA = await call('GET', '/api/destinations', { key: KEY_USER_A });
    expect(listA.status).toBe(200);
    expect(listA.body.destinations).toHaveLength(1);

    const listB = await call('GET', '/api/destinations', { key: KEY_USER_B });
    expect(listB.status).toBe(200);
    expect(listB.body.destinations).toHaveLength(0);

    // User B cannot lookup, modify, test, or delete User A's destination
    expect((await call('GET', `/api/destinations/${destId}`, { key: KEY_USER_B })).status).toBe(
      403,
    );
    expect(
      (
        await call('PUT', `/api/destinations/${destId}`, {
          key: KEY_USER_B,
          body: { enabled: false, settings: { url: 'https://evil.example.com' } },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('POST', `/api/destinations/${destId}/test`, { key: KEY_USER_B, body: {} }))
        .status,
    ).toBe(403);
    expect((await call('DELETE', `/api/destinations/${destId}`, { key: KEY_USER_B })).status).toBe(
      403,
    );

    // User A's destination remains unmodified
    const getA = await call('GET', `/api/destinations/${destId}`, { key: KEY_USER_A });
    expect(getA.status).toBe(200);
    expect(getA.body.settings.url).toBe('https://alpha.example.com/hook');

    // User A can update, test, and delete their own destination (including /api/v1/ prefix)
    const putA = await call('PUT', `/api/v1/destinations/${destId}`, {
      key: KEY_USER_A,
      body: { enabled: true, settings: { url: 'https://alpha.example.com/hook-v2' } },
    });
    expect(putA.status).toBe(200);
    expect(putA.body.settings.url).toBe('https://alpha.example.com/hook-v2');

    const testA = await call('POST', `/api/destinations/${destId}/test`, {
      key: KEY_USER_A,
      body: {},
    });
    expect(testA.status).toBe(200);
    expect(testA.body.success).toBe(true);

    const delA = await call('DELETE', `/api/destinations/${destId}`, { key: KEY_USER_A });
    expect(delA.status).toBe(200);
    expect(delA.body).toEqual({ deleted: true, id: destId });
  });

  it('enforces scoped credentials and rejects cross-account body ownerId spoofing', async () => {
    const credA = (
      await call('POST', '/api/credentials', {
        key: KEY_USER_A,
        body: { name: 'svc-a', scopes: ['webhooks:manage'] },
      })
    ).body.data;
    const credB = (
      await call('POST', '/api/credentials', {
        key: KEY_USER_A,
        body: { name: 'svc-b', scopes: ['webhooks:manage'] },
      })
    ).body.data;
    const readOnlyCred = (
      await call('POST', '/api/credentials', {
        key: KEY_USER_A,
        body: { name: 'readonly', scopes: ['events:read'] },
      })
    ).body.data;

    // Missing auth -> 401
    expect((await call('GET', '/api/destinations')).status).toBe(401);

    // Missing webhooks:manage scope -> 403 INVALID_PERMISSIONS
    const noScope = await call('GET', '/api/destinations', { key: readOnlyCred.apiKey });
    expect(noScope.status).toBe(403);
    expect(noScope.body.error.code).toBe('INVALID_PERMISSIONS');

    // Spoofing another ownerId in POST body -> 403 FORBIDDEN
    const spoofCreate = await call('POST', '/api/destinations', {
      key: credA.apiKey,
      body: {
        provider: 'webhook',
        ownerId: `credential:${credB.id}`,
        settings: { url: 'https://example.com/spoof' },
        secrets: { signingSecret: 'secret-value-1234' },
      },
    });
    expect(spoofCreate.status).toBe(403);

    // Cred A creates destination, Cred B cannot touch it
    const created = await call('POST', '/api/destinations', {
      key: credA.apiKey,
      body: {
        provider: 'webhook',
        settings: { url: 'https://example.com/cred-a' },
        secrets: { signingSecret: 'secret-value-5678' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.ownerId).toBe(`credential:${credA.id}`);

    expect(
      (await call('GET', `/api/destinations/${created.body.id}`, { key: credB.apiKey })).status,
    ).toBe(403);
  });

  it('quarantines legacy migrated records from arbitrary users', async () => {
    await db.run(
      `INSERT INTO destinations (id, owner_id, provider, display_name, enabled, status, settings_json, secrets_json)
       VALUES ('legacy-dest-1', ?, 'webhook', 'Legacy Hook', 1, 'connected', '{"url":"https://legacy.example.com/hook"}', '{"signingSecret":"legacy-secret-1234"}')`,
      [DEFAULT_LEGACY_DESTINATION_OWNER_ID],
    );

    const listA = await call('GET', '/api/destinations', { key: KEY_USER_A });
    expect(listA.status).toBe(200);
    expect(listA.body.destinations).toEqual([]);

    expect((await call('GET', '/api/destinations/legacy-dest-1', { key: KEY_USER_A })).status).toBe(
      403,
    );
    expect(
      (await call('DELETE', '/api/destinations/legacy-dest-1', { key: KEY_USER_B })).status,
    ).toBe(403);
  });

  it('registers destination endpoints in ROUTE_CATALOG', () => {
    const destRoutes = ROUTE_CATALOG.filter((r) => r.path.startsWith('/api/destinations'));
    expect(destRoutes.length).toBeGreaterThanOrEqual(6);
  });
});
