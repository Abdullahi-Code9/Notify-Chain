import logger from '../utils/logger';
import { NotificationAPI } from './notification-api';
import { VALID_CHANNELS } from '../utils/batch-validator';
import { NotificationType } from '../types/scheduled-notification';

export interface ImportRecord {
  id?: string;
  recipient?: string;
  destinationId?: string;
  channel?: string;
  message?: string;
  executeAt?: string;
  notificationType?: string;
  payload?: Record<string, unknown>;
  targetRecipient?: string;
  maxRetries?: number;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface ImportSkipDetail {
  index: number;
  reason: string;
  record?: unknown;
}

export interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  importedIds: number[];
  skippedRecords: ImportSkipDetail[];
  format: 'json' | 'csv';
  durationMs: number;
}

export interface ImportOptions {
  /** Default execute-at offset in ms from now when record omits executeAt (default 5 min). */
  defaultExecuteAtOffsetMs?: number;
  requestId?: string;
  /** Authenticated account owner used to validate any referenced destinationId. */
  ownerId?: string;
}

const CHANNEL_TO_TYPE: Record<string, NotificationType> = {
  discord: NotificationType.DISCORD,
  email: NotificationType.EMAIL,
  webhook: NotificationType.WEBHOOK,
  sms: NotificationType.SMS,
};

/**
 * Parses structured JSON or CSV notification files and imports valid rows.
 * Invalid records are skipped safely; a summary is always returned.
 */
export class NotificationImportService {
  constructor(private notificationAPI: NotificationAPI) {}

  async importFromBody(
    body: string | unknown,
    contentType?: string,
    options: ImportOptions = {}
  ): Promise<ImportSummary> {
    const start = Date.now();
    const format = this.detectFormat(body, contentType);
    const records =
      format === 'csv'
        ? this.parseCsv(typeof body === 'string' ? body : String(body))
        : this.parseJson(body);

    return this.importRecords(records, format, options, start);
  }

  async importRecords(
    records: ImportRecord[],
    format: 'json' | 'csv' = 'json',
    options: ImportOptions = {},
    startedAt = Date.now()
  ): Promise<ImportSummary> {
    const skippedRecords: ImportSkipDetail[] = [];
    const importedIds: number[] = [];
    const offsetMs = options.defaultExecuteAtOffsetMs ?? 5 * 60 * 1000;

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const validationError = this.validateImportRecord(record);
      if (validationError) {
        skippedRecords.push({ index, reason: validationError, record });
        continue;
      }

      try {
        const executeAt = record.executeAt
          ? new Date(record.executeAt)
          : new Date(Date.now() + offsetMs);

        if (isNaN(executeAt.getTime()) || executeAt <= new Date()) {
          skippedRecords.push({
            index,
            reason: 'executeAt must be a valid future timestamp',
            record,
          });
          continue;
        }

        const targetRecipient = record.targetRecipient || record.recipient || '';
        const channel = (record.channel || record.notificationType || 'discord').toLowerCase();
        const notificationType =
          CHANNEL_TO_TYPE[channel] ?? NotificationType.DISCORD;

        const payload =
          record.payload ??
          ({
            id: record.id,
            message: record.message,
            channel,
            recipient: targetRecipient,
          } as Record<string, unknown>);

        const id = await this.notificationAPI.scheduleNotification(
          {
            payload,
            notificationType,
            targetRecipient,
            executeAt,
            maxRetries: record.maxRetries,
            priority: record.priority,
            ...(record.destinationId ? { destinationId: record.destinationId } : {}),
            ...(options.ownerId ? { ownerId: options.ownerId } : {}),
            metadata: {
              ...record.metadata,
              importId: record.id,
              importedAt: new Date().toISOString(),
            },
          },
          options.requestId
        );

        importedIds.push(id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown import error';
        skippedRecords.push({ index, reason, record });
        logger.warn('Skipped notification during bulk import', {
          index,
          reason,
          requestId: options.requestId,
        });
      }
    }

    const summary: ImportSummary = {
      total: records.length,
      imported: importedIds.length,
      skipped: skippedRecords.length,
      importedIds,
      skippedRecords,
      format,
      durationMs: Date.now() - startedAt,
    };

    logger.info('Bulk notification import complete', {
      requestId: options.requestId,
      imported: summary.imported,
      skipped: summary.skipped,
      total: summary.total,
      format: summary.format,
    });

    return summary;
  }

  private detectFormat(body: string | unknown, contentType?: string): 'json' | 'csv' {
    if (contentType?.includes('text/csv') || contentType?.includes('application/csv')) {
      return 'csv';
    }
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        return 'json';
      }
      if (trimmed.includes(',') && /recipient/i.test(trimmed)) {
        return 'csv';
      }
    }
    return 'json';
  }

  private parseJson(body: string | unknown): ImportRecord[] {
    const data = typeof body === 'string' ? JSON.parse(body || 'null') : body;
    if (Array.isArray(data)) {
      return data as ImportRecord[];
    }
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray((data as { notifications?: unknown }).notifications)
    ) {
      return (data as { notifications: ImportRecord[] }).notifications;
    }
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray((data as { records?: unknown }).records)
    ) {
      return (data as { records: ImportRecord[] }).records;
    }
    throw new Error('JSON import body must be an array or { notifications: [] }');
  }

  private parseCsv(csv: string): ImportRecord[] {
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) {
      return [];
    }

    const headers = this.splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const records: ImportRecord[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = this.splitCsvLine(lines[i]);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = (cols[idx] ?? '').trim();
      });

      records.push({
        id: row.id || row.notification_id,
        recipient: row.recipient || row.targetrecipient || row.target_recipient,
        channel: row.channel || row.type || row.notificationtype,
        message: row.message || row.body || row.content,
        executeAt: row.executeat || row.execute_at || row.scheduled_at,
        notificationType: row.notificationtype || row.notification_type || row.type,
        targetRecipient: row.targetrecipient || row.target_recipient || row.recipient,
      });
    }

    return records;
  }

  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  private validateImportRecord(record: ImportRecord): string | null {
    const recipient = record.recipient || record.targetRecipient;
    if (!recipient && !record.destinationId) {
      return 'Missing required field: recipient';
    }
    const channel = (record.channel || record.notificationType || '').toLowerCase();
    if (!channel) {
      return 'Missing required field: channel';
    }
    if (!(VALID_CHANNELS as readonly string[]).includes(channel)) {
      return `Invalid channel: ${channel}`;
    }
    if (!record.message && !record.payload) {
      return 'Missing required field: message or payload';
    }
    return null;
  }
}
