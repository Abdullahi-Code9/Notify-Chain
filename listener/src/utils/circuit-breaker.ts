/**
 * Circuit Breaker for RPC calls
 *
 * Prevents continuous requests to an unavailable endpoint by tracking failures
 * and opening the circuit after repeated failures. After a recovery period,
 * the circuit transitions to half-open state to test if the endpoint has recovered.
 */

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerConfig {
  /** Number of consecutive failures required to open the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in milliseconds to wait before attempting recovery (default: 60000) */
  recoveryTimeoutMs?: number;
  /** Time in milliseconds to consider a request as timed out (default: 30000) */
  requestTimeoutMs?: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.recoveryTimeoutMs = config.recoveryTimeoutMs ?? 60000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
  }

  /**
   * Execute a function through the circuit breaker
   * Throws an error if the circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() >= (this.nextAttemptTime ?? 0)) {
        // Transition to half-open to test recovery
        this.state = CircuitState.HALF_OPEN;
        this.nextAttemptTime = null;
      } else {
        throw new Error(
          `Circuit breaker is OPEN. Next attempt at ${new Date(this.nextAttemptTime ?? 0).toISOString()}`
        );
      }
    }

    try {
      // Add timeout to the request
      const result = await this.withTimeout(fn, this.requestTimeoutMs);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private async withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  private onSuccess(): void {
    this.successCount++;
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Circuit recovered, close it
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.recoveryTimeoutMs;
    }
  }

  /**
   * Get the current state and metrics of the circuit breaker
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;
  }

  /**
   * Force the circuit to open (useful for manual intervention)
   */
  forceOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.recoveryTimeoutMs;
  }

  /**
   * Force the circuit to close (useful for manual recovery)
   */
  forceClose(): void {
    this.reset();
  }
}
