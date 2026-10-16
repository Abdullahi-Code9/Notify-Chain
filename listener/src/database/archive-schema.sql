-- Archive table for notifications moved out of active storage.
-- Records here are read-only for audit purposes and are never modified.
CREATE TABLE IF NOT EXISTS notification_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Original record identity
  original_id INTEGER NOT NULL,             -- PK from scheduled_notifications at time of archiving
  payload TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  target_recipient TEXT NOT NULL,

  -- Original scheduling / timing
  execute_at DATETIME NOT NULL,
  expires_at DATETIME,
  created_at DATETIME NOT NULL,
  processing_completed_at DATETIME,

  -- Final status at time of archiving
  status VARCHAR(20) NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT,

  -- Optional references
  event_id TEXT,
  contract_address TEXT,
  metadata TEXT,

  -- Archival bookkeeping
  archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archive_original_id
  ON notification_archive(original_id);

CREATE INDEX IF NOT EXISTS idx_archive_archived_at
  ON notification_archive(archived_at);

CREATE INDEX IF NOT EXISTS idx_archive_status
  ON notification_archive(status);

CREATE INDEX IF NOT EXISTS idx_archive_contract_address
  ON notification_archive(contract_address)
  WHERE contract_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_archive_event_id
  ON notification_archive(event_id)
  WHERE event_id IS NOT NULL;
