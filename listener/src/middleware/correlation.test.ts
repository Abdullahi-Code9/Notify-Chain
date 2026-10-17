import http from 'http';
import type { AddressInfo } from 'net';
import * as StellarSDK from '@stellar/stellar-sdk';
import { runWithRequestCorrelation } from './correlation';
import {
  bindCorrelationContext,
  getCorrelationContext,
  getCorrelationId,
  runWithCorrelationContext,
} from '../utils/correlation-context';
import {
  isValidCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
  resolveCorrelationId,
} from '../utils/request-id';
import { withCorrelationMeta } from '../utils/logger';
import { EventProcessingQueue } from '../services/event-processing-queue';
import { sendErr, ErrorCode } from '../utils/response';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('isValidCorrelationId', () => {
  it.each(['req-12345', 'abc', 'svc:orders.v2_trace-1', '0b5f3c1e-6d2a-4f7e-9a1b-2c3d4e5f6a7b'])(
    'accepts %s',
    (value) => {
      expect(isValidCorrelationId(value)).toBe(true);
    },
  );

  it('accepts exactly the maximum length', () => {
    expect(isValidCorrelationId('a'.repeat(MAX_CORRELATION_ID_LENGTH))).toBe(true);
  });

  it.each([
    ['too long', 'a'.repeat(MAX_CORRELATION_ID_LENGTH + 1)],
    ['newline (log injection)', 'abc\nlevel=error msg=forged'],
    ['carriage return', 'abc\rdef'],
    ['null byte', 'abc\0def'],
    ['space', 'abc def'],
    ['quote', 'abc"def'],
    ['braces', '{"a":1}'],
    ['leading separator', '-abc'],
    ['empty', ''],
    ['non-ascii', 'café'],
  ])('rejects %s', (_label, value) => {
    expect(isValidCorrelationId(value)).toBe(false);
  });
});

describe('resolveCorrelationId', () => {
  it('generates a UUID v4 when the header is omitted', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V4);
  });

  it('generates distinct ids per call', () => {
    expect(resolveCorrelationId(undefined)).not.toBe(resolveCorrelationId(undefined));
  });

  it('reuses a valid client id', () => {
    expect(resolveCorrelationId('req-12345')).toBe('req-12345');
  });

  it('replaces an invalid client id with a fresh UUID instead of echoing it', () => {
    const malicious = 'id\r\nX-Injected: yes';
    const resolved = resolveCorrelationId(malicious);
    expect(resolved).not.toBe(malicious);
    expect(resolved).toMatch(UUID_V4);
  });

  it('replaces an oversized client id', () => {
    expect(resolveCorrelationId('a'.repeat(200))).toMatch(UUID_V4);
  });
});

describe('correlation context', () => {
  it('is undefined outside a request', () => {
    expect(getCorrelationContext()).toBeUndefined();
  });

  it('survives awaits inside the context', async () => {
    await runWithCorrelationContext({ correlationId: 'c-1', requestId: 'r-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getCorrelationId()).toBe('c-1');
    });
  });

  it('isolates concurrent contexts', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id, i) =>
        runWithCorrelationContext({ correlationId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 - i));
          seen.push(`${id}=${getCorrelationId()}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a=a', 'b=b', 'c=c']);
  });

  it('bindCorrelationContext restores the captured context later', () => {
    const bound = runWithCorrelationContext({ correlationId: 'captured' }, () =>
      bindCorrelationContext(() => getCorrelationId()),
    );
    expect(getCorrelationId()).toBeUndefined();
    expect(bound()).toBe('captured');
  });
});

describe('logger metadata propagation', () => {
  it('adds correlationId and requestId from the active context', () => {
    const meta = runWithCorrelationContext({ correlationId: 'c-9', requestId: 'r-9' }, () =>
      withCorrelationMeta({ count: 3 }),
    );
    expect(meta).toEqual({ count: 3, correlationId: 'c-9', requestId: 'r-9' });
  });

  it('keeps ids the caller supplied explicitly', () => {
    const meta = runWithCorrelationContext({ correlationId: 'ctx', requestId: 'ctx-r' }, () =>
      withCorrelationMeta({ correlationId: 'explicit', requestId: 'explicit-r' }),
    );
    expect(meta).toEqual({ correlationId: 'explicit', requestId: 'explicit-r' });
  });

  it('leaves metadata untouched outside a context', () => {
    const original = { a: 1 };
    expect(withCorrelationMeta(original)).toBe(original);
    expect(withCorrelationMeta(undefined)).toBeUndefined();
  });
});

describe('background job propagation', () => {
  it('runs queued work under the enqueuing request correlation id', async () => {
    let seenArg: string | undefined;
    let seenContext: string | undefined;
    const queue = new EventProcessingQueue(
      async (_event, _config, requestId) => {
        seenArg = requestId;
        seenContext = getCorrelationId();
        return true;
      },
      { baseDelayMs: 0, pollIntervalMs: 5 },
    );

    runWithCorrelationContext({ correlationId: 'req-from-api' }, () => {
      queue.enqueue(
        { id: 'evt-1' } as unknown as StellarSDK.rpc.Api.EventResponse,
        { address: 'CA1', events: [] } as never,
      );
    });

    queue.start();
    try {
      for (let i = 0; i < 100 && seenArg === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      queue.stop();
    }

    expect(seenArg).toBe('req-from-api');
    expect(seenContext).toBe('req-from-api');
  });
});

describe('runWithRequestCorrelation over HTTP', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) =>
      runWithRequestCorrelation(req, res, async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (req.url === '/fail') {
          sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ fromContext: getCorrelationId(), fromArg: ctx.correlationId }));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>(
      (resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(data) }),
          );
        });
        req.on('error', reject);
        req.end();
      },
    );
  }

  it('generates and returns a UUID when the client sends none', async () => {
    const res = await get('/');
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4);
    expect(res.body.fromContext).toBe(res.headers['x-correlation-id']);
  });

  it('echoes a valid client id and exposes it to the handler context', async () => {
    const res = await get('/', { 'X-Correlation-Id': 'req-12345' });
    expect(res.headers['x-correlation-id']).toBe('req-12345');
    expect(res.body).toEqual({ fromContext: 'req-12345', fromArg: 'req-12345' });
  });

  it('replaces an invalid client id', async () => {
    const res = await get('/', { 'X-Correlation-Id': 'bad id with spaces' });
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4);
  });

  it('stamps the correlation id into error envelopes', async () => {
    const res = await get('/fail', { 'X-Correlation-Id': 'req-err-1' });
    expect(res.status).toBe(404);
    expect(res.body.error.correlation_id).toBe('req-err-1');
  });
});
