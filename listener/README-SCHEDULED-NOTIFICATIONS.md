# Scheduled Notification System - Complete Implementation

## 🎯 Overview

This is a **production-ready, robust scheduled notification system** that allows users to schedule notifications for future delivery with guaranteed reliability, fault tolerance, and race condition prevention.

### Key Features

✅ **Precise Timing** - Notifications delivered within ±1 minute of scheduled time  
✅ **Fault Tolerant** - Automatic recovery after server restarts or crashes  
✅ **Race Condition Safe** - Distributed locking prevents duplicate processing  
✅ **Graceful Failure** - Failed notifications logged and retried, don't block queue  
✅ **Multi-Instance Ready** - Run multiple workers simultaneously  
✅ **Persistent Storage** - SQLite database ensures no data loss  
✅ **Audit Logging** - Complete execution history for debugging

---

## 📋 Acceptance Criteria - ALL MET ✓

### 1. Precise Timing ✓

- Notifications sent within configurable buffer (default: ±1 minute)
- Poll interval: 10 seconds (configurable)
- Priority-based processing

### 2. Resilience & Fault Tolerance ✓

- Automatic recovery on service restart
- Catch-up logic processes missed notifications
- Stale lock recovery handles crashed workers
- Persistent SQLite storage

### 3. Idempotency & Race Condition Prevention ✓

- Atomic row-level locking with `processor_id`
- Unique worker IDs prevent conflicts
- Lock expiration timeout
- Multi-instance safe

### 4. Graceful Failure ✓

- Failed jobs marked as `FAILED` with error details
- Retry logic with configurable max retries
- Execution history in audit log
- Queue continues processing

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd listener
npm install
```

Installs: `sqlite3`, `uuid`, `@types/uuid`

### 2. Run Database Migration

```bash
npm run migrate
```

Creates database with schema at `./data/notifications.db`

### 3. Configure Environment

```bash
# Copy example config
cp .env.example .env

# Edit configuration
nano .env
```

Minimum required configuration:

```bash
SCHEDULER_ENABLED=true
DATABASE_PATH=./data/notifications.db
```

### 4. Start Service

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

---

## 💻 Usage Examples

### TypeScript API

```typescript
import { NotificationAPI } from './services/notification-api';
import { ScheduledNotificationRepository } from './services/scheduled-notification-repository';
import { initializeDatabase } from './database/database';

// Initialize
const db = await initializeDatabase('./data/notifications.db');
const repository = new ScheduledNotificationRepository(db);
const api = new NotificationAPI(repository);

// Schedule notification for 1 hour from now
const id = await api.scheduleDiscordNotification(
  'https://discord.com/webhook/...',
  { content: 'Scheduled message!' },
  new Date(Date.now() + 3600000),
  { maxRetries: 5, priority: 1 },
);

// Check status
const notification = await api.getNotification(id);
console.log(notification.status); // PENDING, PROCESSING, COMPLETED, FAILED

// Cancel notification
await api.cancelNotification(id);

// Get statistics
const stats = await api.getStatistics();
// { pending: 10, processing: 2, completed: 100, failed: 5, overdue: 1 }
```

### REST API

```bash
# Schedule notification
curl -X POST http://localhost:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {"message": "Hello"},
    "notificationType": "discord",
    "targetRecipient": "webhook-url",
    "executeAt": "2024-12-31T12:00:00Z",
    "priority": 5,
    "maxRetries": 3
  }'

# Response: {"id": 123}

# Get notification status
curl http://localhost:8787/api/schedule/123

# Get statistics
curl http://localhost:8787/api/schedule/stats
```

---

## 🔧 Configuration

### Environment Variables

| Variable                     | Default                   | Description                                                                                                                                                              |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCHEDULER_ENABLED`          | `true`                    | Enable/disable scheduler                                                                                                                                                 |
| `DATABASE_PATH`              | `./data/notifications.db` | Database file path                                                                                                                                                       |
| `SCHEDULER_POLL_INTERVAL_MS` | `10000`                   | How often to check for due notifications                                                                                                                                 |
| `SCHEDULER_LOCK_TIMEOUT_MS`  | `60000`                   | Lock expiration timeout                                                                                                                                                  |
| `SCHEDULER_BATCH_SIZE`       | `10`                      | Notifications per processing cycle                                                                                                                                       |
| `SCHEDULER_TIMING_BUFFER_MS` | `60000`                   | Acceptable timing buffer (±1 min)                                                                                                                                        |
| `MAX_SCHEDULING_HORIZON`     | `365d`                    | Maximum time into the future for a first run. Accepts positive `ms`, `s`, `m`, `h`, or `d` durations up to 100 years; `0` disables the limit. The boundary is inclusive. |
| `SCHEDULER_PROCESSOR_ID`     | (auto-generated)          | Unique worker identifier                                                                                                                                                 |

