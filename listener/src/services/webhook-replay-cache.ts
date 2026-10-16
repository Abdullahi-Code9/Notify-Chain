/**
 * ============================================================================
 * WEBHOOK REPLAY PROTECTION — in-memory replay cache
 * ============================================================================
 *
 * The `Idempotency-Key` header (see idempotency-key-service.ts) is only useful
 * when the *sender* chooses to supply one, so it cannot be relied upon as the
 * primary replay defence for inbound webhooks: an attacker replaying a
 * captured request simply omits the header, and the server-side branch that
 * consults the idempotency repository is skipped entirely.
 *
 * This cache closes that hole. Once a request has passed HMAC verification we
 * record the exact signature we accepted, keyed by the sending key id. Any
 * later request presenting the same `(keyId, signature)` pair is a verbatim
 * replay and is rejected without re-running the HMAC comparison.
 *
 * Why the signature is a sufficient replay key:
 *   The HMAC is computed over `timestamp + "." + rawBody`, so a signature
 *   uniquely pins down both the body and the timestamp. Two requests carrying
 *   the same signature under the same key are therefore by definition the same
 *   request, not two legitimate-but-identical deliveries.
 *
 * Properties:
 *   • Entries expire after the same TTL as the signature freshness window, so a
 *     request can never outlive the window during which it would be accepted.
 *   • `claim()` is atomic within the single-threaded Node event loop: the read
 *     and the write happen synchronously with no `await` in between.
 *   • Bounded in size; expired entries are swept and the oldest entries are
 *     evicted once the bound is reached, so memory cannot grow without limit.
 * ============================================================================
 */

export interface ReplayCacheOptions {
  /** Maximum number of retained signatures. Default 10000. */
  maxEntries?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export class WebhookReplayCache {
  /** signature key -> epoch-ms expiry. Map preserves insertion order. */
  private readonly entries = new Map<string, number>();

  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ReplayCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.now = options.now ?? Date.now;
  }

  /**
   * Atomically records `key` as seen.
   *
   * @returns `true` the first time the key is seen (caller should accept the
   *          request), `false` if the key is still within its TTL window
   *          (caller should reject the request as a replay).
   */
  claim(key: string, ttlMs: number): boolean {
    const now = this.now();
    const existingExpiry = this.entries.get(key);

    if (existingExpiry !== undefined && existingExpiry > now) {
      return false; // still cached -> replay
    }

    // Expired or unseen: refresh the entry and move it to the end of the
    // insertion order so eviction approximates least-recently-seen first.
    this.entries.delete(key);
    this.entries.set(key, now + ttlMs);

    if (this.entries.size > this.maxEntries) {
      this.evict();
    }

    return true;
  }

  /** Number of entries currently retained, including any not yet swept. */
  get size(): number {
    return this.entries.size;
  }

  /** Drops every expired entry. Exposed for tests and periodic maintenance. */
  sweep(): void {
    const now = this.now();
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) {
        this.entries.delete(key);
      }
    }
  }

  /** Frees all memory. Call on server shutdown. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Enforces the size bound: first drop everything already expired, and only
   * if that frees nothing do we evict the oldest entries.
   */
  private evict(): void {
    this.sweep();

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Builds the replay-cache key for a verified request.
 *
 * The key id is included so that two different senders producing an identical
 * signature value cannot collide, and the raw signature is namespaced to avoid
 * any ambiguity with other cache consumers.
 */
export function buildReplayCacheKey(keyId: string, signature: string): string {
  return `${keyId}:${signature.toLowerCase()}`;
}
