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
  /**
   * Provider key used to select an independent circuit breaker. When omitted
   * the breaker is keyed by the destination hostname.
   */
  provider?: string;
  /** Overrides for the provider's circuit breaker configuration. */
  circuitBreaker?: CircuitBreakerOptions;
   * Maximum number of redirects followed. Each redirect target is validated
   * independently before it is contacted. @default 3
   */
  maxRedirects?: number;
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
 * Circuit breaker states for an outbound webhook provider.
 *
 * - `closed`    — normal operation; requests flow through.
 * - `open`      — too many consecutive failures; requests are blocked.
 * - `half-open` — cooldown elapsed; a limited number of probe requests are
 *                 allowed through to test whether the provider recovered.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the breaker open. @default 5 */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing probes (ms). @default 30000 */
  cooldownMs?: number;
  /** Probe requests permitted while half-open. @default 1 */
  halfOpenMaxProbes?: number;
  /** Injectable clock for deterministic tests. @default Date.now */
  now?: () => number;
}

/**
 * Thrown when a webhook request is rejected because the provider's circuit
 * breaker is open (or half-open with no probe slots available).
 *
 * Callers should treat this as a transient failure — the request was never
 * attempted and may succeed once the breaker closes again.
 */
export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError';
  /** The provider key whose circuit is open. */
  readonly provider: string;
  /** The state the breaker was in when the request was rejected. */
  readonly state: CircuitState;

  constructor(provider: string, state: CircuitState) {
    super(`Circuit breaker is ${state} for provider: ${provider}`);
    this.provider = provider;
    this.state = state;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

/**
 * Per-provider circuit breaker.
 *
 * Tracks consecutive failures for a single provider and transitions between
 * `closed`, `open` and `half-open`. Each instance is independent, so one
 * failing provider never affects the state of another.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbes = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly now: () => number;

  constructor(
    readonly provider: string,
    opts: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.halfOpenMaxProbes = opts.halfOpenMaxProbes ?? 1;
    this.now = opts.now ?? Date.now;
  }

  /** Current breaker state, accounting for cooldown expiry. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      this.halfOpenProbes = 0;
    }
    return this.state;
  }

  /** Number of consecutive failures recorded since the last success. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns `true` when a request may be attempted, reserving a probe slot
   * while half-open. Throws `CircuitOpenError` when the request must be
   * blocked.
   */
  tryAcquire(): void {
    const current = this.getState();
    if (current === 'closed') {
      return;
    }
    if (current === 'half-open' && this.halfOpenProbes < this.halfOpenMaxProbes) {
      this.halfOpenProbes += 1;
      return;
    }
    throw new CircuitOpenError(this.provider, current);
  }

  /** Records a successful request, resetting the breaker to `closed`. */
  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenProbes = 0;
  }

  /** Records a failed request, tripping the breaker open at the threshold. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half-open') {
      this.trip();
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.halfOpenProbes = 0;
  }
}

const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Returns the shared circuit breaker for `provider`, creating it on first use.
 * Breakers are keyed by provider so their states remain independent.
 */
export function getCircuitBreaker(
  provider: string,
  opts: CircuitBreakerOptions = {},
): CircuitBreaker {
  let breaker = circuitBreakers.get(provider);
  if (!breaker) {
    breaker = new CircuitBreaker(provider, opts);
    circuitBreakers.set(provider, breaker);
  }
  return breaker;
}

/** Clears all registered breakers (primarily for tests). */
export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

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
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal as any,
    });

    if (response.ok) {
      breaker.recordSuccess();
    } else if (response.status >= 500 || response.status === 429) {
      breaker.recordFailure();
    } else {
      // 4xx (other than 429) indicates a permanent client-side problem; the
      // provider itself is healthy, so the breaker is not penalised.
      breaker.recordSuccess();
    }

    return response;
  } catch (error) {
    breaker.recordFailure();
    throw error;
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
 * Derives a stable circuit breaker key from a webhook URL, falling back to the
 * raw URL when it cannot be parsed.
 */
function resolveProviderKey(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
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
