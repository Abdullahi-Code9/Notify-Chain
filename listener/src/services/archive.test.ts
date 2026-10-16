/**
 * Tests for the notification archiving feature:
 *   - loadArchiveConfig        (config loading from env vars)
 *   - ArchiveStore             (data-access layer)
 *   - ArchiveService           (archive + purge cycle)
 *   - handleArchiveRequest     (HTTP API handler)
 */

import { loadArchiveConfig } from '../services/archive-config';
import { ArchiveStore } from '../services/archive-store';
import { ArchiveService } from '../services/archive-service';
import { handleArchiveRequest } from '../api/archive-api';

// ---------------------------------------------------------------------------
// Minimal in-memory Database stub
// ---------------------------------------------------------------------------

interface RunResult { lastID: number; changes: number }

class MemoryDb {
  private tables: Record<string, Record<string, unknown>[]> = {
    scheduled_notifications: [],
    notification_archive: [],
  };
  private nextId = 1;

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const s = sql.trim().toUpperCase();

    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { lastID: 0, changes: 0 };
    }

    if (s.startsWith('INSERT INTO NOTIFICATION_ARCHIVE')) {
      const row: Record<string, unknown> = {
        id: this.nextId++,
        original_id: params[0],
        payload: params[1],
        notification_type: params[2],
        target_recipient: params[3],
        execute_at: params[4],
        created_at: params[5],
        processing_completed_at: params[6],
        status: params[7],
        retry_count: params[8],
        last_error: params[9],
        event_id: params[10],
        contract_address: params[11],
        metadata: params[12],
        archived_at: new Date().toISOString(),
      };
      this.tables.notification_archive.push(row);
      return { lastID: row.id as number, changes: 1 };
    }

    if (s.startsWith('DELETE FROM SCHEDULED_NOTIFICATIONS WHERE ID IN')) {
      const before = this.tables.scheduled_notifications.length;
      this.tables.scheduled_notifications = this.tables.scheduled_notifications.filter(
        (r) => !params.includes((r as any).id),
      );
      return { lastID: 0, changes: before - this.tables.scheduled_notifications.length };
    }

    if (s.startsWith('DELETE FROM SCHEDULED_NOTIFICATIONS WHERE ID =')) {
      const id = params[0] as number;
      const before = this.tables.scheduled_notifications.length;
      this.tables.scheduled_notifications = this.tables.scheduled_notifications.filter(
        (r) => (r as any).id !== id,
      );
      return { lastID: 0, changes: before - this.tables.scheduled_notifications.length };
    }

    if (s.startsWith('DELETE FROM NOTIFICATION_ARCHIVE WHERE ARCHIVED_AT <')) {
      const cutoff = params[0] as string;
      const before = this.tables.notification_archive.length;
      this.tables.notification_archive = this.tables.notification_archive.filter(
        (r) => (r as any).archived_at >= cutoff,
      );
      return { lastID: 0, changes: before - this.tables.notification_archive.length };
    }

    return { lastID: 0, changes: 0 };
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const s = sql.trim().toUpperCase();

    if (s.includes('COUNT(*) AS COUNT FROM NOTIFICATION_ARCHIVE')) {
      return { count: this.tables.notification_archive.length } as unknown as T;
    }
    if (s.includes('* FROM NOTIFICATION_ARCHIVE WHERE ID =')) {
      const id = params[0] as number;
      const row = this.tables.notification_archive.find((r) => (r as any).id === id);
      return row as unknown as T | undefined;
    }
    if (s.includes('FROM SCHEDULED_NOTIFICATIONS') && s.includes('WHERE ID =')) {
      const id = params[0] as number;
      const row = this.tables.scheduled_notifications.find((r) => {
        const rec = r as any;
        return (
          rec.id === id &&
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(rec.status)
        );
      });
      return row as unknown as T | undefined;
    }
    return undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.trim().toUpperCase();

    if (s.includes('FROM SCHEDULED_NOTIFICATIONS')) {
      const cutoff = params[0] as string;
      const limit = params[1] as number;
      const rows = this.tables.scheduled_notifications.filter(
        (r) => {
          const row = r as any;
          return (
            ['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status) &&
            row.processing_completed_at != null &&
            row.processing_completed_at < cutoff
          );
        },
      ).slice(0, limit);
      return rows as unknown as T[];
    }

    if (s.includes('FROM NOTIFICATION_ARCHIVE')) {
      return this.tables.notification_archive as unknown as T[];
    }

    return [];
  }

  async exec(_sql: string): Promise<void> { /* no-op for schema ddl */ }

  async transaction(cb: () => Promise<void>): Promise<void> { await cb(); }

  // Test helpers
  seedScheduledNotification(overrides: Partial<Record<string, unknown>> = {}): void {
    this.tables.scheduled_notifications.push({
      id: this.nextId++,
      payload: '{}',
      notification_type: 'discord',
      target_recipient: 'test-user',
      execute_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      processing_completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'COMPLETED',
      retry_count: 0,
      last_error: null,
      event_id: null,
      contract_address: null,
      metadata: null,
      ...overrides,
    });
  }

  archiveCount(): number {
    return this.tables.notification_archive.length;
  }

  scheduledCount(): number {
    return this.tables.scheduled_notifications.length;
  }
}

