/**
 * Data Export Service (#850)
 *
 * Administrative utility for exporting selected notification and event records
 * for debugging, migration, or analysis.
 *
 * Acceptance Criteria:
 * - Records can be exported using defined filters (status, type, recipient, dates, etc.)
 * - Exported data has a documented format (JSON and CSV)
 * - Sensitive information is handled appropriately (secrets, tokens, credentials, and webhook secrets redacted)
 */

import { Database, getDatabase } from '../database/database';
import logger from '../utils/logger';
import { redactValue, REDACTED_PLACEHOLDER } from '../utils/redact';

export interface NotificationExportFilter {
  status?: string;
  notificationType?: string;
  targetRecipient?: string;
  fromDate?: string | Date;
  toDate?: string | Date;
  eventId?: string;
  contractAddress?: string;
  priority?: number;
  limit?: number;
  offset?: number;
  includeSensitive?: boolean;
}

export interface EventExportFilter {
  eventType?: string;
  contractAddress?: string;
  status?: string;
  fromDate?: string | Date;
  toDate?: string | Date;
  ledgerNumber?: number;
  txHash?: string;
  limit?: number;
  offset?: number;
  includeSensitive?: boolean;
}

export interface DataExportOptions {
  type?: 'notifications' | 'events' | 'all';
  format?: 'json' | 'csv';
  notificationFilters?: NotificationExportFilter;
  eventFilters?: EventExportFilter;
  includeSensitive?: boolean;
}

export interface ExportMetadata {
  exportedAt: string;
  version: string;
  type: 'notifications' | 'events' | 'all';
  format: 'json' | 'csv';
  redacted: boolean;
  totalNotifications?: number;
  totalEvents?: number;
  filtersApplied: Record<string, unknown>;
}

export interface ExportResult {
  metadata: ExportMetadata;
  notifications?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  csvContent?: string;
  durationMs: number;
}

/**
 * Redacts sensitive recipient contact data (e.g. Discord webhook tokens, webhook keys)
 * while preserving safe identifiers for debugging.
 */
