import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let config: CircuitBreakerConfig;

  beforeEach(() => {
    config = {
      failureThreshold: 3,
      recoveryTimeoutMs: 1000,
      requestTimeoutMs: 100,
    };
    circuitBreaker = new CircuitBreaker(config);
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
    });
  });

  describe('successful requests', () => {
    it('should track successful requests', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await circuitBreaker.execute(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successCount).toBe(1);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.state).toBe(CircuitState.CLOSED);
    });

    it('should remain CLOSED after successful requests', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      for (let i = 0; i < 5; i++) {
        await circuitBreaker.execute(fn);
      }

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.successCount).toBe(5);
    });
  });

  describe('failed requests', () => {
    it('should track failed requests', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      await expect(circuitBreaker.execute(fn)).rejects.toThrow('failure');

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(1);
      expect(metrics.successCount).toBe(0);
      expect(metrics.lastFailureTime).not.toBeNull();
    });

    it('should open circuit after threshold failures', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('failure');
      }

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.OPEN);
      expect(metrics.failureCount).toBe(3);
      expect(metrics.nextAttemptTime).not.toBeNull();
    });

    it('should reject requests when circuit is OPEN', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('failure');
      }

      // Try to execute while open
      await expect(circuitBreaker.execute(fn)).rejects.toThrow('Circuit breaker is OPEN');
      expect(fn).toHaveBeenCalledTimes(3); // Should not call again while open
    });
  });

  describe('recovery', () => {
    it('should transition to HALF_OPEN after recovery timeout', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('failure'));
      const successFn = jest.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('failure');
      }

      expect(circuitBreaker.getMetrics().state).toBe(CircuitState.OPEN);

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Next request should transition to HALF_OPEN
      const result = await circuitBreaker.execute(successFn);
      expect(result).toBe('success');

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
    });

    it('should close circuit on successful HALF_OPEN request', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('failure'));
      const successFn = jest.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('failure');
      }

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Successful request should close the circuit
      await circuitBreaker.execute(successFn);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
    });

    it('should reopen circuit on failed HALF_OPEN request', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('failure'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('failure');
      }

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Failed request in HALF_OPEN should reopen
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow('failure');

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.OPEN);
    });
  });

  describe('request timeout', () => {
    it('should timeout slow requests', async () => {
      const slowFn = jest.fn().mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 200))
      );

      await expect(circuitBreaker.execute(slowFn)).rejects.toThrow('Request timeout');

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(1);
    });
  });

  describe('manual control', () => {
    it('should reset to CLOSED state', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('failure');
      }

      circuitBreaker.reset();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.lastFailureTime).toBeNull();
      expect(metrics.nextAttemptTime).toBeNull();
    });

    it('should force open circuit', () => {
      circuitBreaker.forceOpen();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.OPEN);
      expect(metrics.nextAttemptTime).not.toBeNull();
    });

    it('should force close circuit', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('failure'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('failure');
      }

      circuitBreaker.forceClose();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('default configuration', () => {
    it('should use default values when config is partial', () => {
      const partialConfig: CircuitBreakerConfig = {};
      const cb = new CircuitBreaker(partialConfig);

      const fn = jest.fn().mockResolvedValue('success');
      cb.execute(fn); // Should not throw

      // Verify defaults are applied
      expect(cb.getMetrics().state).toBe(CircuitState.CLOSED);
    });
  });

  describe('metrics', () => {
    it('should provide accurate metrics', async () => {
      const successFn = jest.fn().mockResolvedValue('success');
      const failFn = jest.fn().mockRejectedValue(new Error('failure'));

      await circuitBreaker.execute(successFn);
      await circuitBreaker.execute(successFn);
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successCount).toBe(2);
      expect(metrics.failureCount).toBe(1);
      expect(metrics.lastSuccessTime).not.toBeNull();
      expect(metrics.lastFailureTime).not.toBeNull();
    });
  });
});
