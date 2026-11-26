import { Database } from '../database/database';
import {
  ApiIdempotencyService,
  ApiIdempotencyStore,
  InMemoryApiIdempotencyStore,
  SqliteApiIdempotencyStore,
  canonicalJson,
  computeRequestFingerprint,
  idempotencyScopeFor,
} from './api-idempotency-service';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TTL = 60_000;

function request(key: string | null, body: unknown = { reason: 'dup' }, path = '/api/schedule/1/cancel') {
  return { key, scope: 'client-a', method: 'POST', path, body };
}

describe('fingerprinting (#1114)', () => {
  it('is independent of object key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
    expect(computeRequestFingerprint('post', '/x', { a: 1, b: 2 })).toBe(
      computeRequestFingerprint('POST', '/x', { b: 2, a: 1 }),
    );
  });

  it('binds method and path', () => {
    const base = computeRequestFingerprint('POST', '/api/schedule/1/cancel', {});
    expect(computeRequestFingerprint('POST', '/api/schedule/2/cancel', {})).not.toBe(base);
    expect(computeRequestFingerprint('PUT', '/api/schedule/1/cancel', {})).not.toBe(base);
  });

  it('scopes keys per client without storing the raw API key', () => {
    expect(idempotencyScopeFor(undefined)).toBe('anonymous');
    const scope = idempotencyScopeFor('secret-key');
    expect(scope).not.toContain('secret-key');
    expect(scope).not.toBe(idempotencyScopeFor('other-key'));
  });
});

describe.each([
  ['in-memory', async () => ({ store: new InMemoryApiIdempotencyStore(), close: async () => undefined })],
  [
    'sqlite',
    async () => {
      const db = new Database(':memory:');
      await db.initialize();
      return { store: new SqliteApiIdempotencyStore(db), close: () => db.close() };
    },
  ],
] as Array<[string, () => Promise<{ store: ApiIdempotencyStore; close: () => Promise<void> }>]>)(
  'ApiIdempotencyService with %s store (#1114)',
  (_name, makeStore) => {
    let now: number;
    let service: ApiIdempotencyService;
    let close: () => Promise<void>;
    let handler: jest.Mock;

    beforeEach(async () => {
      now = Date.parse('2026-01-01T00:00:00.000Z');
      const made = await makeStore();
      close = made.close;
      service = new ApiIdempotencyService(made.store, { ttlMs: TTL, now: () => now });
      let calls = 0;
      handler = jest.fn(async () => ({ statusCode: 200, body: { success: true, data: { call: ++calls } } }));
    });

    afterEach(async () => {
      await close();
    });

    it('runs normally when no key is sent (backward compatible)', async () => {
      await service.execute(request(null), handler);
      const second = await service.execute(request(null), handler);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(second.headers).toEqual({});
      expect(second.replayed).toBe(false);
    });

    it('replays the stored response for an identical retry', async () => {
      const first = await service.execute(request('k1'), handler);
      const retry = await service.execute(request('k1', { reason: 'dup' }), handler);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(retry.replayed).toBe(true);
      expect(retry.response).toEqual(first.response);
      expect(retry.headers['Idempotent-Replayed']).toBe('true');
    });

    it('rejects a different payload under an active key', async () => {
      await service.execute(request('k1'), handler);
      const conflict = await service.execute(request('k1', { reason: 'other' }), handler);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(conflict.response.statusCode).toBe(409);
      expect((conflict.response.body as any).error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    it('rejects reuse of a key on a different endpoint', async () => {
      await service.execute(request('k1'), handler);
      const conflict = await service.execute(request('k1', { reason: 'dup' }, '/api/schedule/2/cancel'), handler);
      expect(conflict.response.statusCode).toBe(409);
    });

    it('allows the key to be reused once expired', async () => {
      await service.execute(request('k1'), handler);
      now += TTL + 1;
      const reused = await service.execute(request('k1', { reason: 'new payload' }), handler);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(reused.replayed).toBe(false);
      expect(reused.response.statusCode).toBe(200);
    });

    it('still replays just before expiry', async () => {
      await service.execute(request('k1'), handler);
      now += TTL - 1;
      expect((await service.execute(request('k1'), handler)).replayed).toBe(true);
    });

    it('caches client errors but not server errors', async () => {
      const notFound = jest.fn(async () => ({ statusCode: 404, body: { success: false } }));
      await service.execute(request('k404'), notFound);
      expect((await service.execute(request('k404'), notFound)).replayed).toBe(true);

      const failing = jest
        .fn()
        .mockResolvedValueOnce({ statusCode: 503, body: { success: false } })
        .mockResolvedValueOnce({ statusCode: 200, body: { success: true } });
      await service.execute(request('k503'), failing);
      const retried = await service.execute(request('k503'), failing);
      expect(failing).toHaveBeenCalledTimes(2);
      expect(retried.response.statusCode).toBe(200);
    });

    it('releases the key when the handler throws', async () => {
      const throwing = jest.fn().mockRejectedValueOnce(new Error('boom'));
      await expect(service.execute(request('kt'), throwing)).rejects.toThrow('boom');
      expect((await service.execute(request('kt'), handler)).replayed).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects a concurrent duplicate while the first request is in flight', async () => {
      let finish!: () => void;
      const slow = jest.fn(
        () =>
          new Promise<{ statusCode: number; body: unknown }>((resolve) => {
            finish = () => resolve({ statusCode: 200, body: { ok: true } });
          }),
      );
      const first = service.execute(request('kc'), slow);
      // Let begin() claim the key before the duplicate arrives.
      await new Promise((r) => setTimeout(r, 20));
      const duplicate = await service.execute(request('kc'), handler);
      expect(duplicate.response.statusCode).toBe(409);
      expect((duplicate.response.body as any).error.code).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
      finish();
      await first;
      expect(handler).not.toHaveBeenCalled();
    });

    it.each(['', 'has space', 'x'.repeat(256), 'ünicode'])('rejects invalid key %p', async (key) => {
      const result = await service.execute(request(key), handler);
      expect(result.response.statusCode).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    });

    it('purges expired records', async () => {
      await service.execute(request('k1'), handler);
      now += TTL + 1;
      expect(await service.purgeExpired()).toBe(1);
    });
  },
);

describe('ApiIdempotencyService failure handling', () => {
  it('fails closed with 503 when the store is unavailable', async () => {
    const store = {
      begin: jest.fn().mockRejectedValue(new Error('db down')),
      complete: jest.fn(),
      abandon: jest.fn(),
      purgeExpired: jest.fn(),
    };
    const handler = jest.fn();
    const result = await new ApiIdempotencyService(store).execute(request('k1'), handler);
    expect(result.response.statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the handler result even if storing it fails', async () => {
    const store = {
      begin: jest.fn().mockResolvedValue({ kind: 'proceed' }),
      complete: jest.fn().mockRejectedValue(new Error('disk full')),
      abandon: jest.fn(),
      purgeExpired: jest.fn(),
    };
    const result = await new ApiIdempotencyService(store).execute(request('k1'), async () => ({
      statusCode: 200,
      body: { done: true },
    }));
    expect(result.response).toEqual({ statusCode: 200, body: { done: true } });
  });
});
