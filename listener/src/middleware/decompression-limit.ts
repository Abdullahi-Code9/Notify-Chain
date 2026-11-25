/**
 * Compressed request body limits (issue #999).
 *
 * `Content-Encoding: gzip` (and friends) is a decompression bomb vector: a few
 * kilobytes of compressed input can expand to gigabytes in memory. The generic
 * body-size guard in `body-limit.ts` only bounds the *compressed* wire size, so
 * a small, accepted request can still exhaust the process heap once inflated.
 *
 * This module closes that gap by bounding both ends of the problem:
 *
 *   * `maxCompressedBytes`  — bytes accepted off the wire (declared or streamed).
 *   * `maxDecompressedBytes` — bytes the inflater is allowed to produce. This is
 *     enforced *incrementally* while inflating, so an expansion bomb is aborted
 *     as soon as it crosses the ceiling instead of after it has been buffered.
 *
 * Unsupported encodings (`zstd`, multiple stacked codings, ...) are refused with
 * a 415 rather than being silently passed through to a handler that would treat
 * the raw compressed bytes as JSON. Malformed compressed input is a 400.
 */

import type http from 'http';
import type { Transform } from 'stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'zlib';

/** Default ceiling for the compressed (on-the-wire) body: 1 MiB. */
export const DEFAULT_MAX_COMPRESSED_BYTES = 1_048_576;

/** Default ceiling for the inflated body: 4 MiB (a 4:1 headroom over the wire cap). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 4_194_304;

/**
 * Encodings we can safely inflate. `identity` means "no encoding" and is
 * treated as absent. `x-gzip` is the historical alias some clients still send.
 */
const SUPPORTED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

export type DecompressionRejection =
  | 'unsupported-encoding'
  | 'compressed-too-large'
  | 'decompressed-too-large'
  | 'malformed-encoding';

/** Thrown for a coded body we cannot inflate (truncated, not actually gzip, ...). */
export class MalformedEncodingError extends Error {
  readonly name = 'MalformedEncodingError';
  constructor(encoding: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    super(`Malformed ${encoding} request body${detail}`);
  }
}

