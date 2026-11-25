-- Schema snapshot after migration 004 and before migration 005.
CREATE TABLE scheduled_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, payload_hash TEXT,
  notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
  target_recipient TEXT NOT NULL, execute_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  processing_started_at DATETIME, processing_completed_at DATETIME, processor_id VARCHAR(100),
  lock_expires_at DATETIME, last_error TEXT, error_details TEXT, event_id TEXT,
  contract_address TEXT, priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  metadata TEXT, next_retry_at DATETIME, deduplication_key TEXT
);
CREATE TABLE notification_execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
  execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRY')),
  error_message TEXT, response_data TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE dead_letter_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL UNIQUE,
  notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
  target_recipient TEXT NOT NULL, payload TEXT NOT NULL, failure_reason TEXT NOT NULL,
  error_details TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_retried_at DATETIME, retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  response_notification_id INTEGER NOT NULL, response_data TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'EXPIRED')),
  FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);
CREATE TABLE notification_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT, original_id INTEGER NOT NULL, payload TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
  target_recipient TEXT NOT NULL, execute_at DATETIME NOT NULL, created_at DATETIME NOT NULL,
  processing_completed_at DATETIME,
  status VARCHAR(20) NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0), last_error TEXT,
  event_id TEXT, contract_address TEXT, metadata TEXT,
  archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
