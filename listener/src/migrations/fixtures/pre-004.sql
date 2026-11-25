-- Legacy schema snapshot immediately before migration 004.
CREATE TABLE scheduled_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, payload_hash TEXT,
  notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL,
  execute_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3,
  processing_started_at DATETIME, processing_completed_at DATETIME, processor_id VARCHAR(100),
  lock_expires_at DATETIME, last_error TEXT, error_details TEXT, event_id TEXT,
  contract_address TEXT, priority INTEGER NOT NULL DEFAULT 5, metadata TEXT, next_retry_at DATETIME,
  deduplication_key TEXT
);
CREATE TABLE notification_execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL,
  execution_attempt INTEGER NOT NULL, execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL, error_message TEXT, response_data TEXT, duration_ms INTEGER,
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE dead_letter_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL UNIQUE,
  notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL, payload TEXT NOT NULL,
  failure_reason TEXT NOT NULL, error_details TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_retried_at DATETIME, retry_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE processed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, contract_address TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE, ledger_number INTEGER NOT NULL, tx_hash TEXT,
  event_type VARCHAR(50) NOT NULL, processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_reorg_duplicate BOOLEAN NOT NULL DEFAULT 0, reorg_detection_count INTEGER NOT NULL DEFAULT 0,
  last_redetected_at DATETIME, status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
  notification_sent BOOLEAN NOT NULL DEFAULT 0, error_reason TEXT
);
CREATE TABLE polling_cursors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contract_address TEXT NOT NULL UNIQUE,
  cursor TEXT NOT NULL, ledger_number INTEGER NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reorg_detected BOOLEAN NOT NULL DEFAULT 0, reorg_detection_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  response_notification_id INTEGER NOT NULL, response_data TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
  FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, client_type VARCHAR(20) NOT NULL,
  endpoint TEXT NOT NULL, method VARCHAR(10) NOT NULL, timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  limit_threshold INTEGER NOT NULL, window_ms INTEGER NOT NULL
);
CREATE TABLE notification_templates (id TEXT PRIMARY KEY);
CREATE TABLE notification_template_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_id TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'UPDATE', changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  previous_snapshot TEXT NOT NULL, new_snapshot TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES notification_templates(id) ON DELETE RESTRICT
);
CREATE TABLE backpressure_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_type VARCHAR(20) NOT NULL, queue_size INTEGER NOT NULL,
  target_throughput_per_sec INTEGER NOT NULL, duration_ms INTEGER, reason TEXT,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE notification_metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, total_recorded INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE notification_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT, original_id INTEGER NOT NULL, payload TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL,
  execute_at DATETIME NOT NULL, created_at DATETIME NOT NULL, processing_completed_at DATETIME,
  status VARCHAR(20) NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  event_id TEXT, contract_address TEXT, metadata TEXT,
  archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
