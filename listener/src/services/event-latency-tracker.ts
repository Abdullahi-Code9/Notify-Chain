/**
 * Event processing latency breakdown (issue #1120).
 *
 * Measures four independent stages of the event pipeline:
 *
 *   retrieval         RPC `getEvents` call that returned the event's batch
 *                     (the batch duration is attributed to every event in it)
 *   decodeValidation  payload validation, filtering, normalization/decoding
 *                     and provenance checks
 *   persistence       deduplication lookup, registry write and the final
 *                     processed_events write
 *   notificationPrep  preference checks and building/dispatching the
 *                     notification (including retry-queue hand-off)
 *
 * Records hold identifiers and durations only — never topics, values or any
 * other event payload — so they are safe to expose on internal diagnostics.
 *
 * Instrumentation must never break processing: every method is total, a
 * stage that never started or never ended is simply reported as missing.
 */

export const EVENT_STAGES = ['retrieval', 'decodeValidation', 'persistence', 'notificationPrep'] as const;

export type EventStage = (typeof EVENT_STAGES)[number];

export type StageDurations = Partial<Record<EventStage, number>>;

export interface EventLatencyRecord {
  eventId: string;
  contractAddress: string;
  /** Epoch ms when the record was finalized. */
  recordedAt: number;
  outcome: 'processed' | 'duplicate' | 'skipped' | 'error';
  /** Stage durations in ms; absent stages were not measured. */
  stages: StageDurations;
  /** Stages with no measurement for this event. */
  missingStages: EventStage[];
  /** Sum of the measured stages, or `null` when none were measured. */
  totalMs: number | null;
}

export interface StageSummary {
  count: number;
  missing: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface LatencySummary {
  sampleSize: number;
  stages: Record<EventStage, StageSummary>;
}

type Clock = () => number;

const defaultClock: Clock = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function isValidDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Accumulates stage durations for a single event. Calling `end` without a
 * matching `start` is ignored; repeated measurements of a stage add up.
 */
export class StageTimer {
  private readonly startedAt = new Map<EventStage, number>();
  private readonly durations: StageDurations = {};

  constructor(private readonly clock: Clock = defaultClock) {}

  start(stage: EventStage): void {
    this.startedAt.set(stage, this.clock());
  }

  end(stage: EventStage): void {
    const started = this.startedAt.get(stage);
    if (started === undefined) return;
    this.startedAt.delete(stage);
    this.add(stage, this.clock() - started);
  }

  /** Adds an externally measured duration (e.g. batch retrieval time). */
  add(stage: EventStage, durationMs: number | undefined | null): void {
    if (!isValidDuration(durationMs)) return;
    this.durations[stage] = round((this.durations[stage] ?? 0) + durationMs);
  }

  /** Times `fn` under `stage`, recording the duration even when it throws. */
  async measure<T>(stage: EventStage, fn: () => Promise<T>): Promise<T> {
    this.start(stage);
    try {
      return await fn();
    } finally {
      this.end(stage);
    }
  }

  snapshot(): StageDurations {
    return { ...this.durations };
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** Bounded in-memory store of recent latency records. */
export class EventLatencyStore {
  private records: EventLatencyRecord[] = [];

  constructor(private readonly capacity = 500) {}

  record(input: {
    eventId: unknown;
    contractAddress: unknown;
    outcome: EventLatencyRecord['outcome'];
    stages: StageDurations | undefined | null;
    recordedAt?: number;
  }): EventLatencyRecord {
    const stages: StageDurations = {};
    for (const stage of EVENT_STAGES) {
      const value = input.stages?.[stage];
      if (isValidDuration(value)) stages[stage] = value;
    }
    const measured = Object.values(stages) as number[];
    const record: EventLatencyRecord = {
      eventId: typeof input.eventId === 'string' ? input.eventId : '',
      contractAddress: typeof input.contractAddress === 'string' ? input.contractAddress : '',
      recordedAt: input.recordedAt ?? Date.now(),
      outcome: input.outcome,
      stages,
      missingStages: EVENT_STAGES.filter((stage) => stages[stage] === undefined),
      totalMs: measured.length > 0 ? round(measured.reduce((sum, v) => sum + v, 0)) : null,
    };

    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
    return record;
  }

  /** Most recent records first. */
  list(limit = 50): EventLatencyRecord[] {
    const safeLimit = Math.max(0, Math.min(Math.floor(limit) || 0, this.capacity));
    return this.records.slice(-safeLimit).reverse();
  }

  find(eventId: string, contractAddress?: string): EventLatencyRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.eventId === eventId && (!contractAddress || r.contractAddress === contractAddress)) {
        return r;
      }
    }
    return undefined;
  }

  summary(): LatencySummary {
    const stages = {} as Record<EventStage, StageSummary>;
    for (const stage of EVENT_STAGES) {
      const values = this.records
        .map((r) => r.stages[stage])
        .filter(isValidDuration)
        .sort((a, b) => a - b);
      stages[stage] = {
        count: values.length,
        missing: this.records.length - values.length,
        avgMs: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length) : null,
        p50Ms: percentile(values, 50),
        p95Ms: percentile(values, 95),
        maxMs: values.length ? values[values.length - 1] : null,
      };
    }
    return { sampleSize: this.records.length, stages };
  }

  clear(): void {
    this.records = [];
  }
}

/** Process-wide store used by the event subscriber and diagnostics API. */
export const eventLatencyStore = new EventLatencyStore();

/** Parses a persisted `stage_timings` column; tolerates absent/corrupt data. */
export function parseStageTimings(raw: unknown): StageDurations | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: StageDurations = {};
    for (const stage of EVENT_STAGES) {
      if (isValidDuration(parsed[stage])) out[stage] = parsed[stage] as number;
    }
    return out;
  } catch {
    return null;
  }
}