/** Thrown when the inflated output crosses `maxDecompressedBytes`. */
export class DecompressedTooLargeError extends Error {
  readonly name = 'DecompressedTooLargeError';
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Decompressed request body is too large: ${observedBytes} bytes exceeds the ` +
        `${maxBytes}-byte limit.`,
    );
  }
}

/** Thrown when the compressed input crosses `maxCompressedBytes`. */
export class CompressedTooLargeError extends Error {
  readonly name = 'CompressedTooLargeError';
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `Compressed request body is too large: ${observedBytes} bytes exceeds the ` +
        `${maxBytes}-byte limit.`,
    );
  }
}

export interface DecompressionLimitOptions {
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  /** Notified when a request is refused, so callers can log with their own context. */
  onRejected?: (reason: DecompressionRejection, detail: Record<string, unknown>) => void;
}

export interface DecompressionLimitResult {
  /**
   * True when the middleware fully handled the request (it was rejected or the
   * body was decoded and replayed). The caller must not continue to process the
   * request when `rejected` is set; when the body was replayed processing may
   * continue normally.
   */
  rejected: boolean;
  /** Present when the body was successfully inflated and replayed. */
  encoding?: string;
  /** Size of the inflated body, in bytes, when inflation succeeded. */
  decodedBytes?: number;
  reason?: DecompressionRejection;
}

/**
 * Normalises the `Content-Encoding` header.
 *
 * Returns `undefined` when there is nothing to do (missing or `identity`), the
 * single lower-cased coding otherwise, and the raw value when several codings
 * are stacked (which we reject as unsupported — we only inflate one layer).
 */
export function parseContentEncoding(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] : raw).trim().toLowerCase();
  if (value === '' || value === 'identity') return undefined;
  // Stacked codings ("gzip, br") are deliberately surfaced so the caller rejects them.
  return value;
}

export function isSupportedEncoding(encoding: string): boolean {
  return SUPPORTED_ENCODINGS.has(encoding);
}

function createInflater(encoding: string): Transform | undefined {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
  }
}

/**
 * Reads a readable stream into a buffer, refusing to buffer more than
 * `maxBytes`. The overflow is detected as soon as it happens, so the rest of
 * the stream is discarded instead of accumulated.
 */
export function readStreamWithLimit(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        reject(new CompressedTooLargeError(total, maxBytes));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

/**
 * Inflates `input` while counting the output, aborting as soon as the inflated
 * size crosses `maxDecompressedBytes`.
 */
export function inflateWithLimit(
  input: Buffer,
  encoding: string,
  maxDecompressedBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inflater = createInflater(encoding);
    if (!inflater) {
      reject(new MalformedEncodingError(encoding));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    inflater.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxDecompressedBytes) {
        settled = true;
        inflater.destroy();
        reject(new DecompressedTooLargeError(total, maxDecompressedBytes));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });

    inflater.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(new MalformedEncodingError(encoding, error));
    });

    inflater.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    inflater.end(input);
  });
}

/**
 * Re-queues an already-consumed body so downstream `req.on('data')` handlers
 * receive the *decoded* bytes. The original stream has ended by this point, so
 * the bytes are emitted on the next microtask — after the route handlers have
 * attached their listeners.
 */
function replayBody(req: http.IncomingMessage, decoded: Buffer): void {
  // Downstream handlers must not try to inflate again, and the stale
  // compressed length would be misleading.
  req.headers['content-encoding'] = 'identity';
  delete req.headers['content-length'];

  setImmediate(() => {
    req.emit('data', decoded);
    req.emit('end');
  });
}

function writeRejection(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message, code, ...extra }));
}

/**
 * Screens a request that may carry a compressed body.
 *
 * Returns `{ rejected: false }` and leaves the request untouched when there is
 * no compression to undo. When a supported encoding is present the body is
 * bounded, inflated, and replayed so the existing handlers keep working. On any
 * violation a coded JSON error is written and the request is destroyed.
 */
export async function applyDecompressionLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: DecompressionLimitOptions = {},
): Promise<DecompressionLimitResult> {
  const encoding = parseContentEncoding(req.headers['content-encoding']);
  if (encoding === undefined) {
    return { rejected: false };
  }

  const maxCompressedBytes = options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxDecompressedBytes =
    options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

  if (!isSupportedEncoding(encoding)) {
    options.onRejected?.('unsupported-encoding', { encoding });
    writeRejection(res, 415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported Content-Encoding: ${encoding}`, {
      encoding,
      supported: [...SUPPORTED_ENCODINGS],
    });
    req.destroy();
    return { rejected: true, reason: 'unsupported-encoding' };
  }

  // Bound the compressed input first: cheap, and stops a huge upload before we
  // hand anything to the inflater.
  let compressed: Buffer;
  try {
    compressed = await readStreamWithLimit(req, maxCompressedBytes);
  } catch (error) {
    if (error instanceof CompressedTooLargeError) {
      options.onRejected?.('compressed-too-large', {
        encoding,
        observedBytes: error.observedBytes,
        maxBytes: error.maxBytes,
      });
      writeRejection(res, 413, 'PAYLOAD_TOO_LARGE', error.message, {
        maxCompressedBytes,
        observedBytes: error.observedBytes,
      });
      req.destroy();
      return { rejected: true, reason: 'compressed-too-large' };
    }
    options.onRejected?.('malformed-encoding', {
      encoding,
      error: error instanceof Error ? error.message : String(error),
    });
    writeRejection(res, 400, 'MALFORMED_ENCODING', 'Failed to read compressed request body', {
      encoding,
    });
    return { rejected: true, reason: 'malformed-encoding' };
  }

  let decoded: Buffer;
  try {
    decoded = await inflateWithLimit(compressed, encoding, maxDecompressedBytes);
  } catch (error) {
    if (error instanceof DecompressedTooLargeError) {
      options.onRejected?.('decompressed-too-large', {
        encoding,
        observedBytes: error.observedBytes,
        maxBytes: error.maxBytes,
      });
      writeRejection(res, 413, 'PAYLOAD_TOO_LARGE', error.message, {
        maxDecompressedBytes,
        observedBytes: error.observedBytes,
      });
      req.destroy();
      return { rejected: true, reason: 'decompressed-too-large' };
    }
    options.onRejected?.('malformed-encoding', {
      encoding,
      error: error instanceof Error ? error.message : String(error),
    });
    writeRejection(res, 400, 'MALFORMED_ENCODING', `Malformed ${encoding} request body`, {
      encoding,
    });
    return { rejected: true, reason: 'malformed-encoding' };
  }

  replayBody(req, decoded);
  return { rejected: false, encoding, decodedBytes: decoded.length };
}
