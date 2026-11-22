/**
 * Credential redaction for Stellar RPC endpoint URLs (issue #1112).
 *
 * Hosted RPC providers carry credentials in several places:
 *   - userinfo:      https://user:secret@rpc.example.com
 *   - query string:  https://rpc.example.com/?apiKey=secret
 *   - path segment:  https://rpc.example.com/v1/3f9a1c...e7 (opaque key)
 *
 * Every log line, health snapshot and error message that mentions an
 * endpoint must go through {@link redactRpcUrl} so none of these reach logs.
 * The function is dependency-free so it can be used from config loading
 * without creating import cycles.
 */

export const RPC_REDACTED = '[REDACTED]';

const SENSITIVE_QUERY_KEY = /(key|token|secret|auth|password|pass|signature|sig|credential|session)/i;

/**
 * A path segment is treated as an opaque credential when it is long and
 * looks machine-generated (hex, base64url, or UUID-like). Short, readable
 * segments such as `v1`, `soroban`, or `rpc` are preserved so logs still
 * identify the endpoint.
 */
function looksLikeSecretSegment(segment: string): boolean {
  if (segment.length < 20) return false;
  if (/^[0-9a-f-]{20,}$/i.test(segment)) return true;
  if (/^[A-Za-z0-9_\-]{24,}$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment)) {
    return true;
  }
  return false;
}

/**
 * Returns `rawUrl` with userinfo, sensitive query values and opaque path
 * credentials replaced by {@link RPC_REDACTED}. Unparseable input is reduced
 * to a fixed placeholder rather than echoed back, since a malformed URL may
 * still contain a secret.
 */
export function redactRpcUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return '[unparseable-url]';
  }

  const hadUserInfo = url.username !== '' || url.password !== '';
  url.username = '';
  url.password = '';

  const segments = url.pathname.split('/').map((seg) =>
    looksLikeSecretSegment(decodeURIComponent(seg)) ? RPC_REDACTED : seg,
  );
  const pathname = segments.join('/');

  const query: string[] = [];
  for (const [key, value] of url.searchParams) {
    query.push(
      SENSITIVE_QUERY_KEY.test(key)
        ? `${encodeURIComponent(key)}=${RPC_REDACTED}`
        : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    );
  }

  const userInfo = hadUserInfo ? `${RPC_REDACTED}@` : '';
  const search = query.length > 0 ? `?${query.join('&')}` : '';
  const path = pathname === '/' && search === '' ? '' : pathname;
  return `${url.protocol}//${userInfo}${url.host}${path}${search}`;
}

/**
 * Redacts every http(s) URL embedded in free text (e.g. an upstream error
 * message that echoes the request URL).
 */
export function redactUrlsInText(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactRpcUrl(match));
}
