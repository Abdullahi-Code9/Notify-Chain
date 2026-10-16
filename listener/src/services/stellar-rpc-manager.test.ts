import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  StellarRpcManager,
  isRpcFailureCondition,
} from './stellar-rpc-manager';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  sanitizeUrl: jest.fn((url: string) => url),
}));

describe('StellarRpcManager', () => {
  const mockLogger = logger as jest.Mocked<typeof logger>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization and Configuration', () => {
    it('initializes with a single primary endpoint', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
      });

      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
      expect(manager.getAllEndpoints()).toEqual(['https://primary.stellar.org']);
      const statuses = manager.getEndpointStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].url).toBe('https://primary.stellar.org');
      expect(statuses[0].isPrimary).toBe(true);
      expect(statuses[0].status).toBe('healthy');
      expect(statuses[0].consecutiveFailures).toBe(0);
    });

    it('initializes with multiple fallback endpoints and deduplicates primary', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: [
          'https://fallback-1.stellar.org',
          'https://primary.stellar.org', // Duplicate primary
          'https://fallback-2.stellar.org',
          'https://fallback-1.stellar.org', // Duplicate fallback
        ],
        failureThreshold: 2,
        cooldownMs: 30000,
        requestTimeoutMs: 5000,
      });

      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
      expect(manager.getAllEndpoints()).toEqual([
        'https://primary.stellar.org',
        'https://fallback-1.stellar.org',
        'https://fallback-2.stellar.org',
      ]);
      expect(manager.getEndpointStatuses()).toHaveLength(3);
    });

    it('throws error when primary URL is empty or whitespace', () => {
      expect(
        () => new StellarRpcManager({ primaryUrl: '   ' })
      ).toThrow('StellarRpcManager requires a non-empty primaryUrl');
    });
  });

  describe('isRpcFailureCondition', () => {
    it('identifies network error codes as RPC failure conditions', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      (err as any).code = 'ECONNREFUSED';

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('ECONNREFUSED');
    });

    it('identifies DNS lookup failure as RPC failure condition', () => {
      const err = new Error('getaddrinfo ENOTFOUND soroban.example.org');
      (err as any).code = 'ENOTFOUND';

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('ENOTFOUND');
    });

    it('identifies timeouts as RPC failure conditions', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('timed out');
    });

    it('identifies HTTP 5xx server status errors', () => {
      const err = new Error('Internal Server Error');
      (err as any).status = 503;

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('503');
    });

    it('identifies HTTP 429 rate limit errors', () => {
      const err = new Error('Rate limit exceeded');
      (err as any).status = 429;

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('429');
    });

    it('identifies JSON-RPC server error codes', () => {
      const err = new Error('Internal JSON-RPC node error');
      (err as any).rpcCode = -32603;

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(true);
      expect(result.reason).toContain('-32603');
    });

    it('does NOT treat client-side JSON-RPC invalid params as failure condition', () => {
      const err = new Error('Invalid params');
      (err as any).rpcCode = -32602;

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(false);
      expect(result.reason).toContain('Client JSON-RPC error');
    });

    it('does NOT treat generic application error as failure condition', () => {
      const err = new Error('Contract validation assertion: balance too low');

      const result = isRpcFailureCondition(err);
      expect(result.isFailure).toBe(false);
    });
  });

  describe('Failover and Endpoint Switching', () => {
    it('marks endpoint degraded before reaching failure threshold', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
        failureThreshold: 3,
      });

      const err = new Error('ECONNREFUSED');
      (err as any).code = 'ECONNREFUSED';

      const res = manager.recordFailure('https://primary.stellar.org', err);
      expect(res.switched).toBe(false);
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');

      const statuses = manager.getEndpointStatuses();
      expect(statuses[0].status).toBe('degraded');
      expect(statuses[0].consecutiveFailures).toBe(1);
    });

    it('triggers failover when consecutive failures reach threshold and logs switch', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback-1.stellar.org', 'https://fallback-2.stellar.org'],
        failureThreshold: 2,
      });

      const err = new Error('connect ETIMEDOUT');
      (err as any).code = 'ETIMEDOUT';

      // 1st failure: degraded
      manager.recordFailure('https://primary.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');

      // 2nd failure: threshold reached -> triggers failover to fallback-1
      const res = manager.recordFailure('https://primary.stellar.org', err);
      expect(res.switched).toBe(true);
      expect(res.previousUrl).toBe('https://primary.stellar.org');
      expect(res.newUrl).toBe('https://fallback-1.stellar.org');
      expect(manager.getActiveEndpoint()).toBe('https://fallback-1.stellar.org');

      // Acceptance Criteria: Endpoint switching is logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failover triggered: switching active endpoint',
        expect.objectContaining({
          previousEndpoint: 'https://primary.stellar.org',
          newEndpoint: 'https://fallback-1.stellar.org',
          consecutiveFailures: 2,
          failureThreshold: 2,
        })
      );
    });

    it('resets consecutive failures and restores healthy status on success', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
      });

      const err = new Error('ECONNREFUSED');
      (err as any).code = 'ECONNREFUSED';

      manager.recordFailure('https://primary.stellar.org', err);
      expect(manager.getEndpointStatuses()[0].consecutiveFailures).toBe(1);

      manager.recordSuccess('https://primary.stellar.org');
      const status = manager.getEndpointStatuses()[0];
      expect(status.consecutiveFailures).toBe(0);
      expect(status.status).toBe('healthy');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stellar RPC endpoint recovered',
        expect.objectContaining({
          endpoint: 'https://primary.stellar.org',
        })
      );
    });

    it('cycles through multiple fallbacks in ring order', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://ep1.stellar.org',
        fallbackUrls: ['https://ep2.stellar.org', 'https://ep3.stellar.org'],
        failureThreshold: 1,
      });

      const err = new Error('503 Service Unavailable');
      (err as any).status = 503;

      // Fail ep1 -> switches to ep2
      manager.recordFailure('https://ep1.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://ep2.stellar.org');

      // Fail ep2 -> switches to ep3
      manager.recordFailure('https://ep2.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://ep3.stellar.org');

      // Fail ep3 -> switches back to oldest failed endpoint (ep1)
      manager.recordFailure('https://ep3.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://ep1.stellar.org');
    });

    it('handles single endpoint gracefully when failover is triggered', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://single.stellar.org',
        failureThreshold: 1,
      });

      const err = new Error('500 Internal Error');
      (err as any).status = 500;

      const res = manager.recordFailure('https://single.stellar.org', err);
      expect(res.switched).toBe(true);
      expect(res.previousUrl).toBe('https://single.stellar.org');
      expect(res.newUrl).toBe('https://single.stellar.org');
      expect(manager.getActiveEndpoint()).toBe('https://single.stellar.org');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failover triggered but no fallback endpoints configured',
        expect.objectContaining({
          endpoint: 'https://single.stellar.org',
        })
      );
    });
  });

  describe('Cooldown Mechanism', () => {
    it('marks cooled down endpoint degraded and eligible for failover probing', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
        failureThreshold: 1,
        cooldownMs: 1000,
      });

      const err = new Error('ECONNRESET');
      (err as any).code = 'ECONNRESET';

      // Primary fails -> fails over to fallback
      manager.recordFailure('https://primary.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://fallback.stellar.org');
      expect(manager.getEndpointStatuses()[0].status).toBe('unhealthy');

      // Fast-forward or simulate timestamp beyond cooldown
      const primaryState = (manager as any).endpoints[0];
      primaryState.lastFailureTime = Date.now() - 2000;

      // Status check triggers cooldown evaluation
      const statuses = manager.getEndpointStatuses();
      expect(statuses[0].status).toBe('degraded');

      // Now if fallback fails, manager switches back to primary (which cooled down)
      manager.recordFailure('https://fallback.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
    });
  });

  describe('executeWithFallback Wrapper', () => {
    it('executes operation successfully on primary endpoint', async () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
      });

      const op = jest.fn().mockImplementation((server, url) => Promise.resolve({ data: 'ok', url }));

      const result = await manager.executeWithFallback(op as any);
      expect(result).toEqual({ data: 'ok', url: 'https://primary.stellar.org' });
      expect(op).toHaveBeenCalledTimes(1);
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
    });

    it('automatically fails over and retries on fallback when primary encounters failure condition', async () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
        failureThreshold: 1,
      });

      let callCount = 0;
      const op = jest.fn().mockImplementation((_server, url) => {
        callCount++;
        if (url === 'https://primary.stellar.org') {
          const netErr = new Error('connect ECONNREFUSED');
          (netErr as any).code = 'ECONNREFUSED';
          return Promise.reject(netErr);
        }
        return Promise.resolve({ success: true, url });
      });

      const result = await manager.executeWithFallback(op as any, { operationName: 'getEvents' });
      expect(result).toEqual({ success: true, url: 'https://fallback.stellar.org' });
      expect(callCount).toBe(2);
      expect(manager.getActiveEndpoint()).toBe('https://fallback.stellar.org');

      // Endpoint switch was logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stellar RPC failover triggered: switching active endpoint',
        expect.objectContaining({
          previousEndpoint: 'https://primary.stellar.org',
          newEndpoint: 'https://fallback.stellar.org',
        })
      );
    });

    it('rethrows immediately on non-RPC failure error without switching endpoint', async () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
      });

      const clientErr = new Error('Invalid parameter: bad contract ID');
      (clientErr as any).rpcCode = -32602;

      const op = jest.fn<() => Promise<any>>().mockRejectedValue(clientErr);

      await expect(manager.executeWithFallback(op as any)).rejects.toThrow('Invalid parameter');
      expect(op).toHaveBeenCalledTimes(1);
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
    });

    it('throws aggregated error when all endpoints in pool fail', async () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback-1.stellar.org', 'https://fallback-2.stellar.org'],
      });

      const op = jest.fn().mockImplementation((_server, url) => {
        const err = new Error(`503 from ${url}`);
        (err as any).status = 503;
        return Promise.reject(err);
      });

      await expect(
        manager.executeWithFallback(op as any, { operationName: 'pollLedger' })
      ).rejects.toThrow(/failed across 3 endpoint\(s\)/);

      expect(op).toHaveBeenCalledTimes(3);
    });

    it('triggers timeout when operation exceeds configured timeout', async () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
        requestTimeoutMs: 50,
      });

      const op = jest.fn().mockImplementation((_server, url) => {
        if (url === 'https://primary.stellar.org') {
          // Slow operation that times out
          return new Promise((resolve) => setTimeout(() => resolve('slow'), 200));
        }
        return Promise.resolve('fast-fallback');
      });

      const result = await manager.executeWithFallback(op as any, { timeoutMs: 50 });
      expect(result).toBe('fast-fallback');
      expect(manager.getActiveEndpoint()).toBe('https://fallback.stellar.org');
    });
  });

  describe('Management and Reset', () => {
    it('allows manually setting the active endpoint', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
      });

      manager.setActiveEndpoint('https://fallback.stellar.org');
      expect(manager.getActiveEndpoint()).toBe('https://fallback.stellar.org');

      expect(() => manager.setActiveEndpoint('https://unknown.stellar.org')).toThrow(
        'is not configured'
      );
    });

    it('resets all endpoints to healthy and resets active index to primary', () => {
      const manager = new StellarRpcManager({
        primaryUrl: 'https://primary.stellar.org',
        fallbackUrls: ['https://fallback.stellar.org'],
        failureThreshold: 1,
      });

      const err = new Error('ETIMEDOUT');
      (err as any).code = 'ETIMEDOUT';

      manager.recordFailure('https://primary.stellar.org', err);
      expect(manager.getActiveEndpoint()).toBe('https://fallback.stellar.org');

      manager.reset();
      expect(manager.getActiveEndpoint()).toBe('https://primary.stellar.org');
      expect(manager.getEndpointStatuses()[0].status).toBe('healthy');
      expect(manager.getEndpointStatuses()[0].consecutiveFailures).toBe(0);
    });
  });
});
