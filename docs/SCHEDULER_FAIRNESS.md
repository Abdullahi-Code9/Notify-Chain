# Scheduler Fairness Across Large Due Batches

## Selection policy

When the scheduler claims due notifications it uses a **round-robin-by-schedule-group** policy:

1. Eligible rows are those with `status = PENDING`, `execute_at <= now`, and a due (or null) `next_retry_at`.
2. Each row is assigned a **schedule group** key:
   `COALESCE(contract_address, event_id, notification_type, 'default')`.
3. Within a group, rows are ordered by `priority ASC`, `execute_at ASC`, `id ASC`.
4. The claim batch is filled by taking rank 1 from every group, then rank 2, and so on.
5. **Batch size is bounded** by `ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE` (100), regardless of the configured `batchSize`.

This prevents one large group of due notifications from indefinitely delaying other eligible schedule groups.

## Configuration

- `SchedulerConfig.batchSize` — requested claim size per poll (still capped at 100).
- See `fetchAndLockPendingNotifications` in `scheduled-notification-repository.ts`.
