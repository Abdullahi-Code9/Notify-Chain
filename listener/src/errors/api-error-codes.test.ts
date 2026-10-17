import http from 'http';
import type { AddressInfo } from 'net';
import { ERROR_CODE_CATALOG, ErrorCode, isKnownErrorCode } from './api-error-codes';
import { err, sendErr } from '../utils/response';
import { ApiError, handleApiError } from '../api/error-handler';
import { ValidationError } from '../utils/validation';
import { runWithRequestCorrelation } from '../middleware/correlation';
import { runWithCorrelationContext } from '../utils/correlation-context';

jest.mock('../utils/logger', () => {
  const actual = jest.requireActual('../utils/logger');
  return {
    __esModule: true,
    ...actual,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

const STABLE_CODE = /^[A-Z][A-Z0-9_]*$/;

describe('error code catalog', () => {
  it('documents every code with an HTTP status and description', () => {
    for (const code of Object.values(ErrorCode)) {
      const entry = ERROR_CODE_CATALOG[code];
      expect(entry).toBeDefined();
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('uses SCREAMING_SNAKE_CASE values equal to their keys', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
      expect(value).toMatch(STABLE_CODE);
    }
  });

  it('includes the codes required by the API contract', () => {
    for (const code of [
      'UNAUTHORIZED',
      'INVALID_PERMISSIONS',
      'NOT_FOUND',
      'RATE_LIMITED',
      'VALIDATION_ERROR',
      'INTERNAL_ERROR',
    ]) {
      expect(isKnownErrorCode(code)).toBe(true);
    }
  });

  it('maps INVALID_PERMISSIONS to 403 and UNAUTHORIZED to 401', () => {
    expect(ERROR_CODE_CATALOG.INVALID_PERMISSIONS.status).toBe(403);
    expect(ERROR_CODE_CATALOG.UNAUTHORIZED.status).toBe(401);
  });

  it('rejects unknown codes', () => {
    expect(isKnownErrorCode('SOMETHING_ELSE')).toBe(false);
    expect(isKnownErrorCode('toString')).toBe(false);
  });
});

describe('err() envelope', () => {
  it('always includes details, defaulting to an empty array', () => {
    expect(err('Nope', ErrorCode.NOT_FOUND, undefined, undefined)).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Nope', details: [] },
    });
  });

  it('carries supplied details through unchanged', () => {
    const details = [{ field: 'name', message: 'required' }];
    expect(err('Bad', ErrorCode.VALIDATION_ERROR, details).error.details).toBe(details);
  });

  it('picks up the active correlation id', () => {
    const envelope = runWithCorrelationContext({ correlationId: 'req-12345' }, () =>
      err(
        'The provided credentials lack the necessary scope for this action.',
        ErrorCode.INVALID_PERMISSIONS,
      ),
    );
    expect(envelope).toEqual({
      success: false,
      error: {
        code: 'INVALID_PERMISSIONS',
        message: 'The provided credentials lack the necessary scope for this action.',
        details: [],
        correlation_id: 'req-12345',
      },
    });
  });

  it('prefers an explicit correlation id over the context', () => {
    const envelope = runWithCorrelationContext({ correlationId: 'ctx' }, () =>
      err('x', ErrorCode.CONFLICT, undefined, 'explicit'),
    );
    expect(envelope.error.correlation_id).toBe('explicit');
  });

  it('omits correlation_id when none is known', () => {
    expect(err('x', ErrorCode.CONFLICT)).not.toHaveProperty('error.correlation_id');
  });
});

describe('error paths over HTTP', () => {
  let server: http.Server;
  let port: number;

  const routes: Record<string, (res: http.ServerResponse) => void> = {
    '/api-error/not-found': (res) => handleApiError(res, ApiError.notFound('Thing not found')),
    '/api-error/unauthorized': (res) => handleApiError(res, ApiError.unauthorized('No key')),
    '/api-error/forbidden': (res) =>
      handleApiError(
        res,
        ApiError.invalidPermissions(undefined, [{ missingScopes: ['stats:read'] }]),
      ),
    '/api-error/rate-limited': (res) => handleApiError(res, ApiError.rateLimited('Slow down')),
    '/api-error/bad-request': (res) => handleApiError(res, ApiError.badRequest('Bad input')),
    '/api-error/unavailable': (res) => handleApiError(res, ApiError.serviceUnavailable('Off')),
    '/validation': (res) =>
      handleApiError(res, new ValidationError([{ field: 'name', message: 'name is required' }])),
    '/unknown-throw': (res) => handleApiError(res, new Error('boom')),
    '/send-err': (res) => sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND),
  };

  beforeAll(async () => {
    server = http.createServer((req, res) =>
      runWithRequestCorrelation(req, res, () => routes[req.url ?? '']?.(res)),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(path: string, correlationId: string) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>(
      (resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path, headers: { 'X-Correlation-Id': correlationId } },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: JSON.parse(data),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
  }

  it.each([
    ['/api-error/not-found', 404, 'NOT_FOUND'],
    ['/api-error/unauthorized', 401, 'UNAUTHORIZED'],
    ['/api-error/forbidden', 403, 'INVALID_PERMISSIONS'],
    ['/api-error/rate-limited', 429, 'RATE_LIMITED'],
    ['/api-error/bad-request', 400, 'BAD_REQUEST'],
    ['/api-error/unavailable', 503, 'SERVICE_UNAVAILABLE'],
    ['/validation', 400, 'BAD_REQUEST'],
    ['/unknown-throw', 500, 'INTERNAL_ERROR'],
    ['/send-err', 404, 'NOT_FOUND'],
  ])('%s → %i %s in the standard envelope', async (path, status, code) => {
    const correlationId = `req-${status}-${code.toLowerCase()}`;
    const res = await get(path, correlationId);

    expect(res.status).toBe(status);
    expect(res.headers['x-correlation-id']).toBe(correlationId);
    expect(res.body.success).toBe(false);
    expect(Object.keys(res.body.error).sort()).toEqual(
      ['code', 'correlation_id', 'details', 'message'].sort(),
    );
    expect(res.body.error.code).toBe(code);
    expect(isKnownErrorCode(res.body.error.code)).toBe(true);
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.details).toBeDefined();
    expect(res.body.error.correlation_id).toBe(correlationId);
  });

  it('includes scope details for INVALID_PERMISSIONS', async () => {
    const res = await get('/api-error/forbidden', 'req-scope');
    expect(res.body.error.details).toEqual([{ missingScopes: ['stats:read'] }]);
  });
});
