import { Database } from '../database/database';
import logger from '../utils/logger';

export type ScheduleAuditAction = 'CREATED' | 'MODIFIED' | 'CANCELLED' | 'EXECUTED';

export interface ScheduleAuditRecord {
  id: number;
  scheduledNotificationId: number;
  action: ScheduleAuditAction;
  actor: string;
  timestamp: Date;
  fromStatus: string | null;
  toStatus: string | null;
  /** Non-sensitive identifiers and transition metadata only (no full payloads). */
  details: Record<string, unknown> | null;
}

export interface ScheduleAuditRecordRow {
  id: number;
  scheduled_notification_id: number;
  action: string;
  actor: string;
  timestamp: string;
  from_status: string | null;
  to_status: string | null;
  details: string | null;
}

export interface RecordScheduleAuditInput {
  scheduledNotificationId: number;
  action: ScheduleAuditAction;
  actor?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Append-only audit trail for scheduled notification lifecycle transitions.
 * Stores timestamps and identifiers; avoids duplicating sensitive payload values.
 */
export class ScheduleAuditTrail {
  constructor(private readonly db: Database) {}

  async record(input: RecordScheduleAuditInput): Promise<number> {
    if (!Number.isInteger(input.scheduledNotificationId) || input.scheduledNotificationId <= 0) {
      throw new Error('scheduledNotificationId must be a positive integer');
    }

    const timestamp = new Date().toISOString();
    const actor = input.actor?.trim() || 'system';
    const safeDetails = input.details ? this.sanitizeDetails(input.details) : null;

    const result = await this.db.run(
      `INSERT INTO schedule_audit_log (
        scheduled_notification_id, action, actor, timestamp, from_status, to_status, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scheduledNotificationId,
        input.action,
        actor,
        timestamp,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        safeDetails ? JSON.stringify(safeDetails) : null,
      ],
    );

    logger.info('Schedule audit record created', {
      auditId: result.lastID,
      scheduledNotificationId: input.scheduledNotificationId,
      action: input.action,
      actor,
    });

    return result.lastID;
  }

  async getByNotificationId(scheduledNotificationId: number): Promise<ScheduleAuditRecord[]> {
    const rows = await this.db.all<ScheduleAuditRecordRow>(
      `SELECT * FROM schedule_audit_log
       WHERE scheduled_notification_id = ?
       ORDER BY timestamp ASC, id ASC`,
      [scheduledNotificationId],
    );
    return rows.map((row) => this.rowToModel(row));
  }

  async query(filters: {
    action?: ScheduleAuditAction;
    since?: Date;
    until?: Date;
    limit?: number;
  } = {}): Promise<ScheduleAuditRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.action) {
      clauses.push('action = ?');
      params.push(filters.action);
    }
    if (filters.since) {
      clauses.push('timestamp >= ?');
      params.push(filters.since.toISOString());
    }
    if (filters.until) {
      clauses.push('timestamp <= ?');
      params.push(filters.until.toISOString());
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
    params.push(limit);

    const rows = await this.db.all<ScheduleAuditRecordRow>(
      `SELECT * FROM schedule_audit_log ${where}
       ORDER BY timestamp DESC, id DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => this.rowToModel(row));
  }

  private sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
    const blocked = new Set(['payload', 'body', 'message', 'content', 'secret', 'token', 'password']);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (blocked.has(key.toLowerCase())) continue;
      if (value !== null && typeof value === 'object') continue;
      out[key] = value;
    }
    return out;
  }

  private rowToModel(row: ScheduleAuditRecordRow): ScheduleAuditRecord {
    return {
      id: row.id,
      scheduledNotificationId: row.scheduled_notification_id,
      action: row.action as ScheduleAuditAction,
      actor: row.actor,
      timestamp: new Date(row.timestamp),
      fromStatus: row.from_status,
      toStatus: row.to_status,
      details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    };
  }
}
