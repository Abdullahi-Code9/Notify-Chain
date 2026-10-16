import { Database } from '../database/database';
import { loadConfig, validateConfig, ConfigError } from '../config';
import logger from '../utils/logger';
import { resetWorkerManager } from './worker-manager';
import { DatabaseCleanupJob } from './database-cleanup-job';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  parseLogFormat: jest.fn(() => 'pretty'),
  parseLogLevel: jest.fn(() => 'info'),
  SUPPORTED_LOG_FORMATS: ['json', 'pretty'],
  SUPPORTED_LOG_LEVELS: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_DATE = new Date(Date.now() - 40 * DAY_MS).toISOString();
const RECENT_DATE = new Date(Date.now() - DAY_MS).toISOString();

function cleanupConfig(
  overrides: Partial<{
    enabled: boolean;
    intervalMs: number;
    retentionDays: number;
    retentionOverridesMs: {
      processedEvents?: number;
      executionLogs?: number;
      rateLimitEvents?: number;
    };
  }> = {},
) {
  return {
    enabled: true,
    intervalMs: 60_000,
    retentionDays: 30,
    notificationRetentionMs: DAY_MS * 7,
    rateLimitEventRetentionMs: DAY_MS,
    eventRetentionMs: DAY_MS,
    processedEventRetentionMs: DAY_MS * 30,
    executionLogRetentionMs: DAY_MS * 90,
    ...overrides,
  };
}

