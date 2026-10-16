import { describe, it, expect } from "vitest"; // if the repo uses jest, DELETE this line
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

// ADAPT 1: import the real registry/store and its types
// import { ... } from "../store/<the-file-you-found>";

const DATASET_SIZE = Number(process.env.PERF_DATASET_SIZE ?? 10_000);
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;
const ABS_FLOOR_MS = 2; // ignore sub-millisecond noise
const BASELINE_PATH = resolve(process.cwd(), "perf/query-baselines.json");
const UPDATING = process.env.UPDATE_PERF_BASELINE === "1";

// ADAPT 2: fill the store with DATASET_SIZE realistic events
// (same shape the store really holds; vary contract ids and event types)
async function seed(): Promise<void> {
  for (let i = 0; i < DATASET_SIZE; i++) {
    // e.g. registry.add({ id: `evt-${i}`, contractId: `C${i % 20}`, type: ..., ledger: i, ... });
  }
}

// ADAPT 3: one entry per important query you found in Step 1
const queries: { name: string; run: () => unknown | Promise<unknown> }[] = [
  // { name: "events: latest page (limit 50)", run: () => registry.list({ limit: 50 }) },
  // { name: "events: filter by contract", run: () => registry.list({ contractId: "C3" }) },
  // { name: "events: lookup by id", run: () => registry.get(`evt-${DATASET_SIZE - 1}`) },
  // { name: "dedup: has-seen check", run: () => deduplicator.isDuplicate(`evt-${DATASET_SIZE - 1}`) },
];

async function medianMs(fn: () => unknown | Promise<unknown>): Promise<number> {
  for (let i = 0; i < WARMUP_RUNS; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("query performance regression", () => {
  it("keeps critical queries within baseline tolerance", async () => {
    expect(queries.length).toBeGreaterThan(0);
    await seed();

    const measured: Record<string, number> = {};
    for (const q of queries) measured[q.name] = await medianMs(q.run);
    console.table(
      Object.entries(measured).map(([name, ms]) => ({ name, medianMs: Number(ms.toFixed(3)) })),
    );

    if (UPDATING) {
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      const out = {
        datasetSize: DATASET_SIZE,
        tolerance: 3,
        queries: Object.fromEntries(
          Object.entries(measured).map(([k, v]) => [k, { medianMs: Number(v.toFixed(3)) }]),
        ),
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    for (const q of queries) {
      const base = baseline.queries[q.name];
      expect(base, `no baseline for "${q.name}"; run npm run perf:baseline`).toBeDefined();
      const limit = Math.max(base.medianMs * baseline.tolerance, ABS_FLOOR_MS);
      expect(
        measured[q.name],
        `"${q.name}" took ${measured[q.name].toFixed(3)}ms, limit ${limit.toFixed(3)}ms (baseline ${base.medianMs}ms x${baseline.tolerance})`,
      ).toBeLessThanOrEqual(limit);
    }
  }, 60_000);
});