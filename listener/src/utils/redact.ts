/**
 * Centralized log-redaction engine (#691).
 *
 * All structured log objects and error metadata pass through `redactObject`
 * before being written to any transport so that secrets never appear in logs.
 *
 * ## What gets redacted
 *
 * - **Key-based redaction** – any object key that matches a name in
 *   `SENSITIVE_KEYS` (case-insensitive, partial-match) has its value replaced
 *   with `"[REDACTED]"`.
 * - **URL credential redaction** – string values that contain HTTP(S) URLs
 *   with embedded credentials (`user:pass@host`) have the credential segment
 *   replaced with `[REDACTED]@`.
 * - **Bearer / token header redaction** – string values that look like
 *   `Bearer <token>` or `Token <value>` have the token portion replaced.
 * - **Nested objects & arrays** – redaction recurses into nested objects and
 *   array elements so deeply-nested secrets are also masked.
 *
 * ## Design principles
 *
 * - **Zero-leak guarantee**: matching keys are always replaced; the original
 *   value is never logged, even partially.
 * - **Non-destructive**: the original object is never mutated; a redacted
 *   copy is returned.
 * - **Safe for production**: plain string messages are returned unchanged
 *   unless they contain URL credentials or auth-header patterns.
 */

/** Replacement sentinel used for every redacted value. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Key fragments that trigger value redaction (case-insensitive, substring
 * match).  Add new entries here to extend the redaction policy; no other
 * file needs to change.
 */
export const SENSITIVE_KEYS: ReadonlyArray<string> = [
  'password',
  'passwd',
  'secret',
  'apikey',
  'api_key',
  'apitoken',
  'api_token',
  'token',
  'authorization',
  'auth',
  'credential',
  'privatekey',
  'private_key',
  'signingkey',
  'signing_key',
  'webhookurl',
  'webhook_url',
  'webhooktoken',
  'webhook_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'encryptionkey',
  'encryption_key',
  'hmac',
  'jwt',
  'bearertoken',
  'bearer_token',
  'cookie',
  'sessionid',
  'session_id',
  'discordwebhookurl',
  'discord_webhook_url',
  // The Discord webhook id + token pair together form the credential.
  'discordwebhook',
  'whsec',
  // Webhook HMAC signatures (e.g. X-Webhook-Signature) authenticate requests.
  'signature',
  // Stellar secret seeds / wallet recovery material.
  'seed',
  'mnemonic',
];

