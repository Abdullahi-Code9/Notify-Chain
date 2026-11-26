import logger from '../utils/logger';

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerConfig {
  /** Number of consecutive failures required to open the circuit */
  failureThreshold?: number;
  /** Time in milliseconds to wait before attempting recovery */
  recoveryTimeoutMs?: number;
  /** Number of successful calls required to close the circuit from half-open state */
  successThreshold?: number;
  /** Maximum number of concurrent probe requests allowed in half-open state */
  halfOpenProbeLimit?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private halfOpenProbesInFlight: number = 0;

  constructor(private config: CircuitBreakerConfig) {
    // Apply defaults for optional properties
    if (this.config.failureThreshold === undefined) {
      this.config.failureThreshold = 5;
    }
    if (this.config.recoveryTimeoutMs === undefined) {
      this.config.recoveryTimeoutMs = 60000;
    }
    if (this.config.successThreshold === undefined) {
      this.config.successThreshold = 2;
    }
    if (this.config.halfOpenProbeLimit === undefined) {
      this.config.halfOpenProbeLimit = 1;
    }
  }

  getState(): CircuitState {
    this.checkRecoveryWindow();
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    this.checkRecoveryWindow();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkRecoveryWindow();

    if (this.state === CircuitState.OPEN) {
      logger.warn('Circuit breaker is OPEN, blocking request', {
        state: this.state,
        nextAttemptTime: this.nextAttemptTime,
      });
      throw new Error('Circuit breaker is OPEN');
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenProbesInFlight >= (this.config.halfOpenProbeLimit ?? 1)) {
        logger.warn('Circuit breaker is HALF_OPEN, probe limit reached, blocking request', {
          state: this.state,
          halfOpenProbesInFlight: this.halfOpenProbesInFlight,
          halfOpenProbeLimit: this.config.halfOpenProbeLimit,
        });
        throw new Error('Circuit breaker is HALF_OPEN and probe limit reached');
      }
      this.halfOpenProbesInFlight++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      if (this.state === CircuitState.HALF_OPEN && this.halfOpenProbesInFlight > 0) {
        this.halfOpenProbesInFlight--;
      }
    }
  }

  private recordSuccess(): void {
    this.successCount++;
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successCount >= (this.config.successThreshold ?? 2)) {
        this.closeCircuit();
      }
    } else {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }

    logger.info('Circuit breaker recorded success', {
      state: this.state,
      successCount: this.successCount,
      failureCount: this.failureCount,
    });
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= (this.config.failureThreshold ?? 5)) {
        this.openCircuit();
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state immediately reopens the circuit
      this.openCircuit();
    }

    logger.warn('Circuit breaker recorded failure', {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    });
  }

  private openCircuit(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + (this.config.recoveryTimeoutMs ?? 60000);
    this.successCount = 0;
    this.halfOpenProbesInFlight = 0;

    logger.error('Circuit breaker opened due to repeated failures', {
      failureCount: this.failureCount,
      failureThreshold: this.config.failureThreshold,
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
      nextAttemptTime: this.nextAttemptTime,
    });
  }

  private closeCircuit(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = null;
    this.halfOpenProbesInFlight = 0;

    logger.info('Circuit breaker closed after successful recovery', {
      successCount: this.successCount,
      successThreshold: this.config.successThreshold,
    });
  }

  private checkRecoveryWindow(): void {
    if (this.state === CircuitState.OPEN && this.nextAttemptTime) {
      if (Date.now() >= this.nextAttemptTime) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        this.nextAttemptTime = null;
        this.halfOpenProbesInFlight = 0;

        logger.info('Circuit breaker transitioned to HALF_OPEN for recovery attempt', {
          previousState: CircuitState.OPEN,
          newState: CircuitState.HALF_OPEN,
        });
      }
    }
  }

  reset(): void {
    const previousState = this.state;
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;
    this.halfOpenProbesInFlight = 0;

    logger.info('Circuit breaker manually reset', {
      previousState,
    });
  }
}

/**
 * Manages independent circuit breakers keyed by provider id.
 * Each provider's state is tracked separately so that failures from one
 * provider do not affect the availability of others.
 */
export class ProviderCircuitBreakerService {
  private breakers: Map<string, CircuitBreaker> = new Map();

  constructor(private defaultConfig: CircuitBreakerConfig = {}) {}

  /**
   * Returns the circuit breaker for the given provider, creating one if needed.
   */
  getBreaker(providerId: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker({ ...this.defaultConfig, ...config });
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  /**
   * Executes the given function under the provider's circuit breaker.
   */
  async execute<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    return this.getBreaker(providerId).execute(fn);
  }

  /**
   * Returns the current state for the given provider.
   */
  getState(providerId: string): CircuitState {
    return this.getBreaker(providerId).getState();
  }

  /**
   * Returns stats for the given provider.
   */
  getStats(providerId: string): CircuitBreakerStats {
    return this.getBreaker(providerId).getStats();
  }

  /**
   * Returns stats for all tracked providers.
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const result: Record<string, CircuitBreakerStats> = {};
    for (const [providerId, breaker] of this.breakers.entries()) {
      result[providerId] = breaker.getStats();
    }
    return result;
  }

  /**
   * Resets the circuit breaker for a single provider.
   */
  reset(providerId: string): void {
    const breaker = this.breakers.get(providerId);
    if (breaker) {
      breaker.reset();
    }
  }

  /**
   * Resets all circuit breakers.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
