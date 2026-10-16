-- Scheduled Notifications Database Schema
-- SQLite Database Schema for storing and tracking scheduled notifications

-- Main table for scheduled notifications
CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Notification content and metadata
  payload TEXT NOT NULL,                    -- JSON payload of the notification (compressed when large)
  payload_hash TEXT,                        -- HMAC hash of the raw JSON payload for integrity checks
  notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('discord', 'email', 'webhook', 'sms')),
  target_recipient TEXT NOT NULL,           -- User ID, webhook URL, or recipient identifier
  
  -- Scheduling information
  execute_at DATETIME NOT NULL,             -- When the notification should be sent
  expires_at DATETIME,                      -- Optional deadline after which delivery is skipped
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Status tracking
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DEAD_LETTERED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  
  -- Processing metadata
  processing_started_at DATETIME,
  processing_completed_at DATETIME,
  processor_id VARCHAR(100),                -- Identifier of the worker processing this job
  lock_expires_at DATETIME,                 -- Distributed lock expiration for race condition prevention
  
  -- Error tracking
  last_error TEXT,
  error_details TEXT,                       -- JSON with full error context
  
  -- Additional metadata
  event_id TEXT,                            -- Reference to the original event (if applicable)
  contract_address TEXT,                    -- Stellar contract address (if applicable)
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  metadata TEXT,                            -- Additional JSON metadata
  next_retry_at DATETIME,                   -- When the next retry should be attempted
  deduplication_key TEXT                    -- Caller-supplied key; duplicate inserts with the same key are silently skipped
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status 
  ON scheduled_notifications(status);

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_execute_at 
  ON scheduled_notifications(status, execute_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_lock_expires 
  ON scheduled_notifications(lock_expires_at, status);

-- Migration: add next_retry_at for explicit retry scheduling


CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_next_retry_at
  ON scheduled_notifications(next_retry_at, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_created_at 
  ON scheduled_notifications(created_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_event_id 
  ON scheduled_notifications(event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_notifications_dedup_key
  ON scheduled_notifications(deduplication_key)
  WHERE deduplication_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_target 
  ON scheduled_notifications(target_recipient, status);

-- Migration: add next_retry_at for explicit retry scheduling (no-op when column exists in CREATE TABLE)
-- SQLite does not support IF NOT EXISTS for ADD COLUMN; runMigrations tolerates duplicate-column errors.
-- Dead-letter queue for permanently failed notifications
CREATE TABLE IF NOT EXISTS dead_letter_queue (
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
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at
  ON dead_letter_queue(created_at);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_notification_type
  ON dead_letter_queue(notification_type);

-- Notification execution history for auditing
CREATE TABLE IF NOT EXISTS notification_execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_notification_id INTEGER NOT NULL,
  execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
  execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRY')),
  error_message TEXT,
  response_data TEXT,                       -- JSON response from notification service
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  
  FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_execution_log_notification_id 
  ON notification_execution_log(scheduled_notification_id);

CREATE INDEX IF NOT EXISTS idx_execution_log_execution_time 
  ON notification_execution_log(execution_time);

CREATE INDEX IF NOT EXISTS idx_execution_log_status_execution_time 
  ON notification_execution_log(status, execution_time);

-- One immutable receipt per provider delivery attempt
CREATE TABLE IF NOT EXISTS delivery_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'rejected', 'pending')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  provider_message_id TEXT,
  provider_response TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_receipts_notification_attempt
  ON delivery_receipts(notification_id, attempt_count, id);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_status_created
  ON delivery_receipts(status, created_at);

-- Migration: add next_retry_at for explicit retry scheduling (no-op when column exists in CREATE TABLE)
-- SQLite does not support IF NOT EXISTS for ADD COLUMN; runMigrations tolerates duplicate-column errors.
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
  client_id TEXT NOT NULL,                  -- IP address or API key
  client_type VARCHAR(20) NOT NULL CHECK (client_type IN ('IP', 'API_KEY')),
  endpoint TEXT NOT NULL,                   -- Request path/method
  method VARCHAR(10) NOT NULL,              -- Request method
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  limit_threshold INTEGER NOT NULL CHECK (limit_threshold > 0),
  window_ms INTEGER NOT NULL CHECK (window_ms > 0)
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
  action TEXT NOT NULL DEFAULT 'UPDATE' CHECK (action IN ('UPDATE')),
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

-- Event processing deduplication table - tracks processed events to prevent duplicates during reorgs
-- This table ensures idempotent processing of events even after blockchain reorganizations
CREATE TABLE IF NOT EXISTS processed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Event identification (fingerprint components)
  event_id TEXT NOT NULL,                   -- Unique identifier from blockchain RPC
  contract_address TEXT NOT NULL,           -- Contract that emitted the event
  fingerprint TEXT NOT NULL UNIQUE,         -- Composite key: contract_address:event_id (for faster lookups)
  
  -- Processing metadata
  ledger_number INTEGER NOT NULL CHECK (ledger_number >= 0),
  tx_hash TEXT,                             -- Transaction hash (if available)
  event_type VARCHAR(50) NOT NULL,          -- Type from RPC (contract, system, etc)
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Reorg detection and tracking
  is_reorg_duplicate BOOLEAN NOT NULL DEFAULT 0 CHECK (is_reorg_duplicate IN (0, 1)),
  reorg_detection_count INTEGER NOT NULL DEFAULT 0 CHECK (reorg_detection_count >= 0),
  last_redetected_at DATETIME,              -- When the event was last detected again (for reorg monitoring)
  
  -- Status and metadata
  status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'SKIPPED', 'ERROR')),
  notification_sent BOOLEAN NOT NULL DEFAULT 0 CHECK (notification_sent IN (0, 1)),
  error_reason TEXT                         -- If status is ERROR, what went wrong
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
  
  -- Contract tracking
  contract_address TEXT NOT NULL UNIQUE,    -- Which contract this cursor is for
  
  -- Cursor information
  cursor TEXT NOT NULL,                     -- Last known cursor from RPC
  ledger_number INTEGER NOT NULL CHECK (ledger_number >= 0),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Reorg detection
  reorg_detected BOOLEAN NOT NULL DEFAULT 0 CHECK (reorg_detected IN (0, 1)),
  reorg_detection_count INTEGER NOT NULL DEFAULT 0 CHECK (reorg_detection_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_polling_cursors_contract 
  ON polling_cursors(contract_address);

CREATE INDEX IF NOT EXISTS idx_polling_cursors_updated_at
  ON polling_cursors(updated_at);

-- Idempotency keys table for request deduplication
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Key identification
  idempotency_key TEXT NOT NULL UNIQUE,      -- Client-provided idempotency key

  -- Request and response tracking
  request_hash TEXT NOT NULL,                -- Hash of request body for validation
  response_notification_id INTEGER NOT NULL, -- ID of the created notification
  response_data TEXT NOT NULL,               -- JSON response to return on duplicate

  -- Lifecycle management
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,              -- When this key should be purged

  -- Status tracking
  status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED' CHECK (status IN ('PROCESSED', 'EXPIRED')),

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

  -- Event tracking
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('ACTIVATED', 'DEACTIVATED')),
  queue_size INTEGER NOT NULL CHECK (queue_size >= 0),
  target_throughput_per_sec INTEGER NOT NULL CHECK (target_throughput_per_sec >= 0),

  -- Duration tracking (for deactivation events)
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),

  -- Additional metadata
  reason TEXT,                                -- Optional reason/context for the event
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
  total_recorded INTEGER NOT NULL CHECK (total_recorded >= 0),
  snapshot_json TEXT NOT NULL,
  CHECK (window_start <= window_end)
);

CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_captured_at
  ON notification_metrics_snapshots(captured_at);
-- Archived notification rows retain only terminal delivery states
CREATE TABLE IF NOT EXISTS notification_archive (
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
);

CREATE INDEX IF NOT EXISTS idx_archive_original_id ON notification_archive(original_id);
CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON notification_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_archive_status ON notification_archive(status);
CREATE INDEX IF NOT EXISTS idx_archive_contract_address ON notification_archive(contract_address)
  WHERE contract_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_archive_event_id ON notification_archive(event_id)
  WHERE event_id IS NOT NULL;

-- ===============================================
-- QUERY PERFORMANCE INDEXES (migration 002)
-- See docs/DATABASE_QUERY_PERFORMANCE.md
-- ===============================================

-- Scheduler claim: status + priority + execute_at for pending jobs
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_claim
  ON scheduled_notifications(status, priority, execute_at)
  WHERE status = 'PENDING';

-- Post-claim fetch by processor lock
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_processor_lock
  ON scheduled_notifications(processor_id, status, lock_expires_at);

-- Search: status filter + created_at sort
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_created
  ON scheduled_notifications(status, created_at);

-- Search: notification type / channel filter
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_type_status
  ON scheduled_notifications(notification_type, status);

-- Contract address lookups
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_contract
  ON scheduled_notifications(contract_address)
  WHERE contract_address IS NOT NULL;

-- Processed events: status + time range
CREATE INDEX IF NOT EXISTS idx_processed_events_status_processed
  ON processed_events(status, processed_at);

-- Processed events: type filter
CREATE INDEX IF NOT EXISTS idx_processed_events_event_type_status
  ON processed_events(event_type, status);

-- Processed events: tx hash search
CREATE INDEX IF NOT EXISTS idx_processed_events_tx_hash
  ON processed_events(tx_hash)
  WHERE tx_hash IS NOT NULL;

-- Execution log join for metrics (latest attempt per notification)
CREATE INDEX IF NOT EXISTS idx_execution_log_notification_attempt
  ON notification_execution_log(scheduled_notification_id, execution_attempt);

-- Rate-limit audit by client + time
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_client_timestamp
  ON rate_limit_events(client_id, timestamp);

-- ===============================================
-- EVENT & NOTIFICATION QUERY INDEXES (migration 003)
-- See docs/DATABASE_QUERY_PERFORMANCE.md
-- ===============================================

-- Archival / retention cleanup: terminal notifications ordered by completion time
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_archivable
  ON scheduled_notifications(processing_completed_at)
  WHERE status IN ('COMPLETED','FAILED','CANCELLED');

-- Notification search: case-insensitive type filter + created_at sort
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_type_lower_created
  ON scheduled_notifications(LOWER(notification_type), created_at);

-- Processed-event search: case-insensitive type filter + processed_at sort
CREATE INDEX IF NOT EXISTS idx_processed_events_type_lower_processed
  ON processed_events(LOWER(event_type), processed_at);
