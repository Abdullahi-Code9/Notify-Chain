/**
 * Dead-Letter Isolation & Remediation System (Issue #706)
 *
 * Isolates exhausted or unrecoverable notifications into a dedicated DLQ store,
 * preventing pipeline head-of-line blocking while maintaining full operator traceability.
 */

import { randomUUID } from 'crypto';
import { redactString } from '../utils/redact';

export interface DeadLetterEntry {
  dlqId: string;
  originalNotificationId: string;
  provider: string;
  targetRecipientSanitized: string;
  failureReason: string;
  errorStack?: string;
  retryAttempts: number;
  payload: Record<string, unknown>;
  isolatedAt: string;
  status: 'isolated' | 'requeued' | 'discarded';
}

export class DeadLetterManager {
  private readonly store = new Map<string, DeadLetterEntry>();

  /**
   * Isolates a failed notification into the Dead Letter Queue.
   */
  public isolateNotification(params: {
    originalNotificationId: string;
    provider: string;
    targetRecipient: string;
    error: Error | string;
    retryAttempts: number;
    payload: Record<string, unknown>;
  }): DeadLetterEntry {
    const dlqId = `dlq-${randomUUID()}`;
    const rawReason = params.error instanceof Error ? params.error.message : String(params.error);
    const rawStack = params.error instanceof Error ? params.error.stack : undefined;

    const entry: DeadLetterEntry = {
      dlqId,
      originalNotificationId: params.originalNotificationId,
      provider: params.provider,
      targetRecipientSanitized: redactString(params.targetRecipient),
      failureReason: redactString(rawReason),
      errorStack: rawStack ? redactString(rawStack) : undefined,
      retryAttempts: params.retryAttempts,
      payload: params.payload,
      isolatedAt: new Date().toISOString(),
      status: 'isolated',
    };

    this.store.set(dlqId, entry);
    return entry;
  }

  /**
   * Retrieves a single DLQ entry for operator diagnostic inspection.
   */
  public getDeadLetter(dlqId: string): DeadLetterEntry | undefined {
    return this.store.get(dlqId);
  }

  /**
   * Lists isolated dead-letter entries with pagination and provider filtering.
   */
  public listDeadLetters(options: {
    provider?: string;
    status?: 'isolated' | 'requeued' | 'discarded';
    limit?: number;
    offset?: number;
  } = {}): { entries: DeadLetterEntry[]; total: number } {
    let all = Array.from(this.store.values());

    if (options.provider) {
      all = all.filter((e) => e.provider === options.provider);
    }
    if (options.status) {
      all = all.filter((e) => e.status === options.status);
    }

    const total = all.length;
    const offset = options.offset || 0;
    const limit = options.limit || 50;

    return {
      entries: all.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Marks a dead-letter entry as requeued for pipeline re-processing.
   */
  public requeue(dlqId: string): DeadLetterEntry {
    const entry = this.store.get(dlqId);
    if (!entry) {
      throw new Error(`DLQ entry '${dlqId}' not found.`);
    }
    entry.status = 'requeued';
    return entry;
  }

  /**
   * Discards / acknowledges a dead-letter entry without re-delivery.
   */
  public discard(dlqId: string): DeadLetterEntry {
    const entry = this.store.get(dlqId);
    if (!entry) {
      throw new Error(`DLQ entry '${dlqId}' not found.`);
    }
    entry.status = 'discarded';
    return entry;
  }

  /**
   * Returns DLQ metrics for monitoring dashboards.
   */
  public getMetrics(): { totalIsolated: number; activeDepth: number; requeuedCount: number } {
    const all = Array.from(this.store.values());
    return {
      totalIsolated: all.length,
      activeDepth: all.filter((e) => e.status === 'isolated').length,
      requeuedCount: all.filter((e) => e.status === 'requeued').length,
    };
  }
}
