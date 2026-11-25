import * as sqlite3 from 'sqlite3';

const migration = {
  id: '001',
  name: 'initial-schema',
  up: async (db: sqlite3.Database) => {
    // The production bootstrap path (Database.initialize()) applies schema.sql with
    // its own robust splitter. If the schema already exists, skip this migration
    // to avoid issues with naive statement splitting and duplicate objects.
    const existing = await new Promise<any>((resolve, reject) => {
      db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_notifications'", (error, row) => (error ? reject(error) : resolve(row)));
    });
    if (existing) {
      return;
    }
    const schemaSql = `
      -- Main table for scheduled notifications
      CREATE TABLE IF NOT EXISTS scheduled_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        notification_type VARCHAR(50) NOT NULL,
        target_recipient TEXT NOT NULL,
        execute_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        processing_started_at DATETIME,
        processing_completed_at DATETIME,
        processor_id VARCHAR(100),
        lock_expires_at DATETIME,
        last_error TEXT,
        error_details TEXT,
        event_id TEXT,
        contract_address TEXT,
        priority INTEGER NOT NULL DEFAULT 5,
        metadata TEXT,
        next_retry_at DATETIME
      );

      -- Indexes for performance optimization
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status 
        ON scheduled_notifications(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_execute_at 
        ON scheduled_notifications(status, execute_at) 
        WHERE status = 'PENDING';
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_lock_expires 
        ON scheduled_notifications(lock_expires_at, status) 
        WHERE status = 'PROCESSING';
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_next_retry_at
        ON scheduled_notifications(next_retry_at, status)
        WHERE status = 'PENDING';
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_created_at 
        ON scheduled_notifications(created_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_event_id 
        ON scheduled_notifications(event_id) 
        WHERE event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_target 
        ON scheduled_notifications(target_recipient, status);

      -- Notification execution history for auditing
      CREATE TABLE IF NOT EXISTS notification_execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_notification_id INTEGER NOT NULL,
        execution_attempt INTEGER NOT NULL,
        execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL,
        error_message TEXT,
        response_data TEXT,
        duration_ms INTEGER,
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_execution_log_notification_id 
        ON notification_execution_log(scheduled_notification_id);
      CREATE INDEX IF NOT EXISTS idx_execution_log_execution_time 
        ON notification_execution_log(execution_time);
      CREATE INDEX IF NOT EXISTS idx_execution_log_status_execution_time 
        ON notification_execution_log(status, execution_time);

      -- Trigger to update updated_at timestamp
      CREATE TRIGGER IF NOT EXISTS update_scheduled_notifications_timestamp 
      AFTER UPDATE ON scheduled_notifications
      FOR EACH ROW
      BEGIN
        UPDATE scheduled_notifications 
        SET updated_at = CURRENT_TIMESTAMP 
        WHERE id = NEW.id;
      END;

      -- Rate limit events table for auditing
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        client_type VARCHAR(20) NOT NULL,
        endpoint TEXT NOT NULL,
        method VARCHAR(10) NOT NULL,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        limit_threshold INTEGER NOT NULL,
        window_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limit_events_timestamp 
        ON rate_limit_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_events_client_id 
        ON rate_limit_events(client_id);

      -- Notification templates
      CREATE TABLE IF NOT EXISTS notification_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        variables TEXT,
        metadata TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_notification_templates_type
        ON notification_templates(type);

      CREATE TRIGGER IF NOT EXISTS update_notification_templates_timestamp
      AFTER UPDATE ON notification_templates
      FOR EACH ROW
      BEGIN
        UPDATE notification_templates
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.id;
      END;

      -- Immutable audit trail for template modifications
      CREATE TABLE IF NOT EXISTS notification_template_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'UPDATE',
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        previous_snapshot TEXT NOT NULL,
        new_snapshot TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES notification_templates(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_template_audit_template_id
        ON notification_template_audit_log(template_id);
      CREATE INDEX IF NOT EXISTS idx_template_audit_changed_at
        ON notification_template_audit_log(changed_at);

      CREATE TRIGGER IF NOT EXISTS prevent_template_audit_update
      BEFORE UPDATE ON notification_template_audit_log
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'Audit records are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_template_audit_delete
      BEFORE DELETE ON notification_template_audit_log
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'Audit records are immutable');
      END;

      -- Event processing deduplication table
      CREATE TABLE IF NOT EXISTS processed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        ledger_number INTEGER NOT NULL,
        tx_hash TEXT,
        event_type VARCHAR(50) NOT NULL,
        processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        is_reorg_duplicate BOOLEAN NOT NULL DEFAULT 0,
        reorg_detection_count INTEGER NOT NULL DEFAULT 0,
        last_redetected_at DATETIME,
        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
        notification_sent BOOLEAN NOT NULL DEFAULT 0,
        error_reason TEXT
      );

      -- Indexes for efficient lookups
      CREATE INDEX IF NOT EXISTS idx_processed_events_fingerprint 
        ON processed_events(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_processed_events_contract_event 
        ON processed_events(contract_address, event_id);
      CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at 
        ON processed_events(processed_at);
      CREATE INDEX IF NOT EXISTS idx_processed_events_reorg_duplicates 
        ON processed_events(is_reorg_duplicate, processed_at) 
        WHERE is_reorg_duplicate = 1;
      CREATE INDEX IF NOT EXISTS idx_processed_events_ledger_contract 
        ON processed_events(ledger_number, contract_address);

      -- Cursor tracking for event polling to detect reorgs
      CREATE TABLE IF NOT EXISTS polling_cursors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_address TEXT NOT NULL UNIQUE,
        cursor TEXT NOT NULL,
        ledger_number INTEGER NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reorg_detected BOOLEAN NOT NULL DEFAULT 0,
        reorg_detection_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_polling_cursors_contract 
        ON polling_cursors(contract_address);
      CREATE INDEX IF NOT EXISTS idx_polling_cursors_updated_at
        ON polling_cursors(updated_at);

      -- Idempotency keys table for request deduplication
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        response_notification_id INTEGER NOT NULL,
        response_data TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
        FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key
        ON idempotency_keys(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
        ON idempotency_keys(expires_at);
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
        ON idempotency_keys(created_at);

      -- Backpressure events table for tracking queue saturation and recovery
      CREATE TABLE IF NOT EXISTS backpressure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type VARCHAR(20) NOT NULL,
        queue_size INTEGER NOT NULL,
        target_throughput_per_sec INTEGER NOT NULL,
        duration_ms INTEGER,
        reason TEXT,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_backpressure_events_type
        ON backpressure_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_backpressure_events_timestamp
        ON backpressure_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_backpressure_events_type_timestamp
        ON backpressure_events(event_type, timestamp);

      -- Persisted notification delivery metrics snapshots for historical analytics
      CREATE TABLE IF NOT EXISTS notification_metrics_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,
        total_recorded INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_captured_at
        ON notification_metrics_snapshots(captured_at);
    `;

    const statements = schemaSql.split(';').map(s => s.trim()).filter(s => s);
    for (const statement of statements) {
      await db.run(statement);
    }
  },
  down: async (db: sqlite3.Database) => {
    await db.run('DROP TABLE IF EXISTS notification_metrics_snapshots');
    await db.run('DROP TABLE IF EXISTS backpressure_events');
    await db.run('DROP TABLE IF EXISTS idempotency_keys');
    await db.run('DROP TABLE IF EXISTS polling_cursors');
    await db.run('DROP TABLE IF EXISTS processed_events');
    await db.run('DROP TABLE IF EXISTS notification_template_audit_log');
    await db.run('DROP TABLE IF EXISTS notification_templates');
    await db.run('DROP TABLE IF EXISTS rate_limit_events');
    await db.run('DROP TRIGGER IF EXISTS update_scheduled_notifications_timestamp');
    await db.run('DROP TABLE IF EXISTS notification_execution_log');
    await db.run('DROP TABLE IF EXISTS scheduled_notifications');
  }
};

export default migration;
