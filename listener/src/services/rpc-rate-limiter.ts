import { RpcRateLimitConfig } from '../types';
import logger from '../utils/logger';

/**
 * Token bucket rate limiter for RPC event ingestion.
 *
 * Uses a token bucket algorithm to limit RPC request rate while allowing
 * short bursts. This prevents excessive RPC requests and resource consumption
 * while maintaining normal event processing.
 */
export class RpcRateLimiter {
  private config: RpcRateLimitConfig;
  private tokens: number;
  private lastRefill: number;
  private metrics: {
    totalRequests: number;
    throttledRequests: number;
    allowedRequests: number;
  };

  constructor(config: RpcRateLimitConfig) {
    this.config = config;
    this.tokens = config.burstSize;
    this.lastRefill = Date.now();
    this.metrics = {
      totalRequests: 0,
      throttledRequests: 0,
      allowedRequests: 0,
    };
  }

  /**
   * Check if an RPC request should be allowed and wait if throttled.
   *
   * @returns Promise that resolves when the request can proceed
   */
  async acquire(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    this.metrics.totalRequests++;

    const now = Date.now();
    const timeSinceRefill = now - this.lastRefill;

    // Refill tokens based on time elapsed
    if (timeSinceRefill > 0) {
      const tokensToAdd = (timeSinceRefill / 1000) * this.config.maxRequestsPerSecond;
      this.tokens = Math.min(this.config.burstSize, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }

    if (this.tokens >= 1) {
      // Sufficient tokens available
      this.tokens -= 1;
      this.metrics.allowedRequests++;
      return;
    }

    // Insufficient tokens - throttle the request
    this.metrics.throttledRequests++;
    const delayMs = this.config.throttleDelayMs;

    logger.warn('RPC request throttled', {
      tokensRemaining: this.tokens,
      delayMs,
      maxRequestsPerSecond: this.config.maxRequestsPerSecond,
      burstSize: this.config.burstSize,
    });

    await this.delay(delayMs);

    // After delay, try again without incrementing metrics
    await this.acquireInternal();
  }

  /**
   * Internal acquire method that doesn't increment metrics.
   * Used for recursive calls after throttling.
   */
  private async acquireInternal(): Promise<void> {
    const now = Date.now();
    const timeSinceRefill = now - this.lastRefill;

    // Refill tokens based on time elapsed
    if (timeSinceRefill > 0) {
      const tokensToAdd = (timeSinceRefill / 1000) * this.config.maxRequestsPerSecond;
      this.tokens = Math.min(this.config.burstSize, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }

    if (this.tokens >= 1) {
      // Sufficient tokens available
      this.tokens -= 1;
      this.metrics.allowedRequests++;
      return;
    }

    // Still insufficient tokens - throttle again
    this.metrics.throttledRequests++;
    const delayMs = this.config.throttleDelayMs;

    logger.warn('RPC request throttled', {
      tokensRemaining: this.tokens,
      delayMs,
      maxRequestsPerSecond: this.config.maxRequestsPerSecond,
      burstSize: this.config.burstSize,
    });

    await this.delay(delayMs);

    // Try again
    await this.acquireInternal();
  }

  /**
   * Get current rate limiting metrics.
   */
  getMetrics() {
    return {
      ...this.metrics,
      currentTokens: this.tokens,
      maxRequestsPerSecond: this.config.maxRequestsPerSecond,
      burstSize: this.config.burstSize,
    };
  }

  /**
   * Reset metrics (useful for testing).
   */
  resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      throttledRequests: 0,
      allowedRequests: 0,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