### Complete .env Example

```bash
# Stellar Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443

# Scheduler Configuration
SCHEDULER_ENABLED=true
DATABASE_PATH=./data/notifications.db
SCHEDULER_POLL_INTERVAL_MS=10000
SCHEDULER_LOCK_TIMEOUT_MS=60000
SCHEDULER_PROCESSOR_ID=
SCHEDULER_BATCH_SIZE=10
SCHEDULER_TIMING_BUFFER_MS=60000
MAX_SCHEDULING_HORIZON=365d

# Discord Webhook
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Recurring schedules

`POST /api/schedule` accepts an optional constrained recurrence object. The first
`executeAt` is the first occurrence. Supported frequencies are `minutely`,
`hourly`, `daily`, `weekly`, and `monthly`; `interval` defaults to `1` and must
be a positive integer. Use exactly one of `count` or `until` to end a series.
`count` includes the first run; `until` is an inclusive ISO-8601 UTC timestamp.
If neither end condition is set, the series continues until cancelled.

```json
{
  "payload": { "message": "Daily service report" },
  "notificationType": "webhook",
  "targetRecipient": "https://example.test/notifications",
  "executeAt": "2026-11-01T09:00:00.000Z",
  "recurrence": { "frequency": "daily", "interval": 1, "count": 7 }
}
```

Recurrence calculations use UTC only. Daily and weekly runs retain their UTC
time across daylight-saving changes. Monthly runs use the previous occurrence's
day and clamp to the final day when a month is shorter (for example, January 31
advances to February 28 or 29). After downtime, the existing scheduler delivers
the due occurrence it claims, then skips any additional slots already past when
that delivery completes. Skipped slots count toward `count`, preventing a
delivery burst while preserving the next future run. After a successful
delivery, the occurrence counter and next time are persisted atomically. Failed
deliveries retry the same occurrence. Cancelling a pending
series prevents all later runs; an in-flight delivery cannot be cancelled, as
with existing one-shot schedules. A series becomes `COMPLETED` when `count` or
`until` is exhausted.

The horizon applies to the first `executeAt` and, when set, to `until`. Later
generated occurrences are not checked against the horizon. `executeAt` exactly
at `now + MAX_SCHEDULING_HORIZON` is allowed; anything later is rejected with
HTTP `400` and code `INVALID_SCHEDULE`. Setting `MAX_SCHEDULING_HORIZON=0`
disables this limit.

---

## 🏗️ Architecture

### Components

```
┌─────────────────────────────────────┐
│      Application (index.ts)         │
│  - Service Initialization           │
│  - Graceful Shutdown                │
└──────────────┬──────────────────────┘
               │
     ┌─────────┴─────────┐
     │                   │
     ▼                   ▼
┌─────────┐      ┌──────────────┐
│ REST    │      │ Scheduler    │
│ API     │      │ (Background) │
└────┬────┘      └──────┬───────┘
     │                  │
     └──────┬───────────┘
            │
            ▼
    ┌───────────────┐
    │ Notification  │
    │ API           │
    └───────┬───────┘
            │
            ▼
    ┌───────────────┐
    │ Repository    │
    │ (Data Access) │
    └───────┬───────┘
            │
            ▼
      ┌──────────┐
      │ Database │
      │ (SQLite) │
      └──────────┘
