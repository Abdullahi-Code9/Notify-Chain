import * as sqlite3 from 'sqlite3';

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function getCount(db: sqlite3.Database, sql: string): Promise<number> {
  return new Promise((resolve, reject) => {
    db.get(sql, (error, row: { count: number }) => {
      if (error) reject(error);
      else resolve(row.count);
    });
  });
}

function getRows(db: sqlite3.Database, sql: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

async function hasColumn(db: sqlite3.Database, table: string, column: string): Promise<boolean> {
  const rows = await new Promise<Array<{ name: string }>>((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (error, result) =>
      error ? reject(error) : resolve(result as Array<{ name: string }>),
    );
  });
  return rows.some((row) => row.name === column);
}

async function auditLegacyRows(db: sqlite3.Database): Promise<void> {
  const audits = [
    {
      table: 'scheduled_notifications',
      sql: `SELECT COUNT(*) AS count FROM scheduled_notifications
        WHERE payload IS NULL OR notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
          OR target_recipient IS NULL OR execute_at IS NULL
          OR status NOT IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DEAD_LETTERED')
          OR retry_count < 0 OR max_retries < 0 OR priority NOT BETWEEN 1 AND 10`,
    },
    {
      table: 'notification_execution_log',
      sql: `SELECT COUNT(*) AS count FROM notification_execution_log l
        WHERE l.scheduled_notification_id IS NULL OR l.execution_attempt <= 0
          OR l.execution_time IS NULL OR l.status NOT IN ('SUCCESS', 'FAILED', 'RETRY')
          OR (l.duration_ms IS NOT NULL AND l.duration_ms < 0)
          OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = l.scheduled_notification_id)`,
    },
    {
      table: 'dead_letter_queue',
      sql: `SELECT COUNT(*) AS count FROM dead_letter_queue d
        WHERE d.scheduled_notification_id IS NULL
          OR d.notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
          OR d.target_recipient IS NULL OR d.payload IS NULL OR d.failure_reason IS NULL
          OR d.retry_count < 0
          OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = d.scheduled_notification_id)`,
    },
    {
      table: 'dead_letter_queue (duplicate notification references)',
      sql: `SELECT COUNT(*) AS count FROM (
        SELECT scheduled_notification_id FROM dead_letter_queue
        GROUP BY scheduled_notification_id HAVING COUNT(*) > 1
      )`,
    },
    {
      table: 'idempotency_keys',
      sql: `SELECT COUNT(*) AS count FROM idempotency_keys k
        WHERE k.idempotency_key IS NULL OR k.request_hash IS NULL
          OR k.response_notification_id IS NULL OR k.response_data IS NULL
          OR k.expires_at IS NULL OR k.status NOT IN ('PROCESSED', 'EXPIRED')
          OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = k.response_notification_id)`,
    },
    {
      table: 'notification_archive',
      sql: `SELECT COUNT(*) AS count FROM notification_archive
        WHERE original_id IS NULL OR payload IS NULL
          OR notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
          OR target_recipient IS NULL OR execute_at IS NULL OR created_at IS NULL
          OR status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DEAD_LETTERED')
          OR retry_count < 0 OR archived_at IS NULL`,
    },
  ];

  if (await hasColumn(db, 'scheduled_notifications', 'expires_at')) {
    audits[0].sql = `${audits[0].sql}
      OR (expires_at IS NOT NULL AND datetime(expires_at) IS NULL)`;
  }
  if (await hasColumn(db, 'notification_archive', 'expires_at')) {
    audits[5].sql = `${audits[5].sql}
      OR (expires_at IS NOT NULL AND datetime(expires_at) IS NULL)`;
  }

  const violations: string[] = [];
  for (const audit of audits) {
    const count = await getCount(db, audit.sql);
    if (count > 0) violations.push(`${audit.table}: ${count} row(s)`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Migration 005 aborted before rebuilding tables. Repair invalid legacy data first: ${violations.join('; ')}`,
    );
  }
}

const migration = {
  id: '005',
  name: 'notification-expiration',
  up: async (db: sqlite3.Database) => {
    await auditLegacyRows(db);

    const notificationExpiresAt = (await hasColumn(db, 'scheduled_notifications', 'expires_at'))
      ? 'expires_at'
      : 'NULL';
    const archiveExpiresAt = (await hasColumn(db, 'notification_archive', 'expires_at'))
      ? 'expires_at'
      : 'NULL';

    await run(
      db,
      `CREATE TABLE scheduled_notifications_v005 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        payload_hash TEXT,
        notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
        target_recipient TEXT NOT NULL,
        execute_at DATETIME NOT NULL,
        expires_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED', 'EXPIRED')),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
        processing_started_at DATETIME,
        processing_completed_at DATETIME,
        processor_id VARCHAR(100),
        lock_expires_at DATETIME,
        last_error TEXT,
        error_details TEXT,
        event_id TEXT,
        contract_address TEXT,
        priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
        metadata TEXT,
        next_retry_at DATETIME,
        deduplication_key TEXT
      )`,
    );
    await run(
      db,
      `INSERT INTO scheduled_notifications_v005 (
        id, payload, payload_hash, notification_type, target_recipient, execute_at, expires_at,
        created_at, updated_at, status, retry_count, max_retries, processing_started_at,
        processing_completed_at, processor_id, lock_expires_at, last_error, error_details,
        event_id, contract_address, priority, metadata, next_retry_at, deduplication_key
      ) SELECT id, payload, payload_hash, notification_type, target_recipient, execute_at,
        ${notificationExpiresAt}, created_at, updated_at, status, retry_count, max_retries,
        processing_started_at, processing_completed_at, processor_id, lock_expires_at,
        last_error, error_details, event_id, contract_address, priority, metadata, next_retry_at,
        deduplication_key
      FROM scheduled_notifications`,
    );

    await run(
      db,
      `CREATE TABLE notification_execution_log_v005 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_notification_id INTEGER NOT NULL,
        execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
        execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRY')),
        error_message TEXT,
        response_data TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications_v005(id) ON DELETE CASCADE
      )`,
    );
    await run(
      db,
      'INSERT INTO notification_execution_log_v005 SELECT * FROM notification_execution_log',
    );

    await run(
      db,
      `CREATE TABLE dead_letter_queue_v005 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_notification_id INTEGER NOT NULL UNIQUE,
        notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
        target_recipient TEXT NOT NULL,
        payload TEXT NOT NULL,
        failure_reason TEXT NOT NULL,
        error_details TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_retried_at DATETIME,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications_v005(id) ON DELETE CASCADE
      )`,
    );
    await run(db, 'INSERT INTO dead_letter_queue_v005 SELECT * FROM dead_letter_queue');

    await run(
      db,
      `CREATE TABLE idempotency_keys_v005 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        response_notification_id INTEGER NOT NULL,
        response_data TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'EXPIRED')),
        FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications_v005(id) ON DELETE CASCADE
      )`,
    );
    await run(db, 'INSERT INTO idempotency_keys_v005 SELECT * FROM idempotency_keys');

    await run(
      db,
      `CREATE TABLE notification_archive_v005 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
        target_recipient TEXT NOT NULL,
        execute_at DATETIME NOT NULL,
        expires_at DATETIME,
        created_at DATETIME NOT NULL,
        processing_completed_at DATETIME,
        status VARCHAR(20) NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DEAD_LETTERED')),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        last_error TEXT,
        event_id TEXT,
        contract_address TEXT,
        metadata TEXT,
        archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    await run(
      db,
      `INSERT INTO notification_archive_v005 (
        id, original_id, payload, notification_type, target_recipient, execute_at, expires_at,
        created_at, processing_completed_at, status, retry_count, last_error, event_id,
        contract_address, metadata, archived_at
      ) SELECT id, original_id, payload, notification_type, target_recipient, execute_at,
        ${archiveExpiresAt}, created_at, processing_completed_at, status, retry_count,
        last_error, event_id, contract_address, metadata, archived_at
      FROM notification_archive`,
    );

    for (const table of [
      'notification_execution_log',
      'dead_letter_queue',
      'idempotency_keys',
      'notification_archive',
      'scheduled_notifications',
    ]) {
      await run(db, `DROP TABLE ${table}`);
    }

    await run(db, 'ALTER TABLE scheduled_notifications_v005 RENAME TO scheduled_notifications');
    await run(
      db,
      'ALTER TABLE notification_execution_log_v005 RENAME TO notification_execution_log',
    );
    await run(db, 'ALTER TABLE dead_letter_queue_v005 RENAME TO dead_letter_queue');
    await run(db, 'ALTER TABLE idempotency_keys_v005 RENAME TO idempotency_keys');
    await run(db, 'ALTER TABLE notification_archive_v005 RENAME TO notification_archive');

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status ON scheduled_notifications(status)',
      "CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_execute_at ON scheduled_notifications(status, execute_at) WHERE status = 'PENDING'",
      "CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_lock_expires ON scheduled_notifications(lock_expires_at, status) WHERE status = 'PROCESSING'",
      "CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_next_retry_at ON scheduled_notifications(next_retry_at, status) WHERE status = 'PENDING'",
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_created_at ON scheduled_notifications(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_event_id ON scheduled_notifications(event_id) WHERE event_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_target ON scheduled_notifications(target_recipient, status)',
      "CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_claim ON scheduled_notifications(status, priority, execute_at) WHERE status = 'PENDING'",
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_processor_lock ON scheduled_notifications(processor_id, status, lock_expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_created ON scheduled_notifications(status, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_type_status ON scheduled_notifications(notification_type, status)',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_contract ON scheduled_notifications(contract_address) WHERE contract_address IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_execution_log_notification_id ON notification_execution_log(scheduled_notification_id)',
      'CREATE INDEX IF NOT EXISTS idx_execution_log_execution_time ON notification_execution_log(execution_time)',
      'CREATE INDEX IF NOT EXISTS idx_execution_log_status_execution_time ON notification_execution_log(status, execution_time)',
      'CREATE INDEX IF NOT EXISTS idx_execution_log_notification_attempt ON notification_execution_log(scheduled_notification_id, execution_attempt)',
      'CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at ON dead_letter_queue(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_notification_type ON dead_letter_queue(notification_type)',
      'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(idempotency_key)',
      'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_archive_original_id ON notification_archive(original_id)',
      'CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON notification_archive(archived_at)',
      'CREATE INDEX IF NOT EXISTS idx_archive_status ON notification_archive(status)',
      'CREATE INDEX IF NOT EXISTS idx_archive_contract_address ON notification_archive(contract_address) WHERE contract_address IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_archive_event_id ON notification_archive(event_id) WHERE event_id IS NOT NULL',
    ];
    for (const index of indexes) await run(db, index);

    await run(
      db,
      `CREATE TRIGGER IF NOT EXISTS update_scheduled_notifications_timestamp
       AFTER UPDATE ON scheduled_notifications
       FOR EACH ROW BEGIN
         UPDATE scheduled_notifications SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
       END`,
    );

    const foreignKeyViolations = await getRows(db, 'PRAGMA foreign_key_check');
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Migration 005 detected ${foreignKeyViolations.length} foreign-key violation(s) after rebuilding tables`,
      );
    }
  },
  down: async () => {
    throw new Error(
      'Migration 005 cannot be safely rolled back; restore a database backup instead',
    );
  },
};

export default migration;
