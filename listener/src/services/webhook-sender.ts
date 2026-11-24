import { guardWebhookUrl, DnsResolver } from './dns-rebinding-guard';
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
  /**
   * Maximum number of redirects followed. Each redirect target is validated
   * independently before it is contacted. @default 3
   */
  maxRedirects?: number;
}

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
 * Before every connection (including each redirect hop) the destination is
 * validated against the DNS rebinding guard (#994, #1206). If the resolved
 * address falls within any blocked range (RFC 1918, loopback, link-local,
 * etc.) the request is rejected with a `DnsRebindingError` before a single
 * byte leaves the process. Redirects are never followed implicitly: the
 * `Location` target is resolved and validated as a new destination.
 */
export async function sendWebhook(
  url: string,
  payload: any,
  opts: WebhookSendOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxRedirects = opts.maxRedirects ?? 3;

  // Validating immediately before every connection keeps a DNS change between
  // validation and connect from silently bypassing the policy. The addresses
  // returned here are the ones approved for this hop.
  await assertSafeDestination(url, opts);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = url;

  try {
    for (let hop = 0; ; hop++) {
      const response = await fetch(currentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(payload),
        // Redirects are handled here so every target is validated, rather
        // than letting the HTTP client follow an untrusted Location header.
        redirect: 'manual',
        signal: controller.signal as any,
      });

      const location = response.headers.get('location');
      if (!location || response.status < 300 || response.status >= 400 || !isRedirect(response.status)) {
        return response;
      }
      if (hop >= maxRedirects) {
        return response;
      }

      const redirectUrl = new URL(location, currentUrl).toString();
      // Independent validation: a redirect to a private address is blocked
      // even when the original destination was public.
      await assertSafeDestination(redirectUrl, opts);
      void response.body?.cancel().catch(() => {});
      currentUrl = redirectUrl;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function assertSafeDestination(
  url: string,
  opts: WebhookSendOptions,
): Promise<void> {
  if (opts.skipDnsGuard) return;

  const guardResult = await guardWebhookUrl(url, opts.dnsResolver);
  if (!guardResult.safe) {
    logger.warn('Webhook delivery blocked by DNS rebinding guard', {
      url,
      hostname: guardResult.hostname,
      blockedAddress: guardResult.blockedAddress,
      reason: guardResult.reason,
    });
    throw new DnsRebindingError(
      guardResult.reason ?? `Webhook destination blocked: ${url}`,
      guardResult.hostname,
      guardResult.blockedAddress,
    );
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
