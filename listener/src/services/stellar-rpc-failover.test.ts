/**
 * Multi-RPC endpoint failover — issue #1112.
 *
 * Complements stellar-rpc-manager.test.ts with coverage for:
 *   - failback to the primary once it recovers,
 *   - threshold-based health tracking across calls,
 *   - application errors never triggering failover,
 *   - credentials never reaching logs, status snapshots or thrown errors.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarRpcManager } from './stellar-rpc-manager';
import { redactRpcUrl, redactUrlsInText, RPC_REDACTED } from '../utils/rpc-url-redaction';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const PRIMARY = 'https://primary.stellar.org';
const FALLBACK = 'https://fallback.stellar.org';
const SECRET_KEY = 'fakeRpcKey0a1b2c3d4e5f6a7b8c9d0';

function networkError(): Error {
  const err = new Error('connect ECONNREFUSED');
  (err as any).code = 'ECONNREFUSED';
  return err;
}

function fakeServerFactory(url: string): StellarSDK.rpc.Server {
  return { serverURL: url } as unknown as StellarSDK.rpc.Server;
}

function allLoggedText(): string {
  const mocked = logger as jest.Mocked<typeof logger>;
  return JSON.stringify([
    mocked.info.mock.calls,
    mocked.warn.mock.calls,
    mocked.error.mock.calls,
    mocked.debug.mock.calls,
  ]);
}

describe('redactRpcUrl', () => {
  it('leaves plain endpoints unchanged', () => {
    expect(redactRpcUrl('https://soroban-testnet.stellar.org:443')).toBe(
      'https://soroban-testnet.stellar.org:443',
    );
    expect(redactRpcUrl('https://rpc.example.com/soroban/rpc')).toBe(
      'https://rpc.example.com/soroban/rpc',
    );
  });

  it('redacts userinfo credentials', () => {
    const out = redactRpcUrl('https://alice:hunter2@rpc.example.com/rpc');
    expect(out).toBe(`https://${RPC_REDACTED}@rpc.example.com/rpc`);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('alice');
  });

  it('redacts sensitive query parameters but keeps harmless ones', () => {
    const out = redactRpcUrl(`https://rpc.example.com/?apiKey=${SECRET_KEY}&network=testnet`);
    expect(out).not.toContain(SECRET_KEY);
    expect(out).toContain(`apiKey=${RPC_REDACTED}`);
    expect(out).toContain('network=testnet');
  });

  it('redacts opaque API keys embedded in the path', () => {
    const out = redactRpcUrl(`https://rpc.example.com/v1/${SECRET_KEY}`);
    expect(out).toBe(`https://rpc.example.com/v1/${RPC_REDACTED}`);
  });

  it('never echoes unparseable input', () => {
    expect(redactRpcUrl(`not a url ${SECRET_KEY}`)).toBe('[unparseable-url]');
  });

  it('redacts URLs embedded in free text', () => {
    const text = `request to https://u:p@rpc.example.com/?token=${SECRET_KEY} failed`;
    const out = redactUrlsInText(text);
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain('u:p@');
    expect(out).toContain('failed');
  });
});

describe('StellarRpcManager failover (#1112)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fails back to the primary once its cooldown has elapsed', async () => {
    const manager = new StellarRpcManager({
      primaryUrl: PRIMARY,
      fallbackUrls: [FALLBACK],
      failureThreshold: 1,
      cooldownMs: 1_000,
      serverFactory: fakeServerFactory,
    });

    manager.recordFailure(PRIMARY, networkError());
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);

    // Still within cooldown: stay on the fallback.
    expect(manager.maybeFailback()).toBe(false);
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);

    (manager as any).endpoints[0].lastFailureTime = Date.now() - 2_000;

    const seen: string[] = [];
    await manager.executeWithFallback(async (_server, url) => {
      seen.push(url);
      return 'ok';
    });

    expect(seen).toEqual([PRIMARY]);
    expect(manager.getActiveEndpoint()).toBe(PRIMARY);
    expect(manager.getEndpointStatuses()[0].status).toBe('healthy');
    expect((logger as jest.Mocked<typeof logger>).info).toHaveBeenCalledWith(
      'Stellar RPC failback: returning to higher-priority endpoint',
      expect.objectContaining({ previousEndpoint: FALLBACK, newEndpoint: PRIMARY }),
    );
  });

  it('does not fail back when failback is disabled', () => {
    const manager = new StellarRpcManager({
      primaryUrl: PRIMARY,
      fallbackUrls: [FALLBACK],
      failureThreshold: 1,
      cooldownMs: 0,
      failbackToPrimary: false,
      serverFactory: fakeServerFactory,
    });

    manager.recordFailure(PRIMARY, networkError());
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);
    expect(manager.maybeFailback()).toBe(false);
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);
  });

  it('re-fails over when a probed primary is still unavailable', async () => {
    const manager = new StellarRpcManager({
      primaryUrl: PRIMARY,
      fallbackUrls: [FALLBACK],
      failureThreshold: 1,
      cooldownMs: 1_000,
      serverFactory: fakeServerFactory,
    });

    manager.recordFailure(PRIMARY, networkError());
    (manager as any).endpoints[0].lastFailureTime = Date.now() - 2_000;

    const seen: string[] = [];
    const result = await manager.executeWithFallback(async (_server, url) => {
      seen.push(url);
      if (url === PRIMARY) throw networkError();
      return 'from-fallback';
    });

    expect(result).toBe('from-fallback');
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);
    expect(manager.getEndpointStatuses()[0].status).toBe('unhealthy');
  });

  it('tracks consecutive failures against the configured threshold', () => {
    const manager = new StellarRpcManager({
      primaryUrl: PRIMARY,
      fallbackUrls: [FALLBACK],
      failureThreshold: 3,
      serverFactory: fakeServerFactory,
    });

    manager.recordFailure(PRIMARY, networkError());
    manager.recordFailure(PRIMARY, networkError());
    expect(manager.getActiveEndpoint()).toBe(PRIMARY);
    expect(manager.getEndpointStatuses()[0].status).toBe('degraded');
    expect(manager.getEndpointStatuses()[0].consecutiveFailures).toBe(2);

    manager.recordFailure(PRIMARY, networkError());
    expect(manager.getActiveEndpoint()).toBe(FALLBACK);
    expect(manager.getEndpointStatuses()[0].status).toBe('unhealthy');
  });

  it('does not record failures or switch endpoints on application errors', async () => {
    const manager = new StellarRpcManager({
      primaryUrl: PRIMARY,
      fallbackUrls: [FALLBACK],
      failureThreshold: 1,
      serverFactory: fakeServerFactory,
    });

    const appError = new Error('Contract data not found');
    await expect(
      manager.executeWithFallback(async () => {
        throw appError;
      }),
    ).rejects.toBe(appError);

    const invalidParams = Object.assign(new Error('invalid params'), { rpcCode: -32602 });
    await expect(
      manager.executeWithFallback(async () => {
        throw invalidParams;
      }),
    ).rejects.toBe(invalidParams);

    expect(manager.getActiveEndpoint()).toBe(PRIMARY);
    const [primary] = manager.getEndpointStatuses();
    expect(primary.status).toBe('healthy');
    expect(primary.totalFailures).toBe(0);
  });

  it('never exposes credentials in logs, statuses or thrown errors', async () => {
    const securedPrimary = `https://user:${SECRET_KEY}@primary.example.com/rpc`;
    const securedFallback = `https://fallback.example.com/v1/${SECRET_KEY}?apiKey=${SECRET_KEY}`;
    const manager = new StellarRpcManager({
      primaryUrl: securedPrimary,
      fallbackUrls: [securedFallback],
      failureThreshold: 1,
      serverFactory: fakeServerFactory,
    });

    let thrown: unknown;
    try {
      await manager.executeWithFallback(async (_server, url) => {
        const err = new Error(`request to ${url} failed: ECONNREFUSED`);
        (err as any).code = 'ECONNREFUSED';
        throw err;
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(SECRET_KEY);

    const statuses = manager.getEndpointStatuses();
    for (const status of statuses) {
      expect(status.redactedUrl).not.toContain(SECRET_KEY);
      expect(status.lastError ?? '').not.toContain(SECRET_KEY);
    }

    expect(allLoggedText()).not.toContain(SECRET_KEY);
  });
});
