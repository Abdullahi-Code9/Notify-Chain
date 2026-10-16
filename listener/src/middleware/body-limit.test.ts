/**
 * Request body size limit tests.
 *
 * Boundary conditions matter most here: a limit that is off by one byte in
 * either direction either rejects legitimate payloads or leaves the ceiling
 * unenforced.
 */

import { EventEmitter } from 'events';
import {
  DEFAULT_MAX_BODY_BYTES,
  enforceBodyLimit,
  parseContentLength,
} from './body-limit';

// ── Test doubles ────────────────────────────────────────────────────────────

interface FakeRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  destroy: jest.Mock;
}

function makeRequest(
  method = 'POST',
  headers: Record<string, string | undefined> = {},
): FakeRequest {
  const req = new EventEmitter() as FakeRequest;
  req.method = method;
  req.url = '/api/notifications';
  req.headers = headers;
  req.destroy = jest.fn();
  return req;
}

interface FakeResponse {
  headersSent: boolean;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  writeHead: jest.Mock;
  end: jest.Mock;
}

function makeResponse(headersSent = false): FakeResponse {
  const res: FakeResponse = {
    headersSent,
    writeHead: jest.fn(function (this: void, status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    }),
    end: jest.fn(function (this: void, body?: string) {
      res.body = body;
    }),
  };
  return res;
}

function enforce(
  req: FakeRequest,
  res: FakeResponse,
  maxBytes: number,
  onRejected?: jest.Mock,
) {
  return enforceBodyLimit(req as never, res as never, { maxBytes, onRejected });
}

// ── parseContentLength ──────────────────────────────────────────────────────

describe('parseContentLength', () => {
  it('parses a well-formed header', () => {
    expect(parseContentLength('1024')).toBe(1024);
    expect(parseContentLength(' 512 ')).toBe(512);
  });

  it('accepts zero', () => {
    expect(parseContentLength('0')).toBe(0);
  });

  it('takes the first value of a repeated header', () => {
    expect(parseContentLength(['100', '200'])).toBe(100);
  });

  it('returns null for missing, malformed or negative values', () => {
    // Null, not a guess: the streaming counter is the backstop for these.
    expect(parseContentLength(undefined)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('abc')).toBeNull();
    expect(parseContentLength('-1')).toBeNull();
  });
});

// ── Content-Length screening ────────────────────────────────────────────────

