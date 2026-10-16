/**
 * ArchiveStore
 *
 * Low-level data-access layer for the `notification_archive` table.
 * All write operations (insert / purge) are called exclusively by
 * ArchiveService; this file is the single source of truth for the
 * archive data schema.
 */
import { Database } from '../database/database';
import { buildPaginationMetadata, normalizePaginationParams } from '../utils/pagination';

/** Shape of one row in notification_archive. */
export interface ArchivedNotification {
  id: number;
  originalId: number;
  payload: string;
  notificationType: string;
  targetRecipient: string;
  executeAt: string;
  expiresAt: string | null;
  createdAt: string;
  processingCompletedAt: string | null;
  status: string;
  retryCount: number;
  lastError: string | null;
  eventId: string | null;
  contractAddress: string | null;
  metadata: string | null;
  archivedAt: string;
}

/** Raw SQLite row (snake_case). */
interface ArchiveRow {
  id: number;
  original_id: number;
  payload: string;
  notification_type: string;
  target_recipient: string;
  execute_at: string;
  expires_at: string | null;
  created_at: string;
  processing_completed_at: string | null;
  status: string;
  retry_count: number;
  last_error: string | null;
  event_id: string | null;
  contract_address: string | null;
  metadata: string | null;
  archived_at: string;
}

export interface ArchiveQueryOptions {
  limit?: number;
  offset?: number;
  status?: string;
  contractAddress?: string;
  startDate?: string;
  endDate?: string;
}

export interface PaginatedArchiveResponse {
  records: ArchivedNotification[];
  total: number;
  limit: number;
  offset: number;
  itemCount: number;
  totalPages: number;
}

function mapRow(row: ArchiveRow): ArchivedNotification {
  return {
    id: row.id,
    originalId: row.original_id,
    payload: row.payload,
    notificationType: row.notification_type,
    targetRecipient: row.target_recipient,
    executeAt: row.execute_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    processingCompletedAt: row.processing_completed_at,
    status: row.status,
    retryCount: row.retry_count,
    lastError: row.last_error,
    eventId: row.event_id,
    contractAddress: row.contract_address,
    metadata: row.metadata,
    archivedAt: row.archived_at,
  };
}

export class ArchiveStore {
  constructor(private readonly db: Database) {}

  /**
  * Insert a batch of terminal notifications into the
   * archive.  Returns the number of rows inserted.
   */
  async insertBatch(
    rows: Array<{
      originalId: number;
      payload: string;
      notificationType: string;
      targetRecipient: string;
      executeAt: string;
      expiresAt: string | null;
      createdAt: string;
      processingCompletedAt: string | null;
      status: string;
      retryCount: number;
      lastError: string | null;
      eventId: string | null;
      contractAddress: string | null;
      metadata: string | null;
    }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    let inserted = 0;
    for (const r of rows) {
      await this.db.run(
        `INSERT INTO notification_archive
           (original_id, payload, notification_type, target_recipient,
            execute_at, expires_at, created_at, processing_completed_at,
            status, retry_count, last_error, event_id, contract_address, metadata)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          r.originalId,
          r.payload,
          r.notificationType,
          r.targetRecipient,
          r.executeAt,
          r.expiresAt,
          r.createdAt,
          r.processingCompletedAt,
          r.status,
          r.retryCount,
          r.lastError,
          r.eventId,
          r.contractAddress,
          r.metadata,
        ],
      );
      inserted++;
    }
    return inserted;
  }

  /** Delete archive rows whose `archived_at` is older than `cutoff`. */
  async purgeOlderThan(cutoff: string): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM notification_archive WHERE archived_at < ?`,
      [cutoff],
    );
    return result.changes;
  }

  /** Paginated query for audit retrieval. */
  async query(options: ArchiveQueryOptions): Promise<PaginatedArchiveResponse> {
    const { limit, offset } = normalizePaginationParams(options.limit, options.offset);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.contractAddress) {
      conditions.push('contract_address = ?');
      params.push(options.contractAddress);
    }
    if (options.startDate) {
      conditions.push('archived_at >= ?');
      params.push(options.startDate);
    }
    if (options.endDate) {
      conditions.push('archived_at <= ?');
      params.push(options.endDate);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM notification_archive ${where}`,
      params,
    );
    const total = countRow?.count ?? 0;

    const rows = await this.db.all<ArchiveRow>(
      `SELECT * FROM notification_archive ${where}
       ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const pagination = buildPaginationMetadata(total, limit, offset);
    return {
      records: rows.map(mapRow),
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      itemCount: pagination.itemCount,
      totalPages: pagination.totalPages,
    };
  }

  /** Fetch a single archived record by its archive-table PK. */
  async getById(id: number): Promise<ArchivedNotification | null> {
    const row = await this.db.get<ArchiveRow>(
      `SELECT * FROM notification_archive WHERE id = ?`,
      [id],
    );
    return row ? mapRow(row) : null;
  }
}
