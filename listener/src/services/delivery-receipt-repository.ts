import { Database } from '../database/database';
import {
  CreateDeliveryReceiptInput,
  DeliveryReceipt,
  DeliveryReceiptRow,
  DeliveryReceiptStatus,
} from '../types/delivery-receipt';

const SAFE_RESPONSE_FIELDS = new Set([
  'status',
  'statusCode',
  'code',
  'messageId',
  'providerMessageId',
  'requestId',
  'retryAfter',
]);

function sanitizeProviderResponse(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const sanitized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_RESPONSE_FIELDS.has(key)) continue;
    if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
      sanitized[key] = field;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeErrorMessage(message: string | null): string | null {
  if (!message) return null;
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /\b(?:sk_(?:live|test)_|sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]+/gi,
      '[REDACTED_CREDENTIAL]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .slice(0, 500);
}

function sanitizeErrorCode(code: string | null): string | null {
  return code && /^[A-Z0-9_:-]{1,64}$/i.test(code) ? code : code ? 'DELIVERY_FAILED' : null;
}

export class DeliveryReceiptRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateDeliveryReceiptInput): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO delivery_receipts (
        notification_id, channel, status, attempt_count, provider_message_id,
        provider_response, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.notificationId,
        input.channel,
        input.status,
        input.attemptCount,
        input.providerMessageId,
        JSON.stringify(sanitizeProviderResponse(input.providerResponse)),
        sanitizeErrorCode(input.errorCode),
        sanitizeErrorMessage(input.errorMessage),
      ],
    );
    return result.lastID;
  }

  async findByNotificationId(
    notificationId: number,
    status?: DeliveryReceiptStatus,
  ): Promise<DeliveryReceipt[]> {
    const rows = status
      ? await this.db.all<DeliveryReceiptRow>(
          `SELECT * FROM delivery_receipts WHERE notification_id = ? AND status = ?
           ORDER BY attempt_count, id`,
          [notificationId, status],
        )
      : await this.db.all<DeliveryReceiptRow>(
          'SELECT * FROM delivery_receipts WHERE notification_id = ? ORDER BY attempt_count, id',
          [notificationId],
        );
    return rows.map(this.rowToModel);
  }

  async findByStatus(status: DeliveryReceiptStatus): Promise<DeliveryReceipt[]> {
    const rows = await this.db.all<DeliveryReceiptRow>(
      'SELECT * FROM delivery_receipts WHERE status = ? ORDER BY created_at, id',
      [status],
    );
    return rows.map(this.rowToModel);
  }

  private rowToModel(row: DeliveryReceiptRow): DeliveryReceipt {
    let providerResponse: Record<string, unknown> | null = null;
    if (row.provider_response) {
      try {
        providerResponse = JSON.parse(row.provider_response) as Record<string, unknown> | null;
      } catch {
        providerResponse = null;
      }
    }

    return {
      id: row.id,
      notificationId: row.notification_id,
      channel: row.channel,
      status: row.status,
      attemptCount: row.attempt_count,
      providerMessageId: row.provider_message_id,
      providerResponse,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export { sanitizeProviderResponse, sanitizeErrorCode, sanitizeErrorMessage };