// ---------------------------------------------------------------------------
// 1. loadArchiveConfig
// ---------------------------------------------------------------------------

describe('loadArchiveConfig', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => { Object.assign(process.env, ORIGINAL); });

  it('returns defaults when no env vars are set', () => {
    delete process.env.ARCHIVE_ENABLED;
    delete process.env.ARCHIVE_INTERVAL_MS;
    delete process.env.ARCHIVE_AFTER_MS;
    delete process.env.ARCHIVE_DELETE_AFTER_MS;
    delete process.env.ARCHIVE_BATCH_SIZE;

    const cfg = loadArchiveConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(cfg.archiveAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cfg.deleteAfterMs).toBe(90 * 24 * 60 * 60 * 1000);
    expect(cfg.batchSize).toBe(500);
  });

  it('respects ARCHIVE_ENABLED=false', () => {
    process.env.ARCHIVE_ENABLED = 'false';
    expect(loadArchiveConfig().enabled).toBe(false);
  });

  it('parses custom integer env vars', () => {
    process.env.ARCHIVE_INTERVAL_MS = '3600000';
    process.env.ARCHIVE_AFTER_MS = '86400000';
    process.env.ARCHIVE_DELETE_AFTER_MS = '0';
    process.env.ARCHIVE_BATCH_SIZE = '100';

    const cfg = loadArchiveConfig();
    expect(cfg.intervalMs).toBe(3_600_000);
    expect(cfg.archiveAfterMs).toBe(86_400_000);
    expect(cfg.deleteAfterMs).toBe(0);
    expect(cfg.batchSize).toBe(100);
  });

  it('falls back to default for invalid integer', () => {
    process.env.ARCHIVE_BATCH_SIZE = 'not-a-number';
    expect(loadArchiveConfig().batchSize).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 2. ArchiveStore
// ---------------------------------------------------------------------------

describe('ArchiveStore', () => {
  let db: MemoryDb;
  let store: ArchiveStore;

  beforeEach(() => {
    db = new MemoryDb();
    store = new ArchiveStore(db as any);
  });

  it('insertBatch returns 0 for empty input', async () => {
    const n = await store.insertBatch([]);
    expect(n).toBe(0);
  });

  it('insertBatch inserts all rows', async () => {
    const n = await store.insertBatch([
      {
        originalId: 1,
        payload: '{}',
        notificationType: 'discord',
        targetRecipient: 'u1',
        executeAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        processingCompletedAt: '2024-01-02T00:00:00.000Z',
        status: 'COMPLETED',
        retryCount: 0,
        lastError: null,
        eventId: null,
        contractAddress: null,
        metadata: null,
      },
      {
        originalId: 2,
        payload: '{"key":"val"}',
        notificationType: 'email',
        targetRecipient: 'u2',
        executeAt: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        processingCompletedAt: null,
        status: 'FAILED',
        retryCount: 3,
        lastError: 'timeout',
        eventId: 'evt-1',
        contractAddress: 'CABC',
        metadata: null,
      },
    ]);
    expect(n).toBe(2);
    expect(db.archiveCount()).toBe(2);
  });

  it('purgeOlderThan removes rows before cutoff', async () => {
    // Seed archive with one old row (override archived_at via direct table access)
    const internalDb = db as any;
    internalDb.tables.notification_archive.push({
      id: 99,
      original_id: 10,
      archived_at: '2020-01-01T00:00:00.000Z',
    });

    const purged = await store.purgeOlderThan('2021-01-01T00:00:00.000Z');
    expect(purged).toBe(1);
    expect(db.archiveCount()).toBe(0);
  });

  it('getById returns null for missing id', async () => {
    const result = await store.getById(9999);
    expect(result).toBeNull();
  });

  it('query returns paginated results', async () => {
    // Seed a couple of archive rows
    for (let i = 1; i <= 3; i++) {
      (db as any).tables.notification_archive.push({
        id: i,
        original_id: i,
        payload: '{}',
        notification_type: 'discord',
        target_recipient: 'u',
        execute_at: '',
        created_at: '',
        processing_completed_at: null,
        status: 'COMPLETED',
        retry_count: 0,
        last_error: null,
        event_id: null,
        contract_address: null,
        metadata: null,
        archived_at: new Date().toISOString(),
      });
    }
    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.records).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. ArchiveService
// ---------------------------------------------------------------------------

describe('ArchiveService', () => {
  let db: MemoryDb;
  let service: ArchiveService;

  const cfg = {
    enabled: true,
    intervalMs: 60_000,
    archiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    deleteAfterMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    batchSize: 500,
  };

  beforeEach(() => {
    db = new MemoryDb();
    service = new ArchiveService(db as any, cfg);
  });

  it('archives old completed notifications', async () => {
    db.seedScheduledNotification({ status: 'COMPLETED' });
    db.seedScheduledNotification({ status: 'FAILED' });
    expect(db.scheduledCount()).toBe(2);

    const result = await service.runCycle();

    expect(result.archived).toBe(2);
    expect(db.scheduledCount()).toBe(0);
    expect(db.archiveCount()).toBe(2);
  });

  it('archives a processed notification immediately by id', async () => {
    db.seedScheduledNotification({
      id: 42,
      status: 'COMPLETED',
      processing_completed_at: new Date().toISOString(),
    });
    // Reset nextId after explicit id seed — seed already pushed with id 42
    expect(db.scheduledCount()).toBe(1);

    const ok = await service.archiveProcessedById(42);
    expect(ok).toBe(true);
    expect(db.scheduledCount()).toBe(0);
    expect(db.archiveCount()).toBe(1);

    const missing = await service.archiveProcessedById(999);
    expect(missing).toBe(false);
  });

  it('does not archive PENDING notifications', async () => {
    db.seedScheduledNotification({ status: 'PENDING', processing_completed_at: null });
    const result = await service.runCycle();
    expect(result.archived).toBe(0);
    expect(db.scheduledCount()).toBe(1);
  });

  it('does not archive recently completed notifications', async () => {
    // Completed only 1 day ago — below the 7-day threshold
    db.seedScheduledNotification({
      status: 'COMPLETED',
      processing_completed_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await service.runCycle();
    expect(result.archived).toBe(0);
  });

  it('purges archive rows by age regardless of status', async () => {
    const oldArchivedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    (db as any).tables.notification_archive.push(
      { id: 1, original_id: 100, status: 'COMPLETED', archived_at: oldArchivedAt },
      { id: 2, original_id: 101, status: 'EXPIRED', archived_at: oldArchivedAt },
      {
        id: 3,
        original_id: 102,
        status: 'FAILED',
        archived_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      },
    );
    const result = await service.runCycle();
    expect(result.purged).toBe(2);
    expect(db.archiveCount()).toBe(1);
  });

  it('skips purge when deleteAfterMs is 0', async () => {
    const noPurgeSvc = new ArchiveService(db as any, { ...cfg, deleteAfterMs: 0 });
    (db as any).tables.notification_archive.push({
      id: 1,
      original_id: 100,
      archived_at: new Date(0).toISOString(),
    });
    const result = await noPurgeSvc.runCycle();
    expect(result.purged).toBe(0);
    expect(db.archiveCount()).toBe(1);
  });

  it('start/stop manages the interval without throwing', () => {
    jest.useFakeTimers();
    service.start();
    service.stop();
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 4. handleArchiveRequest (HTTP handler)
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { this._status = status; },
    end(body: string) { this._body = body; },
  };
  return res;
}

function makeReq(method: string, url: string) {
  return { method, url } as any;
}

describe('handleArchiveRequest', () => {
  let db: MemoryDb;
  let store: ArchiveStore;

  beforeEach(() => {
    db = new MemoryDb();
    store = new ArchiveStore(db as any);
  });

  it('returns false for non-archive routes', async () => {
    const req = makeReq('GET', '/api/events');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store }, 'req-1');
    expect(handled).toBe(false);
  });

  it('GET /api/archive returns paginated results', async () => {
    const req = makeReq('GET', '/api/archive');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store }, 'req-2');
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('records');
    expect(body).toHaveProperty('total');
  });

  it('GET /api/archive/:id returns 404 for unknown id', async () => {
    const req = makeReq('GET', '/api/archive/999');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store }, 'req-3');
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
  });

  it('GET /api/archive/:id returns the record when it exists', async () => {
    // Plant a row in the in-memory archive table
    (db as any).tables.notification_archive.push({
      id: 42,
      original_id: 1,
      payload: '{}',
      notification_type: 'discord',
      target_recipient: 'u',
      execute_at: '',
      created_at: '',
      processing_completed_at: null,
      status: 'COMPLETED',
      retry_count: 0,
      last_error: null,
      event_id: null,
      contract_address: null,
      metadata: null,
      archived_at: new Date().toISOString(),
    });
    const req = makeReq('GET', '/api/archive/42');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store }, 'req-4');
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).id).toBe(42);
  });

  it('POST /api/archive/run returns 503 when service not provided', async () => {
    const req = makeReq('POST', '/api/archive/run');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store, service: null }, 'req-5');
    expect(handled).toBe(true);
    expect(res._status).toBe(503);
  });

  it('POST /api/archive/run triggers cycle when service is provided', async () => {
    const fakeService = {
      runCycle: jest.fn().mockResolvedValue({ archived: 1, purged: 0, durationMs: 5 }),
    } as any;
    const req = makeReq('POST', '/api/archive/run');
    const res = makeRes();
    const handled = await handleArchiveRequest(req, res as any, { store, service: fakeService }, 'req-6');
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(fakeService.runCycle).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res._body);
    expect(body.archived).toBe(1);
  });
});
