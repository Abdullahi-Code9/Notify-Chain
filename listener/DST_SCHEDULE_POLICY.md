# Daylight-saving schedule policy

Timezone-based schedules use a local wall time (`localDateTime`) plus an IANA
timezone (`timeZone`). `POST /api/schedule` accepts those fields in place of
an absolute `executeAt`. Optional `recurrence` is `daily` or `weekly`.

| Local situation | What NotifyChain does |
| --- | --- |
| The wall time exists once | Schedule that UTC instant (`unique`). |
| The wall time is skipped because clocks jump forward | Move the wall time forward by the length of that zone's gap, then schedule that valid instant (`skipped`). `America/New_York` `2026-03-08T02:30:00` runs at `03:30` EDT (`2026-03-08T07:30:00.000Z`). A 30-minute gap is not rounded up to an hour: `Australia/Lord_Howe` `2026-10-04T02:15:00` runs at `02:45` (`2026-10-03T15:45:00.000Z`). |
| The wall time happens twice because clocks fall back | Schedule the earlier instant (`repeated`). `America/New_York` `2026-11-01T01:30:00` runs at `2026-11-01T05:30:00.000Z` (EDT), not the later EST reading. |

Daily and weekly recurrence advances the requested local calendar date, then
applies the same rules. A 02:30 schedule that was shifted to 03:30 on the
spring-forward day returns to 02:30 on the next local date.

The resolver lives in `listener/src/services/local-schedule.ts`.
