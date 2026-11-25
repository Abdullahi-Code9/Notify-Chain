import http from 'http';
import type { AddressInfo } from 'net';
import {
  computeETag,
  ETAG_CACHE_CONTROL,
  ifNoneMatchSatisfied,
  sendJsonWithETag,
  sendOkWithETag,
} from './etag';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('computeETag', () => {
  it('produces a quoted strong tag', () => {
    expect(computeETag('{"a":1}')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('is deterministic for identical bodies', () => {
    expect(computeETag('{"events":[]}')).toBe(computeETag('{"events":[]}'));
  });

  it('changes when the body changes', () => {
    expect(computeETag('{"count":1}')).not.toBe(computeETag('{"count":2}'));
  });
});

describe('ifNoneMatchSatisfied', () => {
  const etag = '"abc"';

  it.each([
    ['exact match', '"abc"', true],
    ['weak form of same tag', 'W/"abc"', true],
    ['list containing the tag', '"x", "abc" , "y"', true],
    ['wildcard', '*', true],
    ['different tag', '"def"', false],
    ['unquoted value', 'abc', false],
    ['empty header', '', false],
    ['whitespace header', '   ', false],
  ])('%s', (_label, header, expected) => {
    expect(ifNoneMatchSatisfied(header, etag)).toBe(expected);
  });

  it('returns false when the header is absent', () => {
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
  });

  it('accepts repeated header values', () => {
    expect(ifNoneMatchSatisfied(['"x"', '"abc"'], etag)).toBe(true);
  });
});

describe('conditional responses over HTTP', () => {
  let server: http.Server;
  let port: number;
  let data: { count: number; events: string[] };
  let statusCode: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (statusCode === 200) {
        sendOkWithETag(req, res, data);
      } else {
        sendJsonWithETag(req, res, statusCode, { success: false });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    data = { count: 1, events: ['e1'] };
    statusCode = 200;
  });

  it('includes an ETag and revalidation Cache-Control on GET', async () => {
    const res = await request(port);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(computeETag(res.body));
    expect(res.headers['cache-control']).toBe(ETAG_CACHE_CONTROL);
    expect(JSON.parse(res.body)).toEqual({ success: true, data });
  });

  it('returns the same ETag for unchanged data', async () => {
    const first = await request(port);
    const second = await request(port);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('short-circuits with an empty 304 when If-None-Match matches', async () => {
    const { headers } = await request(port);
    const res = await request(port, { headers: { 'If-None-Match': headers.etag as string } });
    expect(res.status).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(headers.etag);
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('returns 304 for a weak validator of the current tag', async () => {
    const { headers } = await request(port);
    const res = await request(port, { headers: { 'If-None-Match': `W/${headers.etag}` } });
    expect(res.status).toBe(304);
  });

  it('returns the full body when If-None-Match does not match', async () => {
    const res = await request(port, { headers: { 'If-None-Match': '"stale"' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).data).toEqual(data);
  });

  it('invalidates the cached tag when the underlying data changes', async () => {
    const before = await request(port);
    data = { count: 2, events: ['e1', 'e2'] };

    const after = await request(port, {
      headers: { 'If-None-Match': before.headers.etag as string },
    });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(JSON.parse(after.body).data.count).toBe(2);
  });

  it('serves HEAD with the ETag but no body', async () => {
    const get = await request(port);
    const head = await request(port, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.body).toBe('');
  });

  it('does not make non-200 responses conditional', async () => {
    statusCode = 503;
    const res = await request(port, { headers: { 'If-None-Match': '*' } });
    expect(res.status).toBe(503);
    expect(res.headers.etag).toBeUndefined();
  });

  it('does not make non-GET requests conditional', async () => {
    const res = await request(port, { method: 'POST', headers: { 'If-None-Match': '*' } });
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });
});
