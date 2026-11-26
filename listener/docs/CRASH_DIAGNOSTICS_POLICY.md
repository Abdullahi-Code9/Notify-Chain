# Safe production crash diagnostics policy (#1262)

- Structured logs pass through the central redaction engine; secret-bearing keys and values are replaced with `[REDACTED]`.
- Unhandled API errors are logged as redacted error summaries. Production responses use a generic message and never include `error.message`, stacks, or raw `details`.
- `uncaughtException` and `unhandledRejection` handlers log a redacted `{ name, message }` summary. Stacks and cause chains are omitted when `NODE_ENV=production`.
- Configuration objects are never serialised into crash output; only non-secret diagnostic snapshots are permitted, and secret presence is reported as a boolean.
- Any new diagnostic field must be reviewed against this policy before being logged.
