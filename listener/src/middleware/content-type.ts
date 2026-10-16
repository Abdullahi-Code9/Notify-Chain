import type http from 'http';
import { ErrorCode } from '../utils/response';

/**
 * Extracts and normalizes the MIME type (strips parameters like `; charset=utf-8`).
 * Returns null if the header is absent or empty.
 */
export function getMimeType(contentTypeHeader?: string | string[]): string | null {
  if (!contentTypeHeader) return null;
  const raw = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  if (!raw || typeof raw !== 'string') return null;
  const mime = raw.split(';')[0].trim().toLowerCase();
  return mime || null;
}

/**
 * Checks whether the incoming content type is JSON (`application/json`).
 */
export function isJsonContentType(contentTypeHeader?: string | string[]): boolean {
  const mime = getMimeType(contentTypeHeader);
  return mime === 'application/json';
}

/**
 * Writes a standardized 415 Unsupported Media Type response.
 */
export function sendUnsupportedMediaType(
  res: http.ServerResponse,
  contentType: string,
  expected: string = 'application/json',
): void {
  const message = `Unsupported Content-Type: '${contentType}'. Expected '${expected}'.`;
  const payload = JSON.stringify({
    success: false,
    error: {
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message,
    },
    code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    message,
  });

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(415, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Validates request Content-Type against an allowed list of MIME types.
 * Returns true if valid, or false if rejected (response already sent).
 */
export function validateContentType(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedMimes: string[] = ['application/json'],
): boolean {
  // Safe methods do not require Content-Type
  const method = (req.method ?? 'GET').toUpperCase();
  if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) {
    return true;
  }

  // If request explicitly specifies empty body (Content-Length: 0), allow it
  if (req.headers['content-length'] === '0') {
    return true;
  }

  const rawHeader = req.headers['content-type'];
  if (!rawHeader || (typeof rawHeader === 'string' && rawHeader.trim() === '')) {
    // Content-Type is omitted: allow for backward compatibility with existing clients
    return true;
  }

  const mime = getMimeType(rawHeader);
  if (!mime || !allowedMimes.includes(mime)) {
    const rawStr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    sendUnsupportedMediaType(res, rawStr, allowedMimes.join(', '));
    return false;
  }

  return true;
}
