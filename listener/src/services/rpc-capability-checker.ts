/**
 * RPC Startup Capability Checker (Task 4)
 *
 * Probes an RPC endpoint at startup to verify that all required methods are
 * available and return well-formed responses.  If any requirement is missing
 * or returns an unexpected shape, the checker produces a clear, actionable
 * `CapabilityCheckFailure` listing exactly what is wrong — and the caller
 * (typically `index.ts`) must treat this as a fatal startup error so the
 * system never starts in a degraded, unsupported state.
 *
 * Design
 * ------
 * Each *capability probe* is a small async function that tests one RPC method
 * and returns either `null` (pass) or a `CapabilityGap` describing the problem.
 * The checker runs all probes and aggregates results.
 *
 * Adding a new requirement is as simple as pushing a new `CapabilityProbe`
 * into the `probes` array — no branching logic elsewhere needs changing.
 *
 * Usage
 * -----
 * ```ts
 * const checker = new RpcCapabilityChecker(server);
 * const result = await checker.check();
 * if (!result.passed) {
 *   logger.error('RPC capability checks failed', result);
 *   process.exit(1);
 * }
 * ```
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single unmet capability — describes what method is missing/broken and
 * what the operator should do to resolve it.
 */
export interface CapabilityGap {
  /** The RPC method name that was probed (e.g. `"getLatestLedger"`). */
  method: string;
  /** Machine-readable code for programmatic filtering. */
  code:
    | 'METHOD_NOT_FOUND'
    | 'RESPONSE_MALFORMED'
    | 'RESPONSE_MISSING_FIELD'
    | 'UNEXPECTED_ERROR';
  /** Human-readable description of the problem. */
  detail: string;
  /** Suggested action for the operator. */
  action: string;
}

/** Successful outcome — all probes passed. */
export interface CapabilityCheckPassed {
  passed: true;
  /** Total number of probes that ran. */
  probesRun: number;
  /** Latency of the overall check in milliseconds. */
  durationMs: number;
}

/** Failed outcome — one or more probes found gaps. */
export interface CapabilityCheckFailed {
  passed: false;
  /** All capability gaps detected. */
  gaps: CapabilityGap[];
  /** Total number of probes that ran. */
  probesRun: number;
  /** Latency of the overall check in milliseconds. */
  durationMs: number;
  /** Consolidated, human-readable error message suitable for logs / process.exit output. */
  message: string;
}

export type CapabilityCheckResult = CapabilityCheckPassed | CapabilityCheckFailed;

/**
 * Internal probe interface.  Each probe tests one RPC requirement and returns
 * `null` on success or a `CapabilityGap` on failure.
 */
interface CapabilityProbe {
  name: string;
  run(server: StellarSDK.rpc.Server): Promise<CapabilityGap | null>;
}

// ---------------------------------------------------------------------------
// Probe implementations
// ---------------------------------------------------------------------------

/**
 * Probe: `getLatestLedger` must return an object with a numeric `sequence`.
 */
const probeGetLatestLedger: CapabilityProbe = {
  name: 'getLatestLedger',
  async run(server) {
    let response: unknown;
    try {
      response = await (server as any).getLatestLedger();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes('method not found') ||
        msg.toLowerCase().includes('-32601')
      ) {
        return {
          method: 'getLatestLedger',
          code: 'METHOD_NOT_FOUND',
          detail: `RPC endpoint does not expose getLatestLedger: ${msg}`,
          action:
            'Ensure the RPC endpoint is running a Stellar RPC node (soroban-rpc) and not a bare Horizon instance.',
        };
      }
      return {
        method: 'getLatestLedger',
        code: 'UNEXPECTED_ERROR',
        detail: `getLatestLedger threw an unexpected error: ${msg}`,
        action: 'Check RPC endpoint connectivity and logs.',
      };
    }

    if (typeof response !== 'object' || response === null) {
      return {
        method: 'getLatestLedger',
        code: 'RESPONSE_MALFORMED',
        detail: 'getLatestLedger returned a non-object response.',
        action: 'Verify the RPC endpoint is compatible with soroban-rpc v0.19+.',
      };
    }

    const r = response as Record<string, unknown>;
    const sequence =
      typeof r.sequence === 'number'
        ? r.sequence
        : typeof r.ledger === 'number'
          ? r.ledger
          : typeof r.latestLedger === 'number'
            ? r.latestLedger
            : null;

    if (sequence === null || !Number.isInteger(sequence) || sequence < 1) {
      return {
        method: 'getLatestLedger',
        code: 'RESPONSE_MISSING_FIELD',
        detail:
          'getLatestLedger response does not contain a valid `sequence` (or `ledger` / `latestLedger`) field.',
        action:
          'Upgrade the RPC endpoint to a version that returns a numeric ledger sequence in getLatestLedger.',
      };
    }

    return null; // pass
  },
};

