/**
 * Types for Scheduled Notifications
 */

export enum NotificationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  DEAD_LETTERED = 'DEAD_LETTERED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  AWAITING_INTERVENTION = 'AWAITING_INTERVENTION',
}

export enum NotificationType {
  DISCORD = 'discord',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  SMS = 'sms',
}

export type RecurrenceFrequency = 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number;
  until?: Date | string;
  count?: number;
}

export interface ScheduledNotification {
  id?: number;
  payload: string; // JSON string
  payloadHash?: string | null;
  notificationType: NotificationType;
  targetRecipient: string;
  executeAt: Date;
  expiresAt?: Date | null;
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
  /** Optional reason supplied when a notification is cancelled. */
  cancellationReason?: string | null;
  /** When the next retry should be attempted (null if not retrying). */
  nextRetryAt?: Date | null;
  /** Stable logical key used to prevent duplicate delivery of the same notification. */
  deduplicationKey?: string | null;
  recurrence?: RecurrenceRule | null;
  /** Number of executed or skipped series occurrences. */
  occurrenceCount?: number;
  lastRunAt?: Date | null;
}

export interface CreateScheduledNotificationInput {
  payload: Record<string, any>;
  notificationType: NotificationType;
  targetRecipient: string;
  executeAt: Date;
  /** IANA timezone used to interpret/display executeAt; storage remains UTC. */
  timezone?: string;
  expiresAt?: Date | string | number | null;
  maxRetries?: number;
  deduplicationKey?: string;
  eventId?: string;
  contractAddress?: string;
  priority?: number;
  metadata?: Record<string, any>;
  recurrence?: RecurrenceRule;
}

export interface ScheduledNotificationRow {
  id: number;
  version: number;
  recovery_state: 'AWAITING_INTERVENTION' | null;
  payload: string;
  payload_hash: string | null;
  notification_type: string;
  target_recipient: string;
  execute_at: string;
  expires_at: string | null;
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
  error_details: string | null; // JSON; now may contain { cancellationReason?: string }
  event_id: string | null;
  contract_address: string | null;
  priority: number;
  metadata: string | null;
  next_retry_at: string | null;
  deduplication_key: string | null;
  recurrence_rule?: string | null;
  occurrence_count?: number;
  last_run_at?: string | null;
}

export interface NotificationExecutionLog {
  id?: number;
  scheduledNotificationId: number;
  executionAttempt: number;
  executionTime: Date;
  status: 'SUCCESS' | 'FAILED' | 'RETRY' | 'DEAD_LETTERED';
  errorMessage?: string | null;
  responseData?: string | null;
  durationMs?: number | null;
}

export type ScheduleRecoveryPolicy = 'EXECUTE' | 'EXPIRE' | 'REQUIRE_INTERVENTION';
/**
 * What to do when a notification is still pending after its executeAt and the
 * scheduler was not available to run it inside the timing buffer.
 *
 * - `execute` — deliver it late (default, previous catch-up behavior)
 * - `expire` — mark it EXPIRED and do not deliver
 * - `intervene` — hold it until an operator resumes it
 */
export type MissedSchedulePolicy = 'execute' | 'expire' | 'intervene';

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
  recoveryPolicy?: ScheduleRecoveryPolicy;
  /** Overdue notifications outside the timing buffer. Default `execute`. */
  missedSchedulePolicy?: MissedSchedulePolicy;
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
