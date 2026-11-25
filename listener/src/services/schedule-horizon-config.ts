import { DEFAULT_MAX_SCHEDULING_HORIZON_MS } from './schedule-validator';

const MAX_SCHEDULING_HORIZON_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function parseMaxSchedulingHorizon(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_MAX_SCHEDULING_HORIZON_MS;
  if (value === '0') return null;

  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new Error(
      'MAX_SCHEDULING_HORIZON must be a positive duration (for example 30d or 12h), or 0 to disable it.',
    );
  }

  const amount = Number(match[1]);
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };
  const durationMs = amount * unitMs[match[2]];
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_SCHEDULING_HORIZON_MS
  ) {
    throw new Error('MAX_SCHEDULING_HORIZON must be a positive duration no longer than 100 years.');
  }
  return durationMs;
}