export function sanitizeRecipient(recipient: string): string {
  if (!recipient) return recipient;
  // If it's a webhook URL with an embedded token (e.g. Discord webhook /api/webhooks/<id>/<token>)
  if (recipient.includes('/api/webhooks/')) {
    return recipient.replace(
      /(\/api\/webhooks\/[^/]+\/)([^/?#\s]+)/gi,
      `$1${REDACTED_PLACEHOLDER}`
    );
  }
  // If it's an email address, mask local-part
  if (recipient.includes('@') && !recipient.includes('://')) {
    const parts = recipient.split('@');
    const local = parts[0];
    const domain = parts.slice(1).join('@');
    const maskedLocal =
      local.length <= 2
        ? '***'
        : `${local.substring(0, 2)}***${local.substring(local.length - 1)}`;
    return `${maskedLocal}@${domain}`;
  }
  return recipient;
}

/**
 * Sanitizes a notification record, masking payload credentials and secret tokens.
 */
export function sanitizeNotificationRecord(
  record: Record<string, unknown>,
  includeSensitive: boolean = false
): Record<string, unknown> {
  if (includeSensitive) {
    return { ...record };
  }

  const sanitized = { ...record };

  // 1. Sanitize payload
  if (typeof sanitized.payload === 'string') {
    try {
      const parsed = JSON.parse(sanitized.payload);
      sanitized.payload = redactValue(parsed);
    } catch {
      sanitized.payload = REDACTED_PLACEHOLDER;
    }
  } else if (sanitized.payload && typeof sanitized.payload === 'object') {
    sanitized.payload = redactValue(sanitized.payload);
  }

  // 2. Sanitize metadata
  if (typeof sanitized.metadata === 'string') {
    try {
      const parsed = JSON.parse(sanitized.metadata);
      sanitized.metadata = redactValue(parsed);
    } catch {
      sanitized.metadata = REDACTED_PLACEHOLDER;
    }
  } else if (sanitized.metadata && typeof sanitized.metadata === 'object') {
    sanitized.metadata = redactValue(sanitized.metadata);
  }

  // 3. Sanitize targetRecipient
  if (typeof sanitized.target_recipient === 'string') {
    sanitized.target_recipient = sanitizeRecipient(sanitized.target_recipient);
  }

  return sanitized;
}

/**
 * Sanitizes an event record, masking any embedded auth tokens.
 */
export function sanitizeEventRecord(
  record: Record<string, unknown>,
  includeSensitive: boolean = false
): Record<string, unknown> {
  if (includeSensitive) {
    return { ...record };
  }

  return redactValue(record) as Record<string, unknown>;
}

export class DataExportService {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  /**
   * Export notification records matching the specified filters.
   */
  async exportNotifications(
    filters: NotificationExportFilter = {}
  ): Promise<Record<string, unknown>[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status.toUpperCase());
    }

    if (filters.notificationType) {
      conditions.push('notification_type = ?');
      params.push(filters.notificationType.toLowerCase());
    }

    if (filters.targetRecipient) {
      conditions.push('target_recipient LIKE ?');
      params.push(`%${filters.targetRecipient}%`);
    }

    if (filters.eventId) {
      conditions.push('event_id = ?');
      params.push(filters.eventId);
    }

    if (filters.contractAddress) {
      conditions.push('contract_address = ?');
      params.push(filters.contractAddress);
    }

    if (filters.priority !== undefined) {
      conditions.push('priority = ?');
      params.push(filters.priority);
    }

    if (filters.fromDate) {
      conditions.push('created_at >= ?');
      params.push(
        filters.fromDate instanceof Date
          ? filters.fromDate.toISOString()
          : new Date(filters.fromDate).toISOString()
      );
    }

    if (filters.toDate) {
      conditions.push('created_at <= ?');
      params.push(
        filters.toDate instanceof Date
          ? filters.toDate.toISOString()
          : new Date(filters.toDate).toISOString()
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 1000, 1), 10000);
    const offset = Math.max(filters.offset ?? 0, 0);

    const sql = `
      SELECT 
        id,
        payload,
        payload_hash,
        notification_type,
        target_recipient,
        execute_at,
        created_at,
        updated_at,
        status,
        retry_count,
        max_retries,
        processing_started_at,
        processing_completed_at,
        processor_id,
        last_error,
        event_id,
        contract_address,
        priority,
        metadata
      FROM scheduled_notifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    const rows = await this.db.all<Record<string, unknown>>(sql, params);

    const includeSensitive = filters.includeSensitive === true;
    return rows.map((row) => sanitizeNotificationRecord(row, includeSensitive));
  }

  /**
   * Export event records matching the specified filters.
   */
  async exportEvents(
    filters: EventExportFilter = {}
  ): Promise<Record<string, unknown>[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.eventType) {
      conditions.push('event_type = ?');
      params.push(filters.eventType);
    }

    if (filters.contractAddress) {
      conditions.push('contract_address = ?');
      params.push(filters.contractAddress);
    }

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status.toUpperCase());
    }

    if (filters.ledgerNumber !== undefined) {
      conditions.push('ledger_number = ?');
      params.push(filters.ledgerNumber);
    }

    if (filters.txHash) {
      conditions.push('tx_hash = ?');
      params.push(filters.txHash);
    }

    if (filters.fromDate) {
      conditions.push('processed_at >= ?');
      params.push(
        filters.fromDate instanceof Date
          ? filters.fromDate.toISOString()
          : new Date(filters.fromDate).toISOString()
      );
    }

    if (filters.toDate) {
      conditions.push('processed_at <= ?');
      params.push(
        filters.toDate instanceof Date
          ? filters.toDate.toISOString()
          : new Date(filters.toDate).toISOString()
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 1000, 1), 10000);
    const offset = Math.max(filters.offset ?? 0, 0);

    const sql = `
      SELECT 
        id,
        event_id,
        contract_address,
        fingerprint,
        ledger_number,
        tx_hash,
        event_type,
        processed_at,
        is_reorg_duplicate,
        reorg_detection_count,
        last_redetected_at,
        status,
        notification_sent,
        error_reason
      FROM processed_events
      ${whereClause}
      ORDER BY processed_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    const rows = await this.db.all<Record<string, unknown>>(sql, params);

    const includeSensitive = filters.includeSensitive === true;
    return rows.map((row) => sanitizeEventRecord(row, includeSensitive));
  }

  /**
   * Primary entry point for exporting data across notifications and events.
   */
  async exportData(options: DataExportOptions = {}): Promise<ExportResult> {
    const start = Date.now();
    const type = options.type || 'all';
    const format = options.format || 'json';
    const includeSensitive = options.includeSensitive === true;

    let notifications: Record<string, unknown>[] | undefined;
    let events: Record<string, unknown>[] | undefined;

    if (type === 'notifications' || type === 'all') {
      const nFilters = {
        ...options.notificationFilters,
        includeSensitive,
      };
      notifications = await this.exportNotifications(nFilters);
    }

    if (type === 'events' || type === 'all') {
      const eFilters = {
        ...options.eventFilters,
        includeSensitive,
      };
      events = await this.exportEvents(eFilters);
    }

    const metadata: ExportMetadata = {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      type,
      format,
      redacted: !includeSensitive,
      totalNotifications: notifications ? notifications.length : undefined,
      totalEvents: events ? events.length : undefined,
      filtersApplied: {
        ...(options.notificationFilters || {}),
        ...(options.eventFilters || {}),
      },
    };

    let csvContent: string | undefined;
    if (format === 'csv') {
      if (type === 'notifications' && notifications) {
        csvContent = this.formatNotificationsCsv(notifications);
      } else if (type === 'events' && events) {
        csvContent = this.formatEventsCsv(events);
      } else {
        // Combined CSV
        const nCsv = notifications ? this.formatNotificationsCsv(notifications) : '';
        const eCsv = events ? this.formatEventsCsv(events) : '';
        csvContent = `# NOTIFICATIONS\n${nCsv}\n\n# PROCESSED EVENTS\n${eCsv}`;
      }
    }

    logger.info('Data export completed', {
      type,
      format,
      totalNotifications: metadata.totalNotifications,
      totalEvents: metadata.totalEvents,
      durationMs: Date.now() - start,
      redacted: metadata.redacted,
    });

    return {
      metadata,
      notifications,
      events,
      csvContent,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Convert notification records to RFC 4180 compliant CSV.
   */
  private formatNotificationsCsv(records: Record<string, unknown>[]): string {
    const headers = [
      'id',
      'notification_type',
      'target_recipient',
      'status',
      'execute_at',
      'created_at',
      'updated_at',
      'retry_count',
      'max_retries',
      'priority',
      'event_id',
      'contract_address',
      'payload',
      'metadata',
      'last_error',
    ];

    const lines = [headers.join(',')];

    for (const record of records) {
      const row = headers.map((header) => {
        let val = record[header];
        if (val === null || val === undefined) {
          return '""';
        }
        if (typeof val === 'object') {
          val = JSON.stringify(val);
        }
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      });
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Convert event records to RFC 4180 compliant CSV.
   */
  private formatEventsCsv(records: Record<string, unknown>[]): string {
    const headers = [
      'id',
      'event_id',
      'contract_address',
      'ledger_number',
      'tx_hash',
      'event_type',
      'processed_at',
      'status',
      'notification_sent',
      'is_reorg_duplicate',
      'reorg_detection_count',
      'error_reason',
    ];

    const lines = [headers.join(',')];

    for (const record of records) {
      const row = headers.map((header) => {
        let val = record[header];
        if (val === null || val === undefined) {
          return '""';
        }
        if (typeof val === 'object') {
          val = JSON.stringify(val);
        }
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      });
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }
}
