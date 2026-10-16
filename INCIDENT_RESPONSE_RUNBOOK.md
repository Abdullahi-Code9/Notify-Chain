# NotifyChain Incident Response Runbook

This runbook defines how maintainers respond to production incidents affecting NotifyChain listener, scheduler, dashboard, and contract-facing operations.

## Severity Levels

| Severity | Definition | Examples | Initial Response Target |
|----------|------------|----------|-------------------------|
| SEV1 | Complete production outage or user-impacting data loss risk | Listener cannot ingest events, scheduler cannot dispatch due notifications, contract integration is unusable | 15 minutes |
| SEV2 | Major degradation with available workaround | Retry queue backing up, Discord delivery failing for many recipients, API 500 rate elevated | 30 minutes |
| SEV3 | Partial degradation or isolated customer impact | One endpoint failing, delayed metrics, single integration misconfigured | 1 business hour |
| SEV4 | Low-impact operational issue | Documentation mismatch, non-critical alert, cosmetic dashboard issue | 1 business day |

## Roles

| Role | Responsibilities |
|------|------------------|
| Incident Commander | Owns coordination, severity, timeline, and final resolution call. |
| Technical Lead | Investigates root cause, directs fixes, and validates recovery. |
| Communications Lead | Sends internal and external updates. |
| Scribe | Records timeline, commands, decisions, and follow-up items. |

For small incidents one maintainer may hold multiple roles, but the incident commander should still be explicit.

## Response Procedure

1. Acknowledge the alert or report in the incident channel.
2. Assign severity and roles.
3. Create or update an incident tracking issue.
4. Confirm current blast radius:
   - Check `/health` and indexing health endpoints.
   - Check listener logs for request IDs and correlation IDs.
   - Check scheduler stats and overdue scheduled notifications.
   - Check `notification_execution_log` for recent `FAILED` or repeated `RETRY` rows.
   - Check rate-limit, archive, template, and analytics dependencies when affected.
5. Stabilize the system:
   - Roll back the last risky deploy if symptoms began immediately after release.
   - Pause high-volume jobs if they are amplifying failures.
   - Recover stale scheduler locks if dispatchers crashed.
   - Increase worker capacity only after confirming the backing service is healthy.
   - For suspected database corruption, accidental deletion, or data loss, follow [Database Backup and Restore](docs/DATABASE_BACKUP_RESTORE.md) and restore the newest verified backup.
6. Communicate status using the templates below.
7. Verify recovery with user-visible checks and relevant tests.
8. Downgrade or resolve the incident.
9. Schedule a postmortem for SEV1 and SEV2 incidents.

## Scheduler And Retry Checks

Use these checks when scheduled notifications are late, missing, or retrying unexpectedly.

```sql
SELECT status, COUNT(*) AS count
FROM scheduled_notifications
GROUP BY status;
```

```sql
SELECT id, execute_at, retry_count, max_retries, next_retry_at, last_error
FROM scheduled_notifications
WHERE status IN ('PENDING', 'PROCESSING')
ORDER BY execute_at ASC
LIMIT 20;
```

```sql
SELECT scheduled_notification_id, execution_attempt, status, error_message, execution_time
FROM notification_execution_log
ORDER BY execution_time DESC
LIMIT 50;
```

Recovery guidance:

| Symptom | Action |
|---------|--------|
| Many `PROCESSING` rows have expired locks | Restart the listener or run the scheduler so stale-lock recovery returns rows to `PENDING`. |
| `PENDING` rows are overdue but not dispatched | Confirm scheduler is enabled, poll interval is sane, and worker shutdown is not in progress. |
| Rows retry immediately too often | Check `next_retry_at` and retry scheduler config (`baseDelayMs`, `multiplier`, `maxDelayMs`, `jitter`). |
| Rows hit `FAILED` quickly | Compare `retry_count` with `max_retries` and inspect `last_error` for permanent validation or configuration errors. |

## Communication Templates

### Initial Internal Update

```text
Incident opened: <SEV> - <short title>
Impact: <who/what is affected>
Started: <UTC timestamp>
Commander: <name>
Current hypothesis: <brief>
Next update: <time>
```

### External Status Update

```text
We are investigating an issue affecting <component>. Some users may experience <impact>. We will provide another update by <time>.
```

### Mitigation Update

```text
We have identified the cause as <cause> and applied <mitigation>. We are monitoring recovery and will confirm once service is stable.
```

### Resolution Update

```text
The issue affecting <component> has been resolved as of <UTC timestamp>. Impact was <summary>. We will publish follow-up actions after review.
```

## Resolution Criteria

An incident can be resolved when:

1. The user-facing symptom is no longer occurring.
2. Relevant health checks are green.
3. Queue backlog is draining or back to normal.
4. No new related errors are appearing in logs for at least one monitoring window.
5. The incident commander and technical lead agree recovery is stable.

## Postmortem Checklist

Complete this checklist for all SEV1 and SEV2 incidents.

- [ ] Timeline includes detection, acknowledgement, mitigation, and resolution timestamps.
- [ ] Customer impact is quantified.
- [ ] Root cause is stated without blame.
- [ ] Triggering condition is identified.
- [ ] Detection gaps are documented.
- [ ] Prevention actions have owners and due dates.
- [ ] Tests, alerts, docs, or runbooks are updated where needed.
- [ ] Follow-up issue links are added to the incident record.
- [ ] Final summary is shared with maintainers and affected stakeholders.

## Postmortem Template

```markdown
# Postmortem: <Incident Title>

Date:
Severity:
Status:
Incident Commander:
Technical Lead:

## Summary

## Impact

## Timeline

## Root Cause

## What Went Well

## What Went Poorly

## Where We Got Lucky

## Corrective Actions

| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|

## Follow-up Links
```
