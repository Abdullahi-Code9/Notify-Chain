/**
 * Tests for RpcCapabilityChecker (Task 4)
 *
 * Coverage:
 * - All probes pass → CapabilityCheckPassed
 * - One probe fails → CapabilityCheckFailed with actionable gaps
 * - Multiple probes fail → all gaps are aggregated
 * - METHOD_NOT_FOUND, RESPONSE_MALFORMED, RESPONSE_MISSING_FIELD codes
 * - Probe timeout → gap with UNEXPECTED_ERROR code
 * - Probe that throws → gap with UNEXPECTED_ERROR code
 * - Custom probes (for unit-testing individual capabilities)
 * - createCapabilityChecker factory smoke test
 * - Failure message is non-empty and actionable
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import {
  RpcCapabilityChecker,
  createCapabilityChecker,
  type CapabilityCheckFailed,
  type CapabilityCheckPassed,
  type CapabilityGap,
} from './rpc-capability-checker';

// ---------------------------------------------------------------------------
// Mock server factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock of `StellarSDK.rpc.Server`.
 * Only the methods exercised by the checker need to be present.
 */
function makeMockServer(overrides: {
  getLatestLedger?: () => Promise<unknown>;
  getEvents?: (req: unknown) => Promise<unknown>;
  getFeeStats?: () => Promise<unknown>;
}): StellarSDK.rpc.Server {
  return {
    getLatestLedger: overrides.getLatestLedger ?? (() => Promise.resolve({ sequence: 5000 })),
    getEvents:
      overrides.getEvents ??
      (() => Promise.resolve({ events: [], latestLedger: 5000, cursor: '' })),
    getFeeStats:
      overrides.getFeeStats ?? (() => Promise.resolve({ sorobanInclusionFee: { min: '100' } })),
  } as unknown as StellarSDK.rpc.Server;
}