/**
 * Probe: `getEvents` must be callable with a minimal valid request and must
 * return an object with an `events` array.
 *
 * We pass `startLedger: 1` which may return 0 events — that is fine; we are
 * only checking the method exists and returns the expected shape.
 */
const probeGetEvents: CapabilityProbe = {
  name: 'getEvents',
  async run(server) {
    let response: unknown;
    try {
      response = await server.getEvents({
        filters: [],
        startLedger: 1,
        limit: 1,
      } as StellarSDK.rpc.Api.GetEventsRequest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A "start ledger too old" error means the method exists but the node
      // has already pruned ledger 1.  That is acceptable — the method is available.
      if (
        msg.toLowerCase().includes('start ledger') ||
        msg.toLowerCase().includes('ledger is not') ||
        msg.toLowerCase().includes('too old')
      ) {
        return null; // method exists, node just pruned early ledgers
      }
      if (
        msg.toLowerCase().includes('method not found') ||
        msg.toLowerCase().includes('-32601')
      ) {
        return {
          method: 'getEvents',
          code: 'METHOD_NOT_FOUND',
          detail: `RPC endpoint does not expose getEvents: ${msg}`,
          action:
            'The listener requires soroban-rpc, which exposes getEvents. ' +
            'Horizon does not support this method.',
        };
      }
      return {
        method: 'getEvents',
        code: 'UNEXPECTED_ERROR',
        detail: `getEvents threw an unexpected error during startup probe: ${msg}`,
        action: 'Check RPC endpoint connectivity and logs.',
      };
    }

    if (typeof response !== 'object' || response === null) {
      return {
        method: 'getEvents',
        code: 'RESPONSE_MALFORMED',
        detail: 'getEvents returned a non-object response.',
        action: 'Verify the RPC endpoint is compatible with soroban-rpc v0.19+.',
      };
    }

    const r = response as Record<string, unknown>;
    if (!Array.isArray(r.events)) {
      return {
        method: 'getEvents',
        code: 'RESPONSE_MISSING_FIELD',
        detail: 'getEvents response does not contain an `events` array field.',
        action:
          'Upgrade the RPC endpoint to a version that includes an `events` array in getEvents responses.',
      };
    }

    return null; // pass
  },
};

/**
 * Probe: `getFeeStats` must be callable and return an object.
 *
 * This verifies the node is a modern soroban-rpc that exposes fee information,
 * which the scheduler uses to cap transaction fees.  A missing getFeeStats
 * means the node may be too old or misconfigured.
 */
const probeGetFeeStats: CapabilityProbe = {
  name: 'getFeeStats',
  async run(server) {
    try {
      const response = await (server as any).getFeeStats?.();
      if (response === undefined) {
        // getFeeStats is not exposed as a method on this SDK version — treat
        // as unsupported rather than crashing.
        return {
          method: 'getFeeStats',
          code: 'METHOD_NOT_FOUND',
          detail: 'getFeeStats is not available on this RPC server or SDK version.',
          action:
            'Upgrade the RPC endpoint to soroban-rpc v0.24+ to enable fee-aware transaction submission.',
        };
      }
      if (typeof response !== 'object' || response === null) {
        return {
          method: 'getFeeStats',
          code: 'RESPONSE_MALFORMED',
          detail: 'getFeeStats returned a non-object response.',
          action: 'Verify the RPC endpoint version supports getFeeStats.',
        };
      }
      return null; // pass
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.toLowerCase().includes('method not found') ||
        msg.toLowerCase().includes('-32601')
      ) {
        return {
          method: 'getFeeStats',
          code: 'METHOD_NOT_FOUND',
          detail: `RPC endpoint does not expose getFeeStats: ${msg}`,
          action: 'Upgrade to soroban-rpc v0.24+ to use fee-aware transaction handling.',
        };
      }
      // getFeeStats failing for any other reason is treated as a soft failure —
      // return null to avoid blocking startup for non-critical capability.
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/** Options for `RpcCapabilityChecker`. */
export interface RpcCapabilityCheckerOptions {
  /**
   * Timeout (ms) for the entire capability check.  Individual probes that
   * exceed this limit will be treated as failures.  Default: 10 000 ms.
   */
  timeoutMs?: number;
  /**
   * Override the set of probes to run.  Useful in tests to isolate specific
   * capabilities without stubbing every method.
   *
   * When omitted the default set (`probeGetLatestLedger`, `probeGetEvents`,
   * `probeGetFeeStats`) is used.
   */
  probes?: CapabilityProbe[];
}

/**
 * Runs a set of capability probes against a Stellar RPC endpoint and
 * aggregates the results into a single `CapabilityCheckResult`.
 *
 * All probes run concurrently (via `Promise.allSettled`) so a slow or broken
 * method does not block other probes.
 */
export class RpcCapabilityChecker {
  private readonly server: StellarSDK.rpc.Server;
  private readonly timeoutMs: number;
  private readonly probes: CapabilityProbe[];

  constructor(server: StellarSDK.rpc.Server, options: RpcCapabilityCheckerOptions = {}) {
    this.server = server;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.probes = options.probes ?? [probeGetLatestLedger, probeGetEvents, probeGetFeeStats];
  }

  /**
   * Run all probes and return the aggregated result.
   *
   * Does not throw — failures are captured in the returned `CapabilityCheckFailed`.
   */
  async check(): Promise<CapabilityCheckResult> {
    const start = Date.now();

    logger.info('RpcCapabilityChecker: starting capability checks', {
      probeCount: this.probes.length,
      probes: this.probes.map((p) => p.name),
      timeoutMs: this.timeoutMs,
    });

    const settled = await Promise.allSettled(
      this.probes.map((probe) => this.runWithTimeout(probe)),
    );

    const gaps: CapabilityGap[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const probeName = this.probes[i].name;

      if (outcome.status === 'rejected') {
        gaps.push({
          method: probeName,
          code: 'UNEXPECTED_ERROR',
          detail: `Probe "${probeName}" threw during execution: ${String(outcome.reason)}`,
          action: 'Check RPC endpoint connectivity and listener logs.',
        });
      } else if (outcome.value !== null) {
        gaps.push(outcome.value);
      }
    }

    const durationMs = Date.now() - start;

    if (gaps.length === 0) {
      logger.info('RpcCapabilityChecker: all checks passed', {
        probesRun: this.probes.length,
        durationMs,
      });
      return { passed: true, probesRun: this.probes.length, durationMs };
    }

    const message = this.buildFailureMessage(gaps);
    logger.error('RpcCapabilityChecker: capability checks failed', {
      gapCount: gaps.length,
      gaps,
      probesRun: this.probes.length,
      durationMs,
    });

    return {
      passed: false,
      gaps,
      probesRun: this.probes.length,
      durationMs,
      message,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async runWithTimeout(probe: CapabilityProbe): Promise<CapabilityGap | null> {
    return Promise.race([
      probe.run(this.server),
      new Promise<CapabilityGap>((resolve) => {
        const timer = setTimeout(() => {
          resolve({
            method: probe.name,
            code: 'UNEXPECTED_ERROR',
            detail: `Probe "${probe.name}" timed out after ${this.timeoutMs}ms.`,
            action: `Check RPC endpoint responsiveness. The "${probe.name}" method did not respond within ${this.timeoutMs}ms.`,
          });
        }, this.timeoutMs);
        if (timer && typeof (timer as any).unref === 'function') {
          (timer as any).unref();
        }
      }),
    ]);
  }

  private buildFailureMessage(gaps: CapabilityGap[]): string {
    const lines = [
      `RPC endpoint failed ${gaps.length} capability check(s). ` +
        'The listener will not start in a degraded state. ' +
        'Address the following issues:',
      '',
      ...gaps.map(
        (g, i) =>
          `  [${i + 1}] Method: ${g.method}\n` +
          `       Code:   ${g.code}\n` +
          `       Detail: ${g.detail}\n` +
          `       Action: ${g.action}`,
      ),
    ];
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Creates a `RpcCapabilityChecker` pre-wired to the given RPC URL.
 *
 * ```ts
 * const result = await createCapabilityChecker(config.stellarRpcUrl).check();
 * ```
 */
export function createCapabilityChecker(
  rpcUrl: string,
  options?: RpcCapabilityCheckerOptions,
): RpcCapabilityChecker {
  const server = new StellarSDK.rpc.Server(rpcUrl);
  return new RpcCapabilityChecker(server, options);
}
