-- Notification Templates Database Schema
-- SQLite schema for storing reusable notification templates with variable placeholders

-- Main table for channel notification templates.
-- NOTE: named `channel_templates` rather than `notification_templates` so it
-- coexists with the audited template table defined in schema.sql (TEXT id).
CREATE TABLE IF NOT EXISTS channel_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Template identification
  unique_key VARCHAR(255) NOT NULL UNIQUE,  -- e.g., 'welcome_email', 'task_completed'
  name VARCHAR(255) NOT NULL,               -- Human-readable name
  description TEXT,                         -- Template description/purpose
  
  -- Template type and channel
  channel_type VARCHAR(50) NOT NULL,        -- 'EMAIL', 'SMS', 'DISCORD', 'PUSH', 'WEBHOOK'
  
  -- Template content
  subject_template TEXT,                    -- Subject line (for EMAIL, optional for others)
  body_template TEXT NOT NULL,              -- Main message body with {{placeholders}}
  
  -- Metadata
  variables JSON,                           -- JSON array of required variables: ["user_name", "amount"]
  default_values JSON,                      -- JSON object of default values: {"fallback": "User"}
  
  -- Validation and security
  is_active BOOLEAN NOT NULL DEFAULT 1,     -- Enable/disable template
  version INTEGER NOT NULL DEFAULT 1,       -- Template version for change tracking
  
  -- Audit fields
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(255),                  -- User/system that created template
  updated_by VARCHAR(255)                   -- User/system that last updated template
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_templates_unique_key 
  ON channel_templates(unique_key);

CREATE INDEX IF NOT EXISTS idx_templates_channel_type 
  ON channel_templates(channel_type);

CREATE INDEX IF NOT EXISTS idx_templates_active 
  ON channel_templates(is_active) 
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_templates_created_at 
  ON channel_templates(created_at DESC);

-- Template usage history (for analytics)
CREATE TABLE IF NOT EXISTS template_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  rendered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  context_data JSON,                        -- The variables used for rendering
  recipient VARCHAR(255),                   -- Who received the notification
  status VARCHAR(50),                       -- 'SUCCESS', 'FAILED'
  error_message TEXT,                       -- Error details if failed
  
  FOREIGN KEY (template_id) REFERENCES channel_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_log_template_id 
  ON template_usage_log(template_id);

CREATE INDEX IF NOT EXISTS idx_usage_log_rendered_at 
  ON template_usage_log(rendered_at DESC);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_template_timestamp 
AFTER UPDATE ON channel_templates
FOR EACH ROW
BEGIN
  UPDATE channel_templates 
  SET updated_at = CURRENT_TIMESTAMP 
  WHERE id = NEW.id;
END;
