import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  const defaultConfig: CircuitBreakerConfig = {
    failureThreshold: 3,
    recoveryTimeoutMs: 1000,
    successThreshold: 2,
  };

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker(defaultConfig);
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('has zero failure and success counts', () => {
      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(0);
    });
  });

  describe('successful execution', () => {
    it('executes function and returns result', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await circuitBreaker.execute(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('increments success count on successful execution', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      await circuitBreaker.execute(fn);

      const stats = circuitBreaker.getStats();
      expect(stats.successCount).toBe(1);
      expect(stats.failureCount).toBe(0);
    });

    it('resets failure count on success in CLOSED state', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Record failures
      for (let i = 0; i < 2; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getStats().failureCount).toBe(2);

      // Success resets failure count
      const successFn = jest.fn().mockResolvedValue('success');
      await circuitBreaker.execute(successFn);

      expect(circuitBreaker.getStats().failureCount).toBe(0);
      expect(circuitBreaker.getStats().successCount).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('increments failure count on failed execution', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      try {
        await circuitBreaker.execute(fn);
      } catch (e) {
        // Expected
      }

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(1);
      expect(stats.successCount).toBe(0);
    });

    it('opens circuit after reaching failure threshold', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Execute until threshold
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('blocks requests when circuit is OPEN', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Next call should be blocked
      await expect(circuitBreaker.execute(fn)).rejects.toThrow('Circuit breaker is OPEN');
      expect(fn).toHaveBeenCalledTimes(3); // Only the initial failures
    });
  });

  describe('recovery', () => {
    it('transitions to HALF_OPEN after recovery timeout', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Circuit should be in HALF_OPEN state
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('closes circuit after successful threshold in HALF_OPEN', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('success');
      
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Execute successful calls to close circuit
      await circuitBreaker.execute(successFn);
      await circuitBreaker.execute(successFn);

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('reopens circuit on failure in HALF_OPEN state', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('success');
      
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // One success
      await circuitBreaker.execute(successFn);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Failure reopens circuit
      try {
        await circuitBreaker.execute(failFn);
      } catch (e) {
        // Expected
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('reset', () => {
    it('resets circuit to CLOSED state', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      circuitBreaker.reset();

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStats().failureCount).toBe(0);
      expect(circuitBreaker.getStats().successCount).toBe(0);
    });
  });

  describe('configuration with defaults', () => {
    it('uses default values when config is partial', () => {
      const partialConfig: CircuitBreakerConfig = {};
      const cb = new CircuitBreaker(partialConfig);

      const stats = cb.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
    });

    it('applies custom failure threshold', async () => {
      const customConfig: CircuitBreakerConfig = {
        failureThreshold: 5,
        recoveryTimeoutMs: 1000,
        successThreshold: 2,
      };
      const cb = new CircuitBreaker(customConfig);
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      
      // Execute 4 times (should not open yet)
      for (let i = 0; i < 4; i++) {
        try {
          await cb.execute(fn);
        } catch (e) {
          // Expected
        }
      }

      expect(cb.getState()).toBe(CircuitState.CLOSED);

      // 5th failure opens circuit
      try {
        await cb.execute(fn);
      } catch (e) {
        // Expected
      }

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('stats', () => {
    it('returns current circuit statistics', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      await circuitBreaker.execute(fn);

      const stats = circuitBreaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(1);
      expect(stats.lastSuccessTime).not.toBeNull();
      expect(stats.lastFailureTime).toBeNull();
    });
  });
});