describe('body limit — Content-Length screening', () => {
  it('rejects a declared size above the limit before reading a byte', () => {
    const req = makeRequest('POST', { 'content-length': '2048' });
    const res = makeResponse();

    const result = enforce(req, res, 1024);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('content-length-exceeded');
    expect(res.statusCode).toBe(413);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('accepts a declared size exactly at the limit', () => {
    // The bound is inclusive — exactly max is a legitimate payload.
    const req = makeRequest('POST', { 'content-length': '1024' });
    const res = makeResponse();

    expect(enforce(req, res, 1024).allowed).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('rejects one byte over the limit', () => {
    const req = makeRequest('POST', { 'content-length': '1025' });
    const res = makeResponse();

    expect(enforce(req, res, 1024).allowed).toBe(false);
  });

  it('accepts one byte under the limit', () => {
    const req = makeRequest('POST', { 'content-length': '1023' });
    const res = makeResponse();

    expect(enforce(req, res, 1024).allowed).toBe(true);
  });

  it('responds with a machine-readable 413 payload', () => {
    const req = makeRequest('POST', { 'content-length': '5000' });
    const res = makeResponse();

    enforce(req, res, 1024);

    expect(res.headers?.['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(res.body ?? '{}');
    expect(parsed.code).toBe('PAYLOAD_TOO_LARGE');
    expect(parsed.maxBytes).toBe(1024);
    expect(parsed.observedBytes).toBe(5000);
  });

  it('notifies the caller with the reason and observed size', () => {
    const onRejected = jest.fn();
    const req = makeRequest('POST', { 'content-length': '5000' });

    enforce(req, makeResponse(), 1024, onRejected);

    expect(onRejected).toHaveBeenCalledWith('content-length-exceeded', 5000);
  });
});

// ── Streaming enforcement ───────────────────────────────────────────────────

describe('body limit — streaming enforcement', () => {
  it('rejects a body that overruns without declaring a Content-Length', () => {
    // Chunked transfers carry no Content-Length, so the counter is the only
    // thing bounding memory here.
    const req = makeRequest('POST', {});
    const res = makeResponse();
    const onRejected = jest.fn();

    expect(enforce(req, res, 10, onRejected).allowed).toBe(true);

    req.emit('data', Buffer.alloc(6));
    expect(res.writeHead).not.toHaveBeenCalled();

    req.emit('data', Buffer.alloc(6)); // 12 total, over the limit
    expect(res.statusCode).toBe(413);
    expect(req.destroy).toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith('stream-exceeded', 12);
  });

  it('rejects a body that understates its Content-Length', () => {
    // A client claiming 5 bytes and sending 100 must still be stopped.
    const req = makeRequest('POST', { 'content-length': '5' });
    const res = makeResponse();

    expect(enforce(req, res, 10).allowed).toBe(true);

    req.emit('data', Buffer.alloc(100));

    expect(res.statusCode).toBe(413);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('allows a stream that stays exactly at the limit', () => {
    const req = makeRequest('POST', {});
    const res = makeResponse();

    enforce(req, res, 10);
    req.emit('data', Buffer.alloc(10));
    req.emit('end');

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it('rejects at exactly one byte past the limit', () => {
    const req = makeRequest('POST', {});
    const res = makeResponse();

    enforce(req, res, 10);
    req.emit('data', Buffer.alloc(11));

    expect(res.statusCode).toBe(413);
  });

  it('counts string chunks by byte length, not character count', () => {
    // A 4-character emoji is 4 bytes in UTF-8 per character here; counting
    // characters would let roughly 4x the intended payload through.
    const req = makeRequest('POST', {});
    const res = makeResponse();

    enforce(req, res, 8);
    req.emit('data', '🚀🚀🚀'); // 12 bytes, 3 code points

    expect(res.statusCode).toBe(413);
  });

  it('responds only once no matter how many chunks arrive after the overrun', () => {
    const req = makeRequest('POST', {});
    const res = makeResponse();
    const onRejected = jest.fn();

    enforce(req, res, 5, onRejected);
    req.emit('data', Buffer.alloc(10));
    req.emit('data', Buffer.alloc(10));
    req.emit('data', Buffer.alloc(10));

    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not write a second response when headers were already sent', () => {
    // A handler may have started responding before the stream overran;
    // writing again would replace a useful error with an unhandled throw.
    const req = makeRequest('POST', {});
    const res = makeResponse(true);

    enforce(req, res, 5);
    req.emit('data', Buffer.alloc(10));

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(req.destroy).toHaveBeenCalled();
  });
});

// ── Methods without bodies ──────────────────────────────────────────────────

describe('body limit — methods without bodies', () => {
  it.each(['GET', 'DELETE', 'HEAD', 'OPTIONS'])(
    'passes %s through without screening',
    (method) => {
      const req = makeRequest(method, { 'content-length': '999999' });
      const res = makeResponse();

      expect(enforce(req, res, 10).allowed).toBe(true);
      expect(res.writeHead).not.toHaveBeenCalled();
    },
  );

  it.each(['POST', 'PUT', 'PATCH'])('screens %s', (method) => {
    const req = makeRequest(method, { 'content-length': '999999' });
    const res = makeResponse();

    expect(enforce(req, res, 10).allowed).toBe(false);
  });

  it('treats a lowercase method name as its uppercase equivalent', () => {
    const req = makeRequest('post', { 'content-length': '999999' });
    const res = makeResponse();

    expect(enforce(req, res, 10).allowed).toBe(false);
  });
});

// ── Defaults ────────────────────────────────────────────────────────────────

describe('body limit — defaults', () => {
  it('defaults to 1 MiB', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it('uses the default when no limit is supplied', () => {
    const req = makeRequest('POST', { 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) });
    const res = makeResponse();

    const result = enforceBodyLimit(req as never, res as never);

    expect(result.allowed).toBe(false);
  });
});
