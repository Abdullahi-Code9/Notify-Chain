/**
 * Compressed request body limit tests (issue #999).
 *
 * The interesting cases are adversarial: a small compressed payload that
 * inflates past the ceiling, an unsupported coding, and a body that claims to
 * be gzip but is not. Each must be refused with a coded response rather than
 * reaching a handler or exhausting memory.
 */

import { Readable } from 'stream';
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
} from 'zlib';
import {
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  DecompressedTooLargeError,
  CompressedTooLargeError,
  MalformedEncodingError,
  applyDecompressionLimit,
  inflateWithLimit,
  isSupportedEncoding,
  parseContentEncoding,
  readStreamWithLimit,
} from './decompression-limit';

// ── Test doubles ────────────────────────────────────────────────────────────

interface FakeRequest extends Readable {
  headers: Record<string, string | undefined>;
  destroy: jest.Mock;
}

function makeRequest(body: Buffer | string, headers: Record<string, string | undefined> = {}): FakeRequest {
  const req = Readable.from([typeof body === 'string' ? Buffer.from(body) : body]) as FakeRequest;
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

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    headersSent: false,
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

// ── parseContentEncoding ────────────────────────────────────────────────────

describe('parseContentEncoding', () => {
  it('treats a missing header as no encoding', () => {
    expect(parseContentEncoding(undefined)).toBeUndefined();
  });

  it('treats an empty or identity header as no encoding', () => {
    expect(parseContentEncoding('')).toBeUndefined();
    expect(parseContentEncoding('identity')).toBeUndefined();
    expect(parseContentEncoding(' Identity ')).toBeUndefined();
  });

  it('lower-cases and trims the encoding', () => {
    expect(parseContentEncoding('GZip')).toBe('gzip');
    expect(parseContentEncoding(' X-GZIP ')).toBe('x-gzip');
    expect(parseContentEncoding('br')).toBe('br');
  });

  it('takes the first value of a repeated header', () => {
    expect(parseContentEncoding(['gzip', 'br'])).toBe('gzip');
  });

  it('surfaces stacked codings so the caller can reject them', () => {
    expect(parseContentEncoding('gzip, br')).toBe('gzip, br');
  });
});

describe('isSupportedEncoding', () => {
  it.each(['gzip', 'x-gzip', 'deflate', 'br'])('accepts %s', (encoding) => {
    expect(isSupportedEncoding(encoding)).toBe(true);
  });

  it.each(['zstd', 'gzip, br', 'compress', 'identity'])('rejects %s', (encoding) => {
    expect(isSupportedEncoding(encoding)).toBe(false);
  });
});

// ── readStreamWithLimit ─────────────────────────────────────────────────────

describe('readStreamWithLimit', () => {
  it('reads a body that stays within the limit', async () => {
    const req = makeRequest('hello');
    await expect(readStreamWithLimit(req, 10)).resolves.toEqual(Buffer.from('hello'));
  });

  it('allows a body exactly at the limit', async () => {
    const req = makeRequest('12345');
    await expect(readStreamWithLimit(req, 5)).resolves.toHaveLength(5);
  });

  it('rejects the moment the body crosses the limit', async () => {
    const req = makeRequest('123456');
    await expect(readStreamWithLimit(req, 5)).rejects.toBeInstanceOf(CompressedTooLargeError);
  });

  it('counts string chunks by byte length', async () => {
    const req = makeRequest('🚀'); // 4 UTF-8 bytes, 1 code point
    await expect(readStreamWithLimit(req, 3)).rejects.toBeInstanceOf(CompressedTooLargeError);
  });
});

// ── inflateWithLimit ────────────────────────────────────────────────────────

describe('inflateWithLimit', () => {
  const payload = Buffer.from(JSON.stringify({ hello: 'world', items: [1, 2, 3] }));

  it.each([
    ['gzip', gzipSync],
    ['x-gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ])('round-trips a %s body', async (encoding, compress) => {
    const compressed = compress(payload);
    const decoded = await inflateWithLimit(compressed, encoding, DEFAULT_MAX_DECOMPRESSED_BYTES);
    expect(decoded).toEqual(payload);
  });

  it('allows output exactly at the decompressed limit', async () => {
    const compressed = gzipSync(payload);
    const decoded = await inflateWithLimit(compressed, 'gzip', payload.length);
    expect(decoded).toEqual(payload);
  });

  it('rejects output one byte over the decompressed limit', async () => {
    const compressed = gzipSync(payload);
    await expect(inflateWithLimit(compressed, 'gzip', payload.length - 1)).rejects.toBeInstanceOf(
      DecompressedTooLargeError,
    );
  });

  it('rejects a decompression bomb before buffering the whole expansion', async () => {
    // 1 MiB of zeros compresses to a few hundred bytes but inflates well past a
    // tight ceiling — exactly the shape this guard exists to stop.
    const bomb = gzipSync(Buffer.alloc(1_000_000));
    expect(bomb.length).toBeLessThan(2_000);
    await expect(inflateWithLimit(bomb, 'gzip', 1024)).rejects.toBeInstanceOf(
      DecompressedTooLargeError,
    );
  });

  it('rejects a body that claims to be gzip but is not', async () => {
    await expect(
      inflateWithLimit(Buffer.from('definitely not gzip'), 'gzip', DEFAULT_MAX_DECOMPRESSED_BYTES),
    ).rejects.toBeInstanceOf(MalformedEncodingError);
  });

  it('rejects a truncated gzip stream', async () => {
    const truncated = gzipSync(payload).subarray(0, 5);
    await expect(
      inflateWithLimit(truncated, 'gzip', DEFAULT_MAX_DECOMPRESSED_BYTES),
    ).rejects.toBeInstanceOf(MalformedEncodingError);
  });
});

// ── applyDecompressionLimit ─────────────────────────────────────────────────

describe('applyDecompressionLimit', () => {
  it('leaves an uncompressed request untouched', async () => {
    const req = makeRequest(Buffer.from('plain'), {});
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never);

    expect(result.rejected).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it('leaves an explicitly identity-encoded request untouched', async () => {
    const req = makeRequest(Buffer.from('plain'), { 'content-encoding': 'identity' });
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never);

    expect(result.rejected).toBe(false);
    expect(result.encoding).toBeUndefined();
  });

  it('rejects an unsupported encoding with 415', async () => {
    const req = makeRequest(Buffer.from('whatever'), { 'content-encoding': 'zstd' });
    const res = makeResponse();
    const onRejected = jest.fn();

    const result = await applyDecompressionLimit(req as never, res as never, { onRejected });

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('unsupported-encoding');
    expect(res.statusCode).toBe(415);
    expect(res.body).toContain('Unsupported Content-Encoding');
    expect(onRejected).toHaveBeenCalledWith('unsupported-encoding', { encoding: 'zstd' });
  });

  it('rejects stacked codings with 415 rather than guessing', async () => {
    const req = makeRequest(Buffer.from('x'), { 'content-encoding': 'gzip, br' });
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never);

    expect(result.reason).toBe('unsupported-encoding');
    expect(res.statusCode).toBe(415);
  });

  it('inflates a valid gzip body and replays it downstream', async () => {
    const payload = Buffer.from(JSON.stringify({ ok: true }));
    const req = makeRequest(gzipSync(payload), { 'content-encoding': 'gzip' });
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never);

    expect(result.rejected).toBe(false);
    expect(result.encoding).toBe('gzip');
    expect(result.decodedBytes).toBe(payload.length);
    expect(res.writeHead).not.toHaveBeenCalled();
    // The compressed framing is stripped so handlers treat the replay as plain.
    expect(req.headers['content-encoding']).toBe('identity');
    expect(req.headers['content-length']).toBeUndefined();
  });

  it('delivers the decoded bytes to downstream data listeners', async () => {
    const payload = Buffer.from(JSON.stringify({ delivered: true }));
    const req = makeRequest(gzipSync(payload), { 'content-encoding': 'gzip' });
    const res = makeResponse();

    await applyDecompressionLimit(req as never, res as never);

    const received: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)));
      req.on('end', () => resolve());
    });
    await done;

    expect(Buffer.concat(received)).toEqual(payload);
  });

  it('rejects a compressed body above the compressed ceiling with 413', async () => {
    const payload = Buffer.alloc(512, 'a');
    const compressed = gzipSync(payload);
    const req = makeRequest(compressed, { 'content-encoding': 'gzip' });
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never, {
      maxCompressedBytes: compressed.length - 1,
    });

    expect(result.reason).toBe('compressed-too-large');
    expect(res.statusCode).toBe(413);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('rejects a decompression bomb above the decompressed ceiling with 413', async () => {
    const req = makeRequest(gzipSync(Buffer.alloc(100_000)), { 'content-encoding': 'gzip' });
    const res = makeResponse();
    const onRejected = jest.fn();

    const result = await applyDecompressionLimit(req as never, res as never, {
      maxDecompressedBytes: 1024,
      onRejected,
    });

    expect(result.reason).toBe('decompressed-too-large');
    expect(res.statusCode).toBe(413);
    expect(onRejected).toHaveBeenCalledWith(
      'decompressed-too-large',
      expect.objectContaining({ maxBytes: 1024 }),
    );
    expect(req.destroy).toHaveBeenCalled();
  });

  it('rejects a malformed gzip body with 400', async () => {
    const req = makeRequest(Buffer.from('not gzip at all'), { 'content-encoding': 'gzip' });
    const res = makeResponse();

    const result = await applyDecompressionLimit(req as never, res as never);

    expect(result.reason).toBe('malformed-encoding');
    expect(res.statusCode).toBe(400);
  });

  it('responds with a machine-readable rejection payload', async () => {
    const req = makeRequest(Buffer.from('x'), { 'content-encoding': 'zstd' });
    const res = makeResponse();

    await applyDecompressionLimit(req as never, res as never);

    expect(res.headers?.['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(res.body ?? '{}');
    expect(parsed.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(parsed.supported).toContain('gzip');
  });
});

// ── Defaults ────────────────────────────────────────────────────────────────

describe('decompression limit defaults', () => {
  it('caps the compressed body at 1 MiB', () => {
    expect(DEFAULT_MAX_COMPRESSED_BYTES).toBe(1_048_576);
  });

  it('caps the decompressed body at 4 MiB', () => {
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(4_194_304);
  });
});