describe('DatabaseCleanupJob', () => {
  let db: Database;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    resetWorkerManager();
    db = new Database(':memory:');
    await db.initialize();
  });

  afterEach(async () => {
    resetWorkerManager();
    await db.close();
    process.env = originalEnv;
    jest.useRealTimers();
  });

  async function addNotification(status: string): Promise<number> {
    const result = await db.run(
      `INSERT INTO scheduled_notifications (
        payload, notification_type, target_recipient, execute_at, status
      ) VALUES ('{}', 'discord', 'test-recipient', CURRENT_TIMESTAMP, ?)`,
      [status],
    );
    return result.lastID;
  }

  async function addProcessedEvent(eventId: string, processedAt: string): Promise<void> {
    await db.run(
      `INSERT INTO processed_events (
        event_id, contract_address, fingerprint, ledger_number, event_type, processed_at
      ) VALUES (?, 'CABC', ?, 1, 'contract', ?)`,
      [eventId, `fingerprint-${eventId}`, processedAt],
    );
  }

  async function addIdempotencyKey(
    id: string,
    notificationId: number,
    expiresAt: string,
    createdAt: string,
    status = 'PROCESSED',
  ): Promise<void> {
    await db.run(
      `INSERT INTO idempotency_keys (
        idempotency_key, request_hash, response_notification_id, response_data,
        created_at, expires_at, status
      ) VALUES (?, 'hash', ?, '{}', ?, ?, ?)`,
      [id, notificationId, createdAt, expiresAt, status],
    );
  }

  it('purges stale temporary records but preserves active rows and logs table counts', async () => {
    const pendingId = await addNotification('PENDING');
    const processingId = await addNotification('PROCESSING');
    const terminalId = await addNotification('FAILED');
    const secondTerminalId = await addNotification('FAILED');

    await addIdempotencyKey('expired-key', terminalId, OLD_DATE, OLD_DATE);
    await addIdempotencyKey(
      'future-key',
      terminalId,
      new Date(Date.now() + DAY_MS).toISOString(),
      OLD_DATE,
    );
    await addIdempotencyKey(
      'expired-status-key',
      terminalId,
      new Date(Date.now() + DAY_MS).toISOString(),
      OLD_DATE,
      'EXPIRED',
    );

    await addProcessedEvent('old-event', OLD_DATE);
    await addProcessedEvent('recent-event', RECENT_DATE);

    await db.run(
      `INSERT INTO dead_letter_queue (
        scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, created_at
      ) VALUES (?, 'discord', 'recipient', '{}', 'failed', ?)`,
      [terminalId, OLD_DATE],
    );
    await db.run(
      `INSERT INTO dead_letter_queue (
        scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, created_at
      ) VALUES (?, 'discord', 'recipient', '{}', 'failed', ?)`,
      [secondTerminalId, RECENT_DATE],
    );

    for (const [notificationId, executionTime] of [
      [pendingId, OLD_DATE],
      [processingId, OLD_DATE],
      [terminalId, OLD_DATE],
      [secondTerminalId, RECENT_DATE],
    ] as Array<[number, string]>) {
      await db.run(
        `INSERT INTO notification_execution_log (
          scheduled_notification_id, execution_attempt, execution_time, status
        ) VALUES (?, 1, ?, 'FAILED')`,
        [notificationId, executionTime],
      );
    }

    await db.run(
      `INSERT INTO rate_limit_events (
        client_id, client_type, endpoint, method, timestamp, limit_threshold, window_ms
      ) VALUES ('old', 'IP', '/', 'GET', ?, 10, 60000)`,
      [OLD_DATE],
    );
    await db.run(
      `INSERT INTO rate_limit_events (
        client_id, client_type, endpoint, method, timestamp, limit_threshold, window_ms
      ) VALUES ('recent', 'IP', '/', 'GET', ?, 10, 60000)`,
      [RECENT_DATE],
    );

    await db.run(
      `INSERT INTO backpressure_events (event_type, queue_size, target_throughput_per_sec, timestamp)
       VALUES ('ACTIVATED', 100, 10, ?)`,
      [OLD_DATE],
    );
    await db.run(
      `INSERT INTO backpressure_events (event_type, queue_size, target_throughput_per_sec, timestamp)
       VALUES ('DEACTIVATED', 0, 10, ?)`,
      [OLD_DATE],
    );
    await db.run(
      `INSERT INTO backpressure_events (event_type, queue_size, target_throughput_per_sec, timestamp)
       VALUES ('DEACTIVATED', 0, 10, ?)`,
      [RECENT_DATE],
    );

    const job = new DatabaseCleanupJob(db, cleanupConfig());
    const result = await job.runOnce();

    expect(
      await db.get('SELECT id FROM idempotency_keys WHERE idempotency_key = ?', ['expired-key']),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM idempotency_keys WHERE idempotency_key = ?', ['future-key']),
    ).toBeDefined();
    expect(
      await db.get('SELECT id FROM idempotency_keys WHERE idempotency_key = ?', [
        'expired-status-key',
      ]),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM processed_events WHERE event_id = ?', ['old-event']),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM processed_events WHERE event_id = ?', ['recent-event']),
    ).toBeDefined();
    expect(
      await db.get('SELECT id FROM dead_letter_queue WHERE scheduled_notification_id = ?', [
        terminalId,
      ]),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM dead_letter_queue WHERE scheduled_notification_id = ?', [
        secondTerminalId,
      ]),
    ).toBeDefined();

    const logRows = await db.all<{ scheduled_notification_id: number }>(
      'SELECT scheduled_notification_id FROM notification_execution_log ORDER BY scheduled_notification_id',
    );
    expect(logRows.map((row) => row.scheduled_notification_id)).toEqual([
      pendingId,
      processingId,
      secondTerminalId,
    ]);
    expect(
      await db.get('SELECT id FROM rate_limit_events WHERE client_id = ?', ['old']),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM rate_limit_events WHERE client_id = ?', ['recent']),
    ).toBeDefined();

    const backpressureRows = await db.all<{ event_type: string }>(
      'SELECT event_type FROM backpressure_events ORDER BY id',
    );
    expect(backpressureRows.map((row) => row.event_type)).toEqual(['ACTIVATED', 'DEACTIVATED']);
    expect(
      await db.get('SELECT status FROM scheduled_notifications WHERE id = ?', [pendingId]),
    ).toBeDefined();
    expect(
      await db.get('SELECT status FROM scheduled_notifications WHERE id = ?', [processingId]),
    ).toBeDefined();

    expect(result?.deletedCounts).toMatchObject({
      idempotency_keys: 2,
      processed_events: 1,
      dead_letter_queue: 1,
      notification_execution_log: 1,
      rate_limit_events: 1,
      backpressure_events: 1,
    });
    expect(result?.skippedTables.notification_archive).toContain('ArchiveService');
    expect(logger.info).toHaveBeenCalledWith(
      'Database cleanup run completed',
      expect.objectContaining({
        perTableDeleted: result?.deletedCounts,
        retentionDays: 30,
        intervalMs: 60_000,
      }),
    );
  });

  it('rejects cleanup configuration below the supported interval and retention', () => {
    process.env.CONTRACT_ADDRESSES = JSON.stringify([
      { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] },
    ]);
    process.env.CLEANUP_INTERVAL_MS = '59999';
    process.env.CLEANUP_RETENTION_DAYS = '0';

    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow(ConfigError);
    expect(() => validateConfig(config)).toThrow('CLEANUP_INTERVAL_MS must be >= 60000 ms');
    expect(() => validateConfig(config)).toThrow('CLEANUP_RETENTION_DAYS must be >= 1');
  });

  it('limits each delete transaction to 1000 rows', async () => {
    for (let index = 0; index < 1001; index += 1) {
      await addProcessedEvent(`batch-event-${index}`, OLD_DATE);
    }
    const runSpy = jest.spyOn(db, 'run');

    const result = await new DatabaseCleanupJob(db, cleanupConfig()).runOnce();

    const processedEventDeletes = runSpy.mock.calls.filter(([sql]) =>
      sql.includes('DELETE FROM processed_events'),
    );
    expect(result?.deletedCounts.processed_events).toBe(1001);
    expect(processedEventDeletes).toHaveLength(2);
    expect(processedEventDeletes.every(([, params]) => params?.[params.length - 1] === 1000)).toBe(
      true,
    );
  });

  it('continues with other tables when one table purge fails', async () => {
    await addProcessedEvent('event-survives-other-table-failure', OLD_DATE);
    const terminalId = await addNotification('FAILED');
    await db.run(
      `INSERT INTO dead_letter_queue (
        scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, created_at
      ) VALUES (?, 'discord', 'recipient', '{}', 'failed', ?)`,
      [terminalId, OLD_DATE],
    );
    const originalRun = db.run.bind(db);
    jest.spyOn(db, 'run').mockImplementation((sql, params = []) => {
      if (sql.includes('DELETE FROM dead_letter_queue')) {
        return Promise.reject(new Error('injected table failure'));
      }
      return originalRun(sql, params);
    });

    const result = await new DatabaseCleanupJob(db, cleanupConfig()).runOnce();

    expect(result?.failedTables).toContain('dead_letter_queue');
    expect(result?.deletedCounts.processed_events).toBe(1);
    expect(
      await db.get('SELECT id FROM processed_events WHERE event_id = ?', [
        'event-survives-other-table-failure',
      ]),
    ).toBeUndefined();
    expect(
      await db.get('SELECT id FROM dead_letter_queue WHERE scheduled_notification_id = ?', [
        terminalId,
      ]),
    ).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Database cleanup table failed',
      expect.objectContaining({ table: 'dead_letter_queue' }),
    );
  });

  it('rejects invalid cleanup enabled values', () => {
    process.env.CLEANUP_ENABLED = 'yes';
    expect(() => loadConfig()).toThrow('CLEANUP_ENABLED must be either "true" or "false"');
  });

  it('defaults cleanup to enabled and honors explicit disablement', () => {
    process.env.CONTRACT_ADDRESSES = JSON.stringify([
      { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] },
    ]);
    delete process.env.CLEANUP_ENABLED;
    delete process.env.CLEANUP_INTERVAL_MS;
    delete process.env.CLEANUP_RETENTION_DAYS;

    expect(loadConfig().cleanup).toMatchObject({
      enabled: true,
      intervalMs: 3_600_000,
      retentionDays: 30,
    });

    process.env.CLEANUP_ENABLED = 'false';
    expect(loadConfig().cleanup?.enabled).toBe(false);
  });

  it('stops the interval and waits for its active cleanup run', async () => {
    jest.useFakeTimers();
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const job = new DatabaseCleanupJob(db, cleanupConfig());
    job.start();
    const jobTimer = intervalSpy.mock.results[0].value;
    await job.stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(jobTimer);
    intervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
