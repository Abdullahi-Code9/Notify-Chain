import { guardWebhookUrl, DnsResolver } from './dns-rebinding-guard';
import { validateNotificationDestinationUrl } from '../utils/ssrf-url-validation';
import logger from '../utils/logger';

export interface WebhookSendOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /**
   * Injectable DNS resolver — used in tests to simulate changing DNS records.
   * When omitted the Node.js `dns` module is used.
   */
  dnsResolver?: DnsResolver;
  /**
   * Set to `true` to skip the DNS rebinding guard (NOT recommended outside of
   * internal test harnesses where the target URL is already trusted).
   * @default false
   */
  skipDnsGuard?: boolean;
}

/** Maximum number of redirects followed for a single outbound webhook. */
export const MAX_WEBHOOK_REDIRECTS = 5;

/**
 * Classification of an outbound webhook failure.
 *
 * Kept deliberately coarse so that retry decisions and observability can tell
 * a request timeout apart from a generic network error or an HTTP-level
 * failure without string-matching error messages.
 */
export type WebhookFailureReason =
  | 'timeout'
  | 'network'
  | 'http_retryable'
  | 'http_permanent';

/**
 * True when `error` represents an aborted (timed-out) webhook request.
 *
 * `AbortController.abort()` surfaces as an `AbortError` under Node's `fetch`;
 * `TimeoutError` is accepted as well because some runtimes raise it for a
 * signal-driven timeout. Callers use this instead of comparing
 * `error.name === 'AbortError'` so a timeout stays distinguishable in one
 * place.
 */
export function isWebhookTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * Sends a single outbound POST webhook to `url`.
 *
 * Before every hop the destination is validated against the DNS rebinding
 * guard (issue #994) and the URL policy (issue #1205). Redirects are followed
 * manually so a 3xx response cannot bypass either check. If any resolved
 * address falls within a blocked range (RFC 1918, loopback, link-local, etc.)
 * the request is rejected before a single byte leaves the process.
 */
export async function sendWebhook(
  url: string,
  payload: any,
  opts: WebhookSendOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  validateNotificationDestinationUrl(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = url;

  try {
    for (let hop = 0; ; hop += 1) {
      // ── DNS rebinding guard (revalidated for every redirect hop) ───────────
      if (!opts.skipDnsGuard) {
        const guardResult = await guardWebhookUrl(currentUrl, opts.dnsResolver);
        if (!guardResult.safe) {
          logger.warn('Webhook delivery blocked by DNS rebinding guard', {
            url: currentUrl,
            hostname: guardResult.hostname,
            blockedAddress: guardResult.blockedAddress,
            reason: guardResult.reason,
          });
          const err = new DnsRebindingError(
            guardResult.reason ?? `Webhook destination blocked: ${currentUrl}`,
            guardResult.hostname,
            guardResult.blockedAddress,
          );
          throw err;
        }
      }

      // ── Outbound HTTP POST ─────────────────────────────────────────────────
      const response = await fetch(currentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal as any,
        redirect: 'manual',
      });

      const location = response.headers?.get?.('location');
      if (
        location &&
        response.status >= 300 &&
        response.status < 400
      ) {
        if (hop >= MAX_WEBHOOK_REDIRECTS) {
          throw new Error('Too many webhook redirects; refusing unsafe destination chain');
        }
        // Reject non-HTTP schemes and local targets in the redirect before the
        // next DNS validation and fetch iteration.
        currentUrl = validateNotificationDestinationUrl(
          new URL(location, currentUrl).toString(),
        );
        continue;
      }

      return response;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Thrown when `sendWebhook` rejects a request because the destination
 * hostname resolved to a private or otherwise unsafe IP address.
 *
 * Callers (e.g. WebhookDeliveryService) should treat this as a permanent
 * failure — retrying without changing the URL will produce the same result.
 */
export class DnsRebindingError extends Error {
  readonly name = 'DnsRebindingError';
  /** The destination hostname that triggered the block. */
  readonly hostname: string;
  /** The specific resolved IP address that was blocked (when available). */
  readonly blockedAddress?: string;

  constructor(message: string, hostname: string, blockedAddress?: string) {
    super(message);
    this.hostname = hostname;
    this.blockedAddress = blockedAddress;
    Object.setPrototypeOf(this, DnsRebindingError.prototype);
  }
}