```

### Database Schema

#### `scheduled_notifications`

- Primary table storing notification details
- Statuses: PENDING → PROCESSING → COMPLETED/FAILED
- Indexes optimized for fast polling and lock recovery

#### `notification_execution_log`

- Audit trail for all execution attempts
- Tracks success, failure, retry attempts
- Duration metrics for performance monitoring

---

## 🔐 How Race Conditions Are Prevented

### Problem

Multiple scheduler instances could pick up the same notification.

### Solution: Distributed Locking

1. **Atomic Lock Acquisition**

   ```sql
   UPDATE scheduled_notifications
   SET status = 'PROCESSING',
       processor_id = 'worker-abc123',
       lock_expires_at = NOW() + 60 seconds
   WHERE id IN (
     SELECT id FROM scheduled_notifications
     WHERE status = 'PENDING'
       AND execute_at <= NOW()
     LIMIT 10
   )
   ```

2. **Unique Processor IDs**

   - Each worker has a unique UUID
   - Only fetch notifications locked by this worker

3. **Lock Timeout**

   - Locks expire after `SCHEDULER_LOCK_TIMEOUT_MS`
   - Stale locks automatically recovered

4. **Result**
   - Worker A locks notifications 1-10
   - Worker B locks notifications 11-20
   - No overlap, no duplicates

---

## 🔄 Catch-Up Logic for Missed Schedules

### Scenario

Server goes down, notifications scheduled during downtime.

### Solution

1. **On Startup**

   - Scheduler calls `recoverStaleLocks()`
   - Releases locks from crashed workers

2. **Fetching Due Notifications**

   ```sql
   SELECT * FROM scheduled_notifications
   WHERE status = 'PENDING'
     AND execute_at <= NOW()  -- Includes overdue
   ORDER BY priority ASC, execute_at ASC
   ```

3. **Processing**
   - Overdue notifications processed immediately
   - No missed notifications
   - Timing buffer allows small delays

### Example Timeline

```
10:00 AM - Schedule notification for 10:30 AM
10:15 AM - Server crashes
10:30 AM - (Scheduled time passes)
11:00 AM - Server restarts
11:00:10 AM - Notification processed (next poll cycle)
```

---

## 🧪 Testing

### Run Test Suite

```bash
npm test
```

### Test Coverage

- ✅ Repository CRUD operations
- ✅ Distributed locking
- ✅ Race condition prevention
- ✅ Stale lock recovery
- ✅ Retry logic
- ✅ Notification cancellation
- ✅ Statistics reporting
- ✅ API validation

### Manual Testing

```bash
# 1. Schedule test notification
curl -X POST http://localhost:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {"message": "Test"},
    "notificationType": "discord",
    "targetRecipient": "webhook-url",
    "executeAt": "'$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ)'"
  }'

# 2. Check status immediately
curl http://localhost:8787/api/schedule/1
# Should show: "status": "PENDING"

# 3. Wait 2 minutes

# 4. Check status again
curl http://localhost:8787/api/schedule/1
# Should show: "status": "COMPLETED"
```

---

## 📊 Monitoring & Debugging

### Application Logs

```bash
# Watch scheduler logs
tail -f logs/app.log | grep scheduler

# Search for specific notification
tail -f logs/app.log | grep "id: 123"
```

### Database Queries

```sql
# Pending notifications
SELECT id, execute_at, retry_count
FROM scheduled_notifications
WHERE status = 'PENDING';

# Failed notifications with errors
SELECT id, last_error, error_details
FROM scheduled_notifications
WHERE status = 'FAILED'
ORDER BY updated_at DESC
LIMIT 10;

# Execution history for notification
SELECT * FROM notification_execution_log
WHERE scheduled_notification_id = 123
ORDER BY execution_time;

# Statistics
SELECT
  status,
  COUNT(*) as count,
  AVG(retry_count) as avg_retries
FROM scheduled_notifications
GROUP BY status;
```

### REST API Monitoring

```bash
# Health check
curl http://localhost:8787/health

# Scheduler statistics
curl http://localhost:8787/api/schedule/stats
```

---

## 🛠️ Troubleshooting

### Issue: Scheduler not starting

**Check:**

```bash
# 1. Is it enabled?
grep SCHEDULER_ENABLED .env

# 2. Database exists?
ls -la ./data/notifications.db

# 3. Check logs
tail -f logs/app.log
```

**Fix:**

```bash
# Re-run migration
npm run migrate

# Restart service
npm run dev
```

### Issue: Notifications not processing

**Check:**

```sql
-- Stale locks?
SELECT * FROM scheduled_notifications
WHERE status = 'PROCESSING'
AND lock_expires_at < datetime('now');
```

**Fix:**

```sql
-- Manually recover
UPDATE scheduled_notifications
SET status = 'PENDING',
    processor_id = NULL,
    lock_expires_at = NULL
WHERE status = 'PROCESSING'
AND lock_expires_at < datetime('now');
```

### Issue: High failure rate

**Check:**

```sql
-- Failed notifications
SELECT last_error, COUNT(*) as count
FROM scheduled_notifications
WHERE status = 'FAILED'
GROUP BY last_error;
```

**Common Causes:**

- Invalid webhook URL
- Discord rate limiting
- Network issues
- Payload too large

---

## 🚀 Production Deployment

### Single Instance

```bash
# Build
npm run build

# Start with PM2
pm2 start npm --name "notify-scheduler" -- start

