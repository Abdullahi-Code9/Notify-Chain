import * as sqlite3 from 'sqlite3';

const tables = [
  {
    name: 'scheduled_notifications',
    create: `CREATE TABLE scheduled_notifications_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      payload_hash TEXT,
      notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
      target_recipient TEXT NOT NULL,
      execute_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')),
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
  },
  {
    name: 'notification_execution_log',
    create: `CREATE TABLE notification_execution_log_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_notification_id INTEGER NOT NULL,
      execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
      execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRY')),
      error_message TEXT,
      response_data TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications_v004(id) ON DELETE CASCADE
    )`,
  },
  {
    name: 'dead_letter_queue',
    create: `CREATE TABLE dead_letter_queue_v004 (
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
      FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications_v004(id) ON DELETE CASCADE
    )`,
  },
  {
    name: 'processed_events',
    create: `CREATE TABLE processed_events_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      ledger_number INTEGER NOT NULL CHECK (ledger_number >= 0),
      tx_hash TEXT,
      event_type VARCHAR(50) NOT NULL,
      processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_reorg_duplicate BOOLEAN NOT NULL DEFAULT 0 CHECK (is_reorg_duplicate IN (0, 1)),
      reorg_detection_count INTEGER NOT NULL DEFAULT 0 CHECK (reorg_detection_count >= 0),
      last_redetected_at DATETIME,
      status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'SKIPPED', 'ERROR')),
      notification_sent BOOLEAN NOT NULL DEFAULT 0 CHECK (notification_sent IN (0, 1)),
      error_reason TEXT
    )`,
  },
  {
    name: 'polling_cursors',
    create: `CREATE TABLE polling_cursors_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT NOT NULL UNIQUE,
      cursor TEXT NOT NULL,
      ledger_number INTEGER NOT NULL CHECK (ledger_number >= 0),
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reorg_detected BOOLEAN NOT NULL DEFAULT 0 CHECK (reorg_detected IN (0, 1)),
      reorg_detection_count INTEGER NOT NULL DEFAULT 0 CHECK (reorg_detection_count >= 0)
    )`,
  },
  {
    name: 'idempotency_keys',
    create: `CREATE TABLE idempotency_keys_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      response_notification_id INTEGER NOT NULL,
      response_data TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'EXPIRED')),
      FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications_v004(id) ON DELETE CASCADE
    )`,
  },
  {
    name: 'rate_limit_events',
    create: `CREATE TABLE rate_limit_events_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      client_type VARCHAR(20) NOT NULL CHECK (client_type IN ('IP', 'API_KEY')),
      endpoint TEXT NOT NULL,
      method VARCHAR(10) NOT NULL,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      limit_threshold INTEGER NOT NULL CHECK (limit_threshold >= 0),
      window_ms INTEGER NOT NULL CHECK (window_ms >= 0)
    )`,
  },
  {
    name: 'notification_template_audit_log',
    create: `CREATE TABLE notification_template_audit_log_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'UPDATE' CHECK (action IN ('UPDATE')),
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      previous_snapshot TEXT NOT NULL,
      new_snapshot TEXT NOT NULL,
      FOREIGN KEY (template_id) REFERENCES notification_templates(id) ON DELETE RESTRICT
    )`,
  },
  {
    name: 'backpressure_events',
    create: `CREATE TABLE backpressure_events_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('ACTIVATED', 'DEACTIVATED')),
      queue_size INTEGER NOT NULL CHECK (queue_size >= 0),
      target_throughput_per_sec INTEGER NOT NULL CHECK (target_throughput_per_sec >= 0),
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      reason TEXT,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: 'notification_metrics_snapshots',
    create: `CREATE TABLE notification_metrics_snapshots_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      total_recorded INTEGER NOT NULL CHECK (total_recorded >= 0),
      snapshot_json TEXT NOT NULL,
      CHECK (window_start <= window_end)
    )`,
  },
  {
    name: 'notification_archive',
    create: `CREATE TABLE notification_archive_v004 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
      target_recipient TEXT NOT NULL,
      execute_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      processing_completed_at DATETIME,
      status VARCHAR(20) NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      last_error TEXT,
      event_id TEXT,
      contract_address TEXT,
      metadata TEXT,
      archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
];

const audits: Array<{ table: string; sql: string }> = [
  {
    table: 'scheduled_notifications',
    sql: `SELECT COUNT(*) AS count FROM scheduled_notifications
      WHERE payload IS NULL OR notification_type IS NULL OR notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
        OR target_recipient IS NULL OR execute_at IS NULL
        OR status IS NULL OR status NOT IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
        OR retry_count IS NULL OR retry_count < 0 OR max_retries IS NULL OR max_retries < 0
        OR priority IS NULL OR priority NOT BETWEEN 1 AND 10`,
  },
  {
    table: 'notification_execution_log',
    sql: `SELECT COUNT(*) AS count FROM notification_execution_log l
      WHERE l.scheduled_notification_id IS NULL OR l.execution_attempt IS NULL OR l.execution_attempt <= 0
        OR l.execution_time IS NULL OR l.status IS NULL OR l.status NOT IN ('SUCCESS', 'FAILED', 'RETRY')
        OR (l.duration_ms IS NOT NULL AND l.duration_ms < 0)
        OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = l.scheduled_notification_id)`,
  },
  {
    table: 'dead_letter_queue',
    sql: `SELECT COUNT(*) AS count FROM dead_letter_queue d
      WHERE d.scheduled_notification_id IS NULL OR d.notification_type IS NULL
        OR d.notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
        OR d.target_recipient IS NULL OR d.payload IS NULL OR d.failure_reason IS NULL
        OR d.retry_count IS NULL OR d.retry_count < 0
        OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = d.scheduled_notification_id)`,
  },
  {
    table: 'dead_letter_queue (duplicate notification references)',
    sql: `SELECT COALESCE(SUM(row_count), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM dead_letter_queue
      GROUP BY scheduled_notification_id HAVING COUNT(*) > 1
    )`,
  },
  {
    table: 'processed_events',
    sql: `SELECT COUNT(*) AS count FROM processed_events
      WHERE event_id IS NULL OR contract_address IS NULL OR fingerprint IS NULL
        OR ledger_number IS NULL OR ledger_number < 0 OR event_type IS NULL
        OR is_reorg_duplicate IS NULL OR is_reorg_duplicate NOT IN (0, 1)
        OR reorg_detection_count IS NULL OR reorg_detection_count < 0
        OR status IS NULL OR status NOT IN ('PROCESSED', 'SKIPPED', 'ERROR')
        OR notification_sent IS NULL OR notification_sent NOT IN (0, 1)`,
  },
  {
    table: 'processed_events (duplicate fingerprints)',
    sql: `SELECT COALESCE(SUM(row_count), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM processed_events
      GROUP BY fingerprint HAVING COUNT(*) > 1
    )`,
  },
  {
    table: 'polling_cursors',
    sql: `SELECT COUNT(*) AS count FROM polling_cursors
      WHERE contract_address IS NULL OR cursor IS NULL OR ledger_number IS NULL OR ledger_number < 0
        OR reorg_detected IS NULL OR reorg_detected NOT IN (0, 1)
        OR reorg_detection_count IS NULL OR reorg_detection_count < 0`,
  },
  {
    table: 'polling_cursors (duplicate contracts)',
    sql: `SELECT COALESCE(SUM(row_count), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM polling_cursors
      GROUP BY contract_address HAVING COUNT(*) > 1
    )`,
  },
  {
    table: 'idempotency_keys',
    sql: `SELECT COUNT(*) AS count FROM idempotency_keys k
      WHERE k.idempotency_key IS NULL OR k.request_hash IS NULL OR k.response_notification_id IS NULL
        OR k.response_data IS NULL OR k.expires_at IS NULL OR k.status IS NULL OR k.status NOT IN ('PROCESSED', 'EXPIRED')
        OR NOT EXISTS (SELECT 1 FROM scheduled_notifications n WHERE n.id = k.response_notification_id)`,
  },
  {
    table: 'idempotency_keys (duplicate keys)',
    sql: `SELECT COALESCE(SUM(row_count), 0) AS count FROM (
      SELECT COUNT(*) AS row_count FROM idempotency_keys
      GROUP BY idempotency_key HAVING COUNT(*) > 1
    )`,
  },
  {
    table: 'rate_limit_events',
    sql: `SELECT COUNT(*) AS count FROM rate_limit_events
      WHERE client_id IS NULL OR client_type IS NULL OR client_type NOT IN ('IP', 'API_KEY')
        OR endpoint IS NULL OR method IS NULL OR limit_threshold IS NULL OR limit_threshold < 0
        OR window_ms IS NULL OR window_ms < 0`,
  },
  {
    table: 'notification_template_audit_log',
    sql: `SELECT COUNT(*) AS count FROM notification_template_audit_log a
      WHERE a.template_id IS NULL OR a.actor IS NULL OR a.action IS NULL OR a.action NOT IN ('UPDATE')
        OR a.previous_snapshot IS NULL OR a.new_snapshot IS NULL
        OR NOT EXISTS (SELECT 1 FROM notification_templates t WHERE t.id = a.template_id)`,
  },
  {
    table: 'backpressure_events',
    sql: `SELECT COUNT(*) AS count FROM backpressure_events
      WHERE event_type IS NULL OR event_type NOT IN ('ACTIVATED', 'DEACTIVATED')
        OR queue_size IS NULL OR queue_size < 0 OR target_throughput_per_sec IS NULL OR target_throughput_per_sec < 0
        OR (duration_ms IS NOT NULL AND duration_ms < 0)`,
  },
  {
    table: 'notification_metrics_snapshots',
    sql: `SELECT COUNT(*) AS count FROM notification_metrics_snapshots
      WHERE window_start IS NULL OR window_end IS NULL OR window_start > window_end
        OR total_recorded IS NULL OR total_recorded < 0 OR snapshot_json IS NULL`,
  },
  {
    table: 'notification_archive',
    sql: `SELECT COUNT(*) AS count FROM notification_archive
      WHERE original_id IS NULL OR payload IS NULL OR notification_type IS NULL
        OR notification_type NOT IN ('discord', 'email', 'webhook', 'sms')
        OR target_recipient IS NULL OR execute_at IS NULL OR created_at IS NULL
        OR status IS NULL OR status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED')
        OR retry_count IS NULL OR retry_count < 0 OR archived_at IS NULL`,
  },
];

const indexes = [
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status ON scheduled_notifications(status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_execute_at ON scheduled_notifications(status, execute_at) WHERE status = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_lock_expires ON scheduled_notifications(lock_expires_at, status) WHERE status = 'PROCESSING'`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_next_retry_at ON scheduled_notifications(next_retry_at, status) WHERE status = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_created_at ON scheduled_notifications(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_event_id ON scheduled_notifications(event_id) WHERE event_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_target ON scheduled_notifications(target_recipient, status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_claim ON scheduled_notifications(status, priority, execute_at) WHERE status = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_processor_lock ON scheduled_notifications(processor_id, status, lock_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_created ON scheduled_notifications(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_type_status ON scheduled_notifications(notification_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_contract ON scheduled_notifications(contract_address) WHERE contract_address IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_execution_log_notification_id ON notification_execution_log(scheduled_notification_id)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_log_execution_time ON notification_execution_log(execution_time)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_log_status_execution_time ON notification_execution_log(status, execution_time)`,
  `CREATE INDEX IF NOT EXISTS idx_execution_log_notification_attempt ON notification_execution_log(scheduled_notification_id, execution_attempt)`,
  `CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at ON dead_letter_queue(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_notification_type ON dead_letter_queue(notification_type)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_fingerprint ON processed_events(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_contract_event ON processed_events(contract_address, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events(processed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_reorg_duplicates ON processed_events(is_reorg_duplicate, processed_at) WHERE is_reorg_duplicate = 1`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_ledger_contract ON processed_events(ledger_number, contract_address)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_status_processed ON processed_events(status, processed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_event_type_status ON processed_events(event_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_events_tx_hash ON processed_events(tx_hash) WHERE tx_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_polling_cursors_contract ON polling_cursors(contract_address)`,
  `CREATE INDEX IF NOT EXISTS idx_polling_cursors_updated_at ON polling_cursors(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limit_events_timestamp ON rate_limit_events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limit_events_client_id ON rate_limit_events(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limit_events_client_timestamp ON rate_limit_events(client_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_template_audit_template_id ON notification_template_audit_log(template_id)`,
  `CREATE INDEX IF NOT EXISTS idx_template_audit_changed_at ON notification_template_audit_log(changed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_backpressure_events_type ON backpressure_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_backpressure_events_timestamp ON backpressure_events(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_backpressure_events_type_timestamp ON backpressure_events(event_type, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_captured_at ON notification_metrics_snapshots(captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_original_id ON notification_archive(original_id)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON notification_archive(archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_status ON notification_archive(status)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_contract_address ON notification_archive(contract_address) WHERE contract_address IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_archive_event_id ON notification_archive(event_id) WHERE event_id IS NOT NULL`,
];

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

async function assertLegacyDataIsValid(db: sqlite3.Database): Promise<void> {
  const violations: string[] = [];
  for (const audit of audits) {
    const count = await getCount(db, audit.sql);
    if (count > 0) violations.push(`${audit.table}: ${count} row(s)`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Migration 004 aborted before rebuilding tables. Repair invalid legacy data first: ${violations.join('; ')}`,
    );
  }
}

const migration = {
  id: '004',
  name: 'database-data-integrity',
  up: async (db: sqlite3.Database) => {
    await assertLegacyDataIsValid(db);

    for (const table of tables) {
      await run(db, table.create);
      await run(db, `INSERT INTO ${table.name}_v004 SELECT * FROM ${table.name}`);
    }

    for (const tableName of [
      'notification_execution_log',
      'dead_letter_queue',
      'idempotency_keys',
      'notification_template_audit_log',
      'processed_events',
      'polling_cursors',
      'rate_limit_events',
      'backpressure_events',
      'notification_metrics_snapshots',
      'notification_archive',
      'scheduled_notifications',
    ]) {
      await run(db, `DROP TABLE ${tableName}`);
    }

    await run(db, 'ALTER TABLE scheduled_notifications_v004 RENAME TO scheduled_notifications');
    for (const table of tables.slice(1)) {
      await run(db, `ALTER TABLE ${table.name}_v004 RENAME TO ${table.name}`);
    }

    for (const index of indexes) await run(db, index);

    await run(
      db,
      `CREATE TRIGGER IF NOT EXISTS update_scheduled_notifications_timestamp
      AFTER UPDATE ON scheduled_notifications
      FOR EACH ROW BEGIN
        UPDATE scheduled_notifications SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END`,
    );
    await run(
      db,
      `CREATE TRIGGER IF NOT EXISTS prevent_template_audit_update
      BEFORE UPDATE ON notification_template_audit_log
      FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END`,
    );
    await run(
      db,
      `CREATE TRIGGER IF NOT EXISTS prevent_template_audit_delete
      BEFORE DELETE ON notification_template_audit_log
      FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END`,
    );

    const foreignKeyViolations = await getRows(db, 'PRAGMA foreign_key_check');
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Migration 004 detected ${foreignKeyViolations.length} foreign-key violation(s) after rebuilding tables`,
      );
    }
  },
  down: async () => {
    throw new Error(
      'Migration 004 cannot be safely rolled back; restore a database backup instead',
    );
  },
};

export default migration;