// Regex for HTTP(S) URLs with embedded credentials: https://user:pass@host
const URL_CREDENTIALS_RE = /(https?:\/\/)[^:/?#\s]+:[^@\s]+@/gi;

// Regex for Authorization / Bearer / Token / Basic header values
const BEARER_HEADER_RE = /\b(bearer|token|basic)\s+\S+/gi;

// Discord webhook URLs carry the credential in the path:
//   https://discord.com/api/webhooks/<id>/<token>
const DISCORD_WEBHOOK_RE =
  /(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/)[^\s?#"']+/gi;

// Slack incoming-webhook URLs: https://hooks.slack.com/services/T../B../<token>
const SLACK_WEBHOOK_RE = /(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s?#"']+/gi;

// Sensitive query-string parameters inside any URL-ish string:
//   ...?token=abc  ...&api_key=abc  ...&signature=abc
const SENSITIVE_QUERY_PARAM_RE =
  /([?&][\w-]*(?:token|secret|password|passwd|api[_-]?key|apikey|signature|sig|auth|credential|key)=)[^&\s#"']+/gi;

// Stellar secret seeds: 'S' + 55 base32 characters.
const STELLAR_SECRET_SEED_RE = /\bS[A-Z2-7]{55}\b/g;

// Prefixed webhook secrets (whsec_...) and hex HMAC signatures (sha256=...).
const WHSEC_RE = /\bwhsec_[A-Za-z0-9+/=_-]+/g;
const HMAC_SIGNATURE_RE = /\bsha(?:1|256|512)=[0-9a-f]{16,}/gi;

/** Guard against deeply nested or cyclic structures in the logging path. */
const MAX_REDACTION_DEPTH = 10;

/**
 * Return `true` when the given object key name should be redacted.
 *
 * Matching is case-insensitive and checks whether any sensitive fragment is
 * contained within the normalized key name so that both `webhookUrl` and
 * `DISCORD_WEBHOOK_URL` are caught.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEYS.some((fragment) => {
    const normalizedFragment = fragment.toLowerCase().replace(/[-_\s]/g, '');
    return normalized.includes(normalizedFragment);
  });
}

/**
 * Redact credential patterns from a plain string value:
 *   - URL-embedded credentials (`user:pass@host`)
 *   - Discord / Slack webhook URL tokens (the credential lives in the path)
 *   - Sensitive query-string parameters (`?token=`, `&api_key=`, …)
 *   - Bearer / Token / Basic auth header values
 *   - Stellar secret seeds, `whsec_` secrets and `sha256=` HMAC signatures
 *
 * Returns the sanitized string or the original if no patterns match.
 */
export function redactString(value: string): string {
  let result = value;
  result = result.replace(URL_CREDENTIALS_RE, `$1${REDACTED_PLACEHOLDER}@`);
  result = result.replace(DISCORD_WEBHOOK_RE, `$1${REDACTED_PLACEHOLDER}`);
  result = result.replace(SLACK_WEBHOOK_RE, `$1${REDACTED_PLACEHOLDER}`);
  result = result.replace(SENSITIVE_QUERY_PARAM_RE, `$1${REDACTED_PLACEHOLDER}`);
  result = result.replace(BEARER_HEADER_RE, `$1 ${REDACTED_PLACEHOLDER}`);
  result = result.replace(STELLAR_SECRET_SEED_RE, REDACTED_PLACEHOLDER);
  result = result.replace(WHSEC_RE, REDACTED_PLACEHOLDER);
  result = result.replace(HMAC_SIGNATURE_RE, REDACTED_PLACEHOLDER);
  return result;
}

/**
 * Recursively redact an arbitrary value.
 *
 * - Objects: keys matching `isSensitiveKey` have their values replaced with
 *   `REDACTED_PLACEHOLDER`; all other keys are recursed into.
 * - Arrays: each element is recursed into.
 * - Strings: run through `redactString` to catch URL credentials and auth
 *   header patterns.
 * - Everything else (number, boolean, null, undefined): returned as-is.
 *
 * The input is never mutated.
 */
export function redactValue(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>(), false);
}

/**
 * Inside a sensitive container (e.g. `apiKeys: [{ name, key }]`) every string
 * leaf is treated as a secret except these identifier-like fields, which are
 * kept so logs stay useful (`webhookSecrets[0].id`, `auth.clientId`).
 */
const IDENTIFIER_KEYS = new Set([
  'id', 'name', 'label', 'type', 'kind', 'keyid', 'kid', 'clientid',
  'username', 'user', 'description', 'provider', 'enabled', 'createdat',
]);

function isIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

function redactInner(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  inSensitiveContainer: boolean,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  // Logging must never take the service down: bound depth and break cycles.
  if (depth >= MAX_REDACTION_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        inSensitiveContainer && typeof item === 'string'
          ? REDACTED_PLACEHOLDER
          : redactInner(item, depth + 1, seen, inSensitiveContainer),
      );
    }

    // Errors have non-enumerable fields; keep the useful ones, redacted.
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        ...(value.stack ? { stack: redactString(value.stack) } : {}),
      };
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const sensitive = isSensitiveKey(key);
      const isContainer = val !== null && typeof val === 'object' && !(val instanceof Error);

      if (isContainer) {
        // A sensitive *container* (e.g. `auth: { clientId, clientSecret }`):
        // recurse so secret leaves are masked but public ids stay useful.
        redacted[key] = redactInner(val, depth + 1, seen, inSensitiveContainer || sensitive);
      } else if (sensitive) {
        redacted[key] = REDACTED_PLACEHOLDER;
      } else if (inSensitiveContainer && typeof val === 'string' && !isIdentifierKey(key)) {
        // e.g. the `key` in `apiKeys: [{ name, key }]`
        redacted[key] = REDACTED_PLACEHOLDER;
      } else {
        redacted[key] = redactInner(val, depth + 1, seen, inSensitiveContainer);
      }
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}

/**
 * Convenience wrapper that accepts a log-metadata object (or `undefined`) and
 * returns a fully redacted copy.  Pass the result directly to Winston.
 *
 * ```ts
 * logger.info('Webhook delivered', redactObject({ url, statusCode }));
 * ```
 */
export function redactObject<T extends Record<string, unknown>>(
  meta: T | undefined
): T | undefined {
  if (meta === undefined) {
    return undefined;
  }
  return redactValue(meta) as T;
}
