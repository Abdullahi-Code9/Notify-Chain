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

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
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

        logger.info('Circuit breaker transitioned to HALF_OPEN for recovery attempt', {
          previousState: CircuitState.OPEN,
          newState: CircuitState.HALF_OPEN,
        });
      }
    }
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttemptTime = null;

    logger.info('Circuit breaker manually reset', {
      previousState: this.state,
    });
  }
}
