import { RpcRateLimiter } from './rpc-rate-limiter';
import { RpcRateLimitConfig } from '../types';

describe('RpcRateLimiter', () => {
  describe('constructor', () => {
    it('should initialize with default tokens equal to burst size', () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 1000,
      };
      const limiter = new RpcRateLimiter(config);
      const metrics = limiter.getMetrics();
      expect(metrics.currentTokens).toBe(20);
    });

    it('should initialize with zero metrics', () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 1000,
      };
      const limiter = new RpcRateLimiter(config);
      const metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.throttledRequests).toBe(0);
      expect(metrics.allowedRequests).toBe(0);
    });
  });

  describe('acquire when disabled', () => {
    it('should allow requests immediately when disabled', async () => {
      const config: RpcRateLimitConfig = {
        enabled: false,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 1000,
      };
      const limiter = new RpcRateLimiter(config);

      const start = Date.now();
      await limiter.acquire();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should be nearly instant
      const metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(0); // No tracking when disabled
    });

    it('should allow multiple rapid requests when disabled', async () => {
      const config: RpcRateLimitConfig = {
        enabled: false,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 1000,
      };
      const limiter = new RpcRateLimiter(config);

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        await limiter.acquire();
      }
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(500); // Should be very fast
    });
  });

  describe('acquire when enabled', () => {
    it('should allow requests within burst limit', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 5,
        throttleDelayMs: 100,
      };
      const limiter = new RpcRateLimiter(config);

      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should be nearly instant
      const metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.allowedRequests).toBe(5);
      expect(metrics.throttledRequests).toBe(0);
    });

    it('should throttle requests exceeding burst limit', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 2,
        throttleDelayMs: 50,
      };
      const limiter = new RpcRateLimiter(config);

      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      const duration = Date.now() - start;

      // Should take at least 3 * throttleDelayMs (3 throttles)
      expect(duration).toBeGreaterThanOrEqual(150);
      const metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(5); // 5 actual requests
      expect(metrics.allowedRequests).toBe(5); // All 5 eventually allowed
      expect(metrics.throttledRequests).toBeGreaterThan(0); // Some were throttled
    });

    it('should refill tokens over time', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 100, // High rate for quick refill
        burstSize: 5,
        throttleDelayMs: 10,
      };
      const limiter = new RpcRateLimiter(config);

      // Exhaust burst
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      let metrics = limiter.getMetrics();
      expect(metrics.currentTokens).toBeLessThan(1);

      // Wait for refill - 100ms should give us 10 tokens at 100/sec
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Make a request to trigger refill check
      await limiter.acquire();

      // Should have some tokens back (the refill should have happened)
      metrics = limiter.getMetrics();
      expect(metrics.currentTokens).toBeGreaterThan(0);
    });

    it('should allow sustained rate after burst', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 5,
        throttleDelayMs: 10,
      };
      const limiter = new RpcRateLimiter(config);

      // Exhaust burst
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      // Make more requests - should be throttled to sustained rate
      const start = Date.now();
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }
      const duration = Date.now() - start;

      // 10 requests at 10/sec should take ~1 second
      expect(duration).toBeGreaterThanOrEqual(900);
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('getMetrics', () => {
    it('should return current metrics', () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 1000,
      };
      const limiter = new RpcRateLimiter(config);

      const metrics = limiter.getMetrics();
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('throttledRequests');
      expect(metrics).toHaveProperty('allowedRequests');
      expect(metrics).toHaveProperty('currentTokens');
      expect(metrics).toHaveProperty('maxRequestsPerSecond');
      expect(metrics).toHaveProperty('burstSize');
    });

    it('should reflect configuration in metrics', () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 15,
        burstSize: 25,
        throttleDelayMs: 500,
      };
      const limiter = new RpcRateLimiter(config);

      const metrics = limiter.getMetrics();
      expect(metrics.maxRequestsPerSecond).toBe(15);
      expect(metrics.burstSize).toBe(25);
    });
  });

  describe('resetMetrics', () => {
    it('should reset all metrics to zero', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 100,
      };
      const limiter = new RpcRateLimiter(config);

      // Make some requests
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }

      let metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThan(0);

      limiter.resetMetrics();

      metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.throttledRequests).toBe(0);
      expect(metrics.allowedRequests).toBe(0);
    });

    it('should not reset current tokens', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 20,
        throttleDelayMs: 100,
      };
      const limiter = new RpcRateLimiter(config);

      // Exhaust some tokens
      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }

      let metrics = limiter.getMetrics();
      const tokensBeforeReset = metrics.currentTokens;

      limiter.resetMetrics();

      metrics = limiter.getMetrics();
      expect(metrics.currentTokens).toBe(tokensBeforeReset);
    });
  });

  describe('edge cases', () => {
    it('should handle zero throttle delay', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 5,
        throttleDelayMs: 0,
      };
      const limiter = new RpcRateLimiter(config);

      // Should not hang even with zero delay
      // With burstSize of 5, we can make 5 requests without throttling
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();

      const metrics = limiter.getMetrics();
      expect(metrics.totalRequests).toBe(5);
      expect(metrics.allowedRequests).toBe(5);
      expect(metrics.throttledRequests).toBe(0);
    });

    it('should handle very high burst size', async () => {
      const config: RpcRateLimitConfig = {
        enabled: true,
        maxRequestsPerSecond: 10,
        burstSize: 1000,
        throttleDelayMs: 100,
      };
      const limiter = new RpcRateLimiter(config);

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        await limiter.acquire();
      }
      const duration = Date.now() - start;

      // Should be fast due to high burst
      expect(duration).toBeLessThan(500);
    });
  });
});
