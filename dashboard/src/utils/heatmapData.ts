import type { BlockchainEvent } from '../types/event';

/**
 * Represents a single cell in the heatmap grid.
 * `day` is 0–6 (Sunday–Saturday), `hour` is 0–23.
 */
export interface HeatmapCell {
  day: number;
  hour: number;
  count: number;
  /** Normalised intensity in 0–1 range, used for colour interpolation. */
  intensity: number;
}

/**
 * Result of aggregating events into heatmap data.
 */
export interface HeatmapData {
  cells: HeatmapCell[][];
  maxCount: number;
  totalCount: number;
  dateRange: { start: Date; end: Date } | null;
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) return '12a';
  if (i < 12) return `${i}a`;
  if (i === 12) return '12p';
  return `${i - 12}p`;
});

/**
 * Filters events to those within the given date range.
 * Returns all events when start/end are null.
 */
export function filterEventsByDateRange(
  events: BlockchainEvent[],
  start: Date | null,
  end: Date | null,
): BlockchainEvent[] {
  if (!start && !end) return events;

  const startMs = start ? start.getTime() : -Infinity;
  const endMs = end ? end.getTime() : Infinity;

  return events.filter((event) => {
    const ts = event.receivedAt;
    return ts >= startMs && ts <= endMs;
  });
}

/**
 * Aggregates an array of blockchain events into a 7×24 heatmap grid.
 *
 * Performance: iterates events once (O(n)), then normalises the 168 cells (O(1)).
 */
export function aggregateHeatmapData(
  events: BlockchainEvent[],
  startDate: Date | null = null,
  endDate: Date | null = null,
): HeatmapData {
  const filtered = filterEventsByDateRange(events, startDate, endDate);

  // Build the 7×24 count grid
  const counts: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  let maxCount = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const event of filtered) {
    const date = new Date(event.receivedAt);
    const day = date.getDay();
    const hour = date.getHours();

    counts[day][hour]++;

    if (counts[day][hour] > maxCount) {
      maxCount = counts[day][hour];
    }
    if (event.receivedAt < minTs) minTs = event.receivedAt;
    if (event.receivedAt > maxTs) maxTs = event.receivedAt;
  }

  // Convert to HeatmapCell[][]
  const cells: HeatmapCell[][] = counts.map((hourCounts, day) =>
    hourCounts.map((count, hour) => ({
      day,
      hour,
      count,
      intensity: maxCount > 0 ? count / maxCount : 0,
    })),
  );

  return {
    cells,
    maxCount,
    totalCount: filtered.length,
    dateRange: minTs <= maxTs ? { start: new Date(minTs), end: new Date(maxTs) } : null,
  };
}

/**
 * Returns an intensity level (0-4) for colour-stepped rendering.
 * Level 0 = no activity, Level 4 = peak activity.
 */
export function intensityLevel(intensity: number): number {
  if (intensity === 0) return 0;
  if (intensity < 0.25) return 1;
  if (intensity < 0.5) return 2;
  if (intensity < 0.75) return 3;
  return 4;
}
