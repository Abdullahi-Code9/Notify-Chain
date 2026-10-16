/**
 * Types for Scheduled Notifications
 */

export enum NotificationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum NotificationType {
  DISCORD = 'discord',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  SMS = 'sms',
}

export interface ScheduledNotification {
  id?: number;
  payload: string; // JSON string
  payloadHash?: string | null;
  notificationType: NotificationType;
  targetRecipient: string;
  executeAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
  status: NotificationStatus;
  retryCount: number;
  maxRetries: number;
  processingStartedAt?: Date | null;
  processingCompletedAt?: Date | null;
  processorId?: string | null;
  lockExpiresAt?: Date | null;
  lastError?: string | null;
  errorDetails?: string | null;
  eventId?: string | null;
  contractAddress?: string | null;
  priority: number;
  metadata?: string | null; // JSON string
  /** When the next retry should be attempted (null if not retrying). */
  nextRetryAt?: Date | null;
}

export interface CreateScheduledNotificationInput {
  payload: Record<string, any>;
  notificationType: NotificationType;
  targetRecipient: string;
  executeAt: Date;
  maxRetries?: number;
  eventId?: string;
  contractAddress?: string;
  priority?: number;
  metadata?: Record<string, any>;
}

export interface ScheduledNotificationRow {
  id: number;
  payload: string;
  payload_hash: string | null;
  notification_type: string;
  target_recipient: string;
  execute_at: string;
  created_at: string;
  updated_at: string;
  status: string;
  retry_count: number;
  max_retries: number;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  processor_id: string | null;
  lock_expires_at: string | null;
  last_error: string | null;
  error_details: string | null;
  event_id: string | null;
  contract_address: string | null;
  priority: number;
  metadata: string | null;
  next_retry_at: string | null;
}

export interface NotificationExecutionLog {
  id?: number;
  scheduledNotificationId: number;
  executionAttempt: number;
  executionTime: Date;
  status: 'SUCCESS' | 'FAILED' | 'RETRY';
  errorMessage?: string | null;
  responseData?: string | null;
  durationMs?: number | null;
}

export interface SchedulerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  processorId?: string;
  batchSize: number;
  timingBufferMs: number;
  retryDelayMs?: number;
  /** Max notifications processed concurrently per poll cycle (WORKER_CONCURRENCY). Default 1 = serial. */
  concurrency?: number;
}

export interface DeadLetterQueueEntry {
  id?: number;
  originalNotificationId: number;
  notificationType: NotificationType;
  targetRecipient: string;
  payload: string;
  failureReason: string;
  errorDetails?: string | null;
  createdAt?: Date;
  lastRetriedAt?: Date | null;
  retryCount: number;
}