// ---------------------------------------------------------------------------
// All-pass scenarios
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — all probes pass', () => {
  it('returns passed: true when all methods respond correctly', async () => {
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(true);
  });

  it('reports the correct number of probes run', async () => {
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    if (!result.passed) throw new Error('Expected passed');
    // Default probes: getLatestLedger, getEvents, getFeeStats
    expect(result.probesRun).toBe(3);
  });

  it('includes a durationMs in the passed result', async () => {
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// getLatestLedger failures
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — getLatestLedger failures', () => {
  it('reports METHOD_NOT_FOUND when getLatestLedger throws with -32601', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'getLatestLedger');
    expect(gap).toBeDefined();
    expect(gap!.code).toBe('METHOD_NOT_FOUND');
    expect(gap!.action).toBeTruthy();
  });

  it('reports RESPONSE_MALFORMED when getLatestLedger returns null', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.resolve(null),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'getLatestLedger');
    expect(gap!.code).toBe('RESPONSE_MALFORMED');
  });

  it('reports RESPONSE_MISSING_FIELD when sequence is absent', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.resolve({ status: 'ok' }), // no sequence
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'getLatestLedger');
    expect(gap!.code).toBe('RESPONSE_MISSING_FIELD');
  });

  it('accepts the `ledger` field as an alternative to `sequence`', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.resolve({ ledger: 1234 }),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    // getLatestLedger should pass — the other probes may still produce gaps
    const gap = result.passed ? null : result.gaps.find((g) => g.method === 'getLatestLedger');
    expect(gap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getEvents failures
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — getEvents failures', () => {
  it('reports METHOD_NOT_FOUND when getEvents throws with -32601', async () => {
    const server = makeMockServer({
      getEvents: () => Promise.reject(new Error('Method not found: -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'getEvents');
    expect(gap!.code).toBe('METHOD_NOT_FOUND');
    expect(gap!.action).toMatch(/soroban-rpc/i);
  });

  it('ignores "start ledger too old" errors (method exists, node pruned early ledgers)', async () => {
    const server = makeMockServer({
      getEvents: () =>
        Promise.reject(new Error('Start ledger is too old and not available on this node')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    // getEvents probe should pass; other probes may or may not pass
    const gap = result.passed ? null : result.gaps.find((g) => g.method === 'getEvents');
    expect(gap).toBeUndefined();
  });

  it('reports RESPONSE_MISSING_FIELD when events array is absent', async () => {
    const server = makeMockServer({
      getEvents: () => Promise.resolve({ latestLedger: 100 }), // no `events`
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'getEvents');
    expect(gap!.code).toBe('RESPONSE_MISSING_FIELD');
  });
});

// ---------------------------------------------------------------------------
// Multiple probes fail — all gaps aggregated
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — multiple failures aggregated', () => {
  it('collects gaps from all failing probes', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found')),
      getEvents: () => Promise.reject(new Error('method not found')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    expect(result.gaps.length).toBeGreaterThanOrEqual(2);
  });

  it('failure message lists all missing methods', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
      getEvents: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = (await checker.check()) as CapabilityCheckFailed;
    expect(result.message).toMatch(/getLatestLedger/);
    expect(result.message).toMatch(/getEvents/);
  });

  it('failure message is non-empty and contains action guidance', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = (await checker.check()) as CapabilityCheckFailed;
    expect(result.message.length).toBeGreaterThan(50);
    expect(result.message).toMatch(/action/i);
  });
});

// ---------------------------------------------------------------------------
// Probe-level timeout
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — probe timeout', () => {
  it('returns a gap with UNEXPECTED_ERROR code when a probe times out', async () => {
    const neverResolves: CapabilityProbeType = {
      name: 'slowProbe',
      run: () => new Promise(() => {}), // never resolves
    };
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server, {
      timeoutMs: 10, // 10 ms — tiny on purpose
      probes: [neverResolves],
    });
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    const gap = result.gaps.find((g) => g.method === 'slowProbe');
    expect(gap).toBeDefined();
    expect(gap!.code).toBe('UNEXPECTED_ERROR');
    expect(gap!.detail).toMatch(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// Probe that throws
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — probe throws', () => {
  it('captures thrown probe errors as UNEXPECTED_ERROR gaps', async () => {
    const throwingProbe: CapabilityProbeType = {
      name: 'throwingProbe',
      run: () => Promise.reject(new Error('probe blew up')),
    };
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server, {
      probes: [throwingProbe],
    });
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    expect(result.gaps[0].code).toBe('UNEXPECTED_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Custom probes (extensibility)
// ---------------------------------------------------------------------------

type CapabilityProbeType = {
  name: string;
  run(server: StellarSDK.rpc.Server): Promise<CapabilityGap | null>;
};

describe('RpcCapabilityChecker — custom probes', () => {
  it('accepts an array of custom probes and runs only those', async () => {
    let called = false;
    const customProbe: CapabilityProbeType = {
      name: 'customMethod',
      run: async () => {
        called = true;
        return null; // pass
      },
    };
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server, { probes: [customProbe] });
    const result = await checker.check();
    expect(called).toBe(true);
    expect(result.passed).toBe(true);
    if (!result.passed) throw new Error('Expected passed');
    expect(result.probesRun).toBe(1);
  });

  it('custom probe that fails is captured as a gap', async () => {
    const failingProbe: CapabilityProbeType = {
      name: 'missingFeature',
      run: async () => ({
        method: 'missingFeature',
        code: 'METHOD_NOT_FOUND' as const,
        detail: 'missingFeature is not exposed by this endpoint.',
        action: 'Upgrade your RPC node.',
      }),
    };
    const server = makeMockServer({});
    const checker = new RpcCapabilityChecker(server, { probes: [failingProbe] });
    const result = await checker.check();
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error('Expected failed');
    expect(result.gaps[0].method).toBe('missingFeature');
  });
});

// ---------------------------------------------------------------------------
// createCapabilityChecker factory smoke test
// ---------------------------------------------------------------------------

describe('createCapabilityChecker factory', () => {
  it('returns an RpcCapabilityChecker instance', () => {
    const checker = createCapabilityChecker('https://soroban-rpc.example.com');
    expect(checker).toBeInstanceOf(RpcCapabilityChecker);
  });
});

// ---------------------------------------------------------------------------
// Actionable error messages (core acceptance criterion)
// ---------------------------------------------------------------------------

describe('RpcCapabilityChecker — actionable error messages', () => {
  it('each gap has a non-empty action string', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
      getEvents: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    if (result.passed) throw new Error('Expected failed');
    for (const gap of result.gaps) {
      expect(gap.action.trim().length).toBeGreaterThan(0);
    }
  });

  it('each gap has a non-empty detail string', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = await checker.check();
    if (result.passed) throw new Error('Expected failed');
    for (const gap of result.gaps) {
      expect(gap.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it('failure message includes the number of checks that ran', async () => {
    const server = makeMockServer({
      getLatestLedger: () => Promise.reject(new Error('method not found -32601')),
    });
    const checker = new RpcCapabilityChecker(server);
    const result = (await checker.check()) as CapabilityCheckFailed;
    // message should be informative enough to drive operator action
    expect(result.message).toMatch(/check/i);
  });

  it('system does not silently pass when a required method is absent', async () => {
    // Scenario: endpoint is a bare Horizon node with no soroban-rpc methods
    const horizonLikeServer = makeMockServer({
      getLatestLedger: () =>
        Promise.reject(new Error('Method not found -32601: getLatestLedger')),
      getEvents: () =>
        Promise.reject(new Error('Method not found -32601: getEvents')),
      getFeeStats: () =>
        Promise.reject(new Error('Method not found -32601: getFeeStats')),
    });
    const checker = new RpcCapabilityChecker(horizonLikeServer);
    const result = await checker.check();
    // Must FAIL — not silently pass
    expect(result.passed).toBe(false);
  });
});
