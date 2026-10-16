/**
 * In-memory telemetry for blockchain polling cycles.
 *
 * Records the outcome of every polling cycle (duration and success) so the
 * listener's synchronization state can be inspected through the existing
 * health/diagnostic interface. State is held in memory only, so recorded
 * values reset naturally when the process restarts.
 */

export interface PollingMetricsSnapshot {
  /** ISO timestamp of the most recent successful poll, or null if none yet. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the most recent failed poll, or null if none yet. */
  lastFailureAt: string | null;
  /** ISO timestamp of the most recent poll cycle (successful or not). */
  lastPollAt: string | null;
  /** Duration of the most recent poll cycle in milliseconds. */
  lastPollDurationMs: number | null;
  /** Whether the most recent poll cycle completed without error. */
  lastPollSucceeded: boolean | null;
  /** Total number of recorded poll cycles. */
  totalPolls: number;
  /** Number of successful poll cycles. */
  successfulPolls: number;
  /** Number of failed poll cycles. */
  failedPolls: number;
  /** Success ratio (0-100) rounded to one decimal place, or null when idle. */
  successRate: number | null;
  /** Average duration of recent poll cycles in milliseconds. */
  averageDurationMs: number | null;
  /** Durations of the most recent poll cycles (oldest first, size-capped). */
  recentDurationsMs: number[];
}

/** Maximum number of recent cycle durations retained in memory. */
const RECENT_DURATIONS_LIMIT = 100;

/**
 * Collects minimal, in-memory telemetry about blockchain polling cycles.
 *
 * Recording a cycle is O(1) apart from a size-capped ring of recent
 * durations, so the overhead on the hot polling path remains negligible.
 */
export class PollingMetrics {
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastPollAt: number | null = null;
  private lastPollDurationMs: number | null = null;
  private lastPollSucceeded: boolean | null = null;
  private totalPolls = 0;
  private successfulPolls = 0;
  private failedPolls = 0;
  private recentDurationsMs: number[] = [];

  /**
   * Record the outcome of a single polling cycle.
   *
   * Failed cycles never update the last-successful-poll timestamp, keeping
   * the listener's "actively synchronizing" signal accurate.
   */
  record(durationMs: number, success: boolean): void {
    const now = Date.now();
    const normalizedDuration = Math.max(0, durationMs);

    this.totalPolls++;
    this.lastPollAt = now;
    this.lastPollDurationMs = normalizedDuration;
    this.lastPollSucceeded = success;

    if (success) {
      this.successfulPolls++;
      this.lastSuccessAt = now;
    } else {
      this.failedPolls++;
      this.lastFailureAt = now;
    }

    this.recentDurationsMs.push(normalizedDuration);
    if (this.recentDurationsMs.length > RECENT_DURATIONS_LIMIT) {
      this.recentDurationsMs.shift();
    }
  }

  /** Returns a serializable snapshot of the recorded poll telemetry. */
  snapshot(): PollingMetricsSnapshot {
    const recentCount = this.recentDurationsMs.length;
    const totalDurationMs = this.recentDurationsMs.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    const averageDurationMs =
      recentCount > 0 ? Math.round((totalDurationMs / recentCount) * 10) / 10 : null;

    return {
      lastSuccessAt:
        this.lastSuccessAt !== null ? new Date(this.lastSuccessAt).toISOString() : null,
      lastFailureAt:
        this.lastFailureAt !== null ? new Date(this.lastFailureAt).toISOString() : null,
      lastPollAt: this.lastPollAt !== null ? new Date(this.lastPollAt).toISOString() : null,
      lastPollDurationMs: this.lastPollDurationMs,
      lastPollSucceeded: this.lastPollSucceeded,
      totalPolls: this.totalPolls,
      successfulPolls: this.successfulPolls,
      failedPolls: this.failedPolls,
      successRate:
        this.totalPolls > 0 ? Math.round((this.successfulPolls / this.totalPolls) * 1000) / 10 : null,
      averageDurationMs,
      recentDurationsMs: [...this.recentDurationsMs],
    };
  }

  /** Clears all recorded telemetry, returning to the post-restart state. */
  reset(): void {
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastPollAt = null;
    this.lastPollDurationMs = null;
    this.lastPollSucceeded = null;
    this.totalPolls = 0;
    this.successfulPolls = 0;
    this.failedPolls = 0;
    this.recentDurationsMs = [];
  }
}

/** Process-wide polling telemetry collector. */
export const pollingMetrics = new PollingMetrics();