# Save PM2 configuration
pm2 save
```

### Multi-Instance (High Availability)

```bash
# Start 3 instances
pm2 start npm --name "scheduler-1" -- start
pm2 start npm --name "scheduler-2" -- start
pm2 start npm --name "scheduler-3" -- start

# Each will auto-generate unique processor_id
```

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

# Run migration on startup
CMD ["sh", "-c", "npm run migrate && npm start"]
```

### Environment-Specific Configuration

```bash
# Production
SCHEDULER_ENABLED=true
SCHEDULER_POLL_INTERVAL_MS=5000  # More frequent
SCHEDULER_BATCH_SIZE=20           # Larger batches
DATABASE_PATH=/data/prod-notifications.db

# Development
SCHEDULER_ENABLED=true
SCHEDULER_POLL_INTERVAL_MS=10000
SCHEDULER_BATCH_SIZE=10
DATABASE_PATH=./data/dev-notifications.db
```

---

## 📦 Files Created

### Core Implementation

- `src/database/database.ts` - SQLite connection handler
- `src/database/schema.sql` - Database schema
- `src/types/scheduled-notification.ts` - TypeScript types
- `src/services/scheduled-notification-repository.ts` - Data access layer
- `src/services/notification-scheduler.ts` - Background worker
- `src/services/notification-api.ts` - High-level API

### Integration

- `src/index.ts` (updated) - Service integration
- `src/config.ts` (updated) - Configuration
- `src/api/events-server.ts` (updated) - REST endpoints

### Testing & Examples

- `src/tests/notification-scheduler.test.ts` - Test suite
- `src/examples/schedule-notification-example.ts` - Usage examples
- `src/scripts/migrate-db.ts` - Database migration

### Documentation

- `README-SCHEDULER.md` - Detailed documentation
- `INSTALLATION.md` - Installation guide
- `IMPLEMENTATION-SUMMARY.md` - Implementation summary
- `QUICK-START-SCHEDULER.md` - Quick reference
- `.env.example` (updated) - Configuration template
- `package.json` (updated) - Dependencies

---

## 🔮 Future Enhancements

### Planned Features

- [ ] Email notification support
- [ ] SMS notification support
- [ ] Generic webhook delivery
- [ ] Recurring/cron-based schedules
- [ ] Web UI dashboard
- [ ] Bulk operations
- [ ] Prometheus metrics
- [ ] Dead letter queue

### Contribution

To add a new notification type:

1. Add to `NotificationType` enum
2. Implement delivery logic in `NotificationScheduler.executeNotification()`
3. Add tests
4. Update documentation

---

## 📚 Additional Resources

- **Full Documentation**: [README-SCHEDULER.md](./README-SCHEDULER.md)
- **Installation Guide**: [INSTALLATION.md](./INSTALLATION.md)
- **Quick Start**: [QUICK-START-SCHEDULER.md](./QUICK-START-SCHEDULER.md)
- **Implementation Details**: [IMPLEMENTATION-SUMMARY.md](./IMPLEMENTATION-SUMMARY.md)
- **Usage Examples**: [src/examples/schedule-notification-example.ts](./src/examples/schedule-notification-example.ts)

---

## ✅ Summary

This scheduled notification system is **production-ready** and provides:

✓ Reliable delivery with catch-up for missed schedules  
✓ Race condition prevention via distributed locking  
✓ Fault tolerance with automatic recovery  
✓ Complete audit logging  
✓ Multi-instance deployment support  
✓ Comprehensive test coverage  
✓ Full documentation

**Ready to install and deploy!** 🚀

---

## 📄 License

Same as parent project.

## 👥 Support

For issues or questions:

1. Check troubleshooting section
2. Review logs and database
3. Open issue on GitHub


## Modifying schedules and recovering overdue notifications

Use `PATCH /api/schedule/:id` to update a pending schedule in place. Send `X-API-Key` and the current schedule version via `If-Match` (or `X-Schedule-Version`). Only the fields supplied in the JSON body are changed; supported fields are `executeAt`, `payload`, `notificationType`, `targetRecipient`, `expiresAt`, `maxRetries`, `priority`, `eventId`, `contractAddress`, and `metadata`. The API returns the updated version and an `ETag`. Non-pending schedules and stale versions return a conflict.

Overdue recovery is configured with `SCHEDULE_RECOVERY_POLICY=EXECUTE|EXPIRE|REQUIRE_INTERVENTION` (default `EXECUTE`). For intervention holds, use `POST /api/schedule/:id/recovery` with `{"action":"EXECUTE"}` or `{"action":"EXPIRE"}` and an API key.
