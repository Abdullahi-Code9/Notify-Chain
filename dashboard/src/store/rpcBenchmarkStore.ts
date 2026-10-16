import { create } from 'zustand';
import type { RpcEndpoint } from '../config/rpcEndpoints';
import { DEFAULT_RPC_ENDPOINTS } from '../config/rpcEndpoints';
import type { BenchmarkResult } from '../services/rpcBenchmarkService';
import { runBenchmark } from '../services/rpcBenchmarkService';
import {
  getActiveRpcUrl,
  setActiveRpcUrl,
} from '../config/rpcConfig';

export interface RpcBenchmarkState {
  endpoints: RpcEndpoint[];
  results: BenchmarkResult[];
  isRunning: boolean;
  activeRpcUrl: string;
  error: string | null;

  addEndpoint: (endpoint: RpcEndpoint) => void;
  removeEndpoint: (id: string) => void;
  runTests: () => Promise<void>;
  connectToFastest: () => string | null;
}

export const useRpcBenchmarkStore = create<RpcBenchmarkState>((set, get) => ({
  endpoints: [...DEFAULT_RPC_ENDPOINTS],
  results: [],
  isRunning: false,
  activeRpcUrl: getActiveRpcUrl(),
  error: null,

  addEndpoint: (endpoint) =>
    set((state) => ({
      endpoints: [...state.endpoints, endpoint],
    })),

  removeEndpoint: (id) =>
    set((state) => ({
      endpoints: state.endpoints.filter((ep) => ep.id !== id),
    })),

  runTests: async () => {
    const { endpoints } = get();
    set({ isRunning: true, error: null, results: [] });

    try {
      const results = await runBenchmark(endpoints);
      set({ results, isRunning: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Benchmark failed';
      set({ isRunning: false, error: message });
    }
  },

  connectToFastest: () => {
    const { results } = get();
    const fastest = results.find((r) => r.status === 'ok');
    if (!fastest) return null;

    setActiveRpcUrl(fastest.url);
    set({ activeRpcUrl: fastest.url });
    return fastest.url;
  },
}));
