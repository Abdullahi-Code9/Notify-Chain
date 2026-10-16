/**
 * RPC Benchmark Service
 *
 * Benchmarks Soroban RPC endpoints by calling the JSON-RPC API directly via
 * fetch. Measures response latency, retrieves ledger info, and reports
 * availability — all in parallel.
 */

import type { RpcEndpoint } from '../config/rpcEndpoints';
import { RPC_TIMEOUT_MS } from '../config/rpcEndpoints';

export interface BenchmarkResult {
  endpointId: string;
  url: string;
  label: string;
  network: string;
  latencyMs: number | null;
  blockHeight: number | null;
  status: 'ok' | 'error' | 'timeout';
  errorMessage?: string;
  rank: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpcCall(
  url: string,
  method: string,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {},
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as JsonRpcResponse;

    if (data.error) {
      throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function benchmarkEndpoint(
  endpoint: RpcEndpoint,
  timeoutMs: number,
): Promise<BenchmarkResult> {
  const base: Omit<BenchmarkResult, 'latencyMs' | 'blockHeight' | 'status' | 'rank'> = {
    endpointId: endpoint.id,
    url: endpoint.url,
    label: endpoint.label,
    network: endpoint.network,
  };

  try {
    const start = performance.now();

    const [healthRes, ledgerRes] = await Promise.all([
      rpcCall(endpoint.url, 'getHealth', timeoutMs),
      rpcCall(endpoint.url, 'getLatestLedger', timeoutMs),
    ]);

    const latencyMs = Math.round(performance.now() - start);

    const healthStatus = healthRes.result?.status;
    if (healthStatus !== 'alive') {
      return {
        ...base,
        latencyMs,
        blockHeight: null,
        status: 'error',
        errorMessage: `Unhealthy: ${String(healthStatus)}`,
        rank: 0,
      };
    }

    const blockHeight =
      typeof ledgerRes.result?.sequence === 'number'
        ? ledgerRes.result.sequence
        : null;

    return {
      ...base,
      latencyMs,
      blockHeight,
      status: 'ok',
      rank: 0,
    };
  } catch (err: unknown) {
    const isAbort =
      err instanceof DOMException && err.name === 'AbortError';
    const message =
      err instanceof Error ? err.message : 'Unknown error';

    return {
      ...base,
      latencyMs: null,
      blockHeight: null,
      status: isAbort ? 'timeout' : 'error',
      errorMessage: isAbort ? 'Request timed out' : message,
      rank: 0,
    };
  }
}

function rankResults(results: BenchmarkResult[]): BenchmarkResult[] {
  const successful = results
    .filter((r) => r.status === 'ok' && r.latencyMs !== null)
    .sort((a, b) => a.latencyMs! - b.latencyMs!);

  const failed = results.filter((r) => r.status !== 'ok');

  const ranked: BenchmarkResult[] = [];
  let currentRank = 1;
  for (let i = 0; i < successful.length; i++) {
    if (
      i > 0 &&
      successful[i].latencyMs === successful[i - 1].latencyMs
    ) {
      ranked.push({ ...successful[i], rank: ranked[ranked.length - 1].rank });
    } else {
      ranked.push({ ...successful[i], rank: currentRank });
      currentRank = i + 2;
    }
  }

  return [...ranked, ...failed.map((r) => ({ ...r, rank: Infinity }))];
}

/**
 * Benchmark all provided endpoints concurrently.
 * Returns results sorted by rank (fastest first).
 */
export async function runBenchmark(
  endpoints: RpcEndpoint[],
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<BenchmarkResult[]> {
  const raw = await Promise.all(
    endpoints.map((ep) => benchmarkEndpoint(ep, timeoutMs)),
  );
  return rankResults(raw);
}
