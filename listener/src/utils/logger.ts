import winston from 'winston';
import {
  REDACTED_PLACEHOLDER,
  isSensitiveKey as isSensitiveKeyName,
  redactObject,
  redactString,
} from './redact';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormattedError {
  message: string;
  name: string;
  stack?: string;
  cause?: FormattedError | string;
}

/** Structured context fields that can be attached to any log call. */
export interface LogContext {
  /** Identifier scoped to a single poll/request cycle for end-to-end tracing. */
  requestId?: string;
  /** Elapsed milliseconds for timed operations (RPC calls, webhook delivery, etc.). */
  durationMs?: number;
  /** Any additional structured fields the caller wants to attach. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Log-level helpers
// ---------------------------------------------------------------------------

const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

/**
 * Validate and normalize a raw LOG_LEVEL string.
 * Falls back to `"info"` when the value is absent or unrecognised so the
 * service never crashes on a misconfigured environment.
 */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  const normalised = raw?.trim().toLowerCase();
  if (normalised && (VALID_LOG_LEVELS as readonly string[]).includes(normalised)) {
    return normalised as LogLevel;
  }
  return 'info';
}

/** The log levels this service accepts, in decreasing severity. */
export const SUPPORTED_LOG_LEVELS: readonly LogLevel[] = VALID_LOG_LEVELS;

/**
 * Strict counterpart to {@link resolveLogLevel}: returns null instead of
 * silently downgrading an unrecognised value.
 *
 * `resolveLogLevel` deliberately never throws, so a bad value cannot crash a
 * running process. But a *misconfigured deployment* should be caught at
 * startup rather than quietly running at the wrong verbosity, so config
 * validation uses this and rejects.
 */
export function parseLogLevel(raw: string | undefined): LogLevel | null {
  const normalised = raw?.trim().toLowerCase();
  if (!normalised) return null;
  return (VALID_LOG_LEVELS as readonly string[]).includes(normalised)
    ? (normalised as LogLevel)
    : null;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

const VALID_LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof VALID_LOG_FORMATS)[number];

/** The log output formats this service accepts. */
export const SUPPORTED_LOG_FORMATS: readonly LogFormat[] = VALID_LOG_FORMATS;

/** Strict parse of a raw LOG_FORMAT value; null when unrecognised. */
export function parseLogFormat(raw: string | undefined): LogFormat | null {
  const normalised = raw?.trim().toLowerCase();
  if (!normalised) return null;
  return (VALID_LOG_FORMATS as readonly string[]).includes(normalised)
    ? (normalised as LogFormat)
    : null;
}

/**
 * Resolves the active output format.
 *
 * An explicit `LOG_FORMAT` always wins, so JSON can be switched on in any
 * environment — reproducing an aggregator problem locally no longer requires
 * pretending to be production. With nothing set the previous behaviour is
 * preserved: JSON in production, human-readable elsewhere.
 */
export function resolveLogFormat(
  rawFormat: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): LogFormat {
  return parseLogFormat(rawFormat) ?? (nodeEnv === 'production' ? 'json' : 'pretty');
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

export { REDACTED_PLACEHOLDER };

/**
 * True when a field name looks like it carries a credential.
 *
 * Delegates to the single sensitive-key policy in `./redact` (SENSITIVE_KEYS)
 * so the logger, URL sanitiser and redaction engine can never drift apart.
 */
export function isSensitiveKey(key: string): boolean {
  return isSensitiveKeyName(key);
}

/**
 * Recursively replaces credential-looking values with a placeholder.
 *
 * Redaction runs on the way *into* the logger rather than being left to each
 * caller: a secret only has to be forgotten once to sit permanently in an
 * aggregator, and the caller is the party most likely to forget.
 *
 * Depth is bounded so a deeply nested or cyclic object cannot hang the logging
 * path — logging must never be the thing that takes the service down.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    // Errors are handled by formatError and carry no fields worth redacting.
    if (value instanceof Error) return value;

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key)
        ? REDACTED_PLACEHOLDER
        : redactSensitive(item, depth + 1);
    }
    return output;
  }

  return value;
}

/**
 * Strips credentials out of a URL before it is logged.
 *
 * Request paths reach the logs verbatim and query strings routinely carry
 * `?token=` or `?api_key=`. The path is what makes a log line useful for
 * finding a slow endpoint; the parameter values are not.
 */
export function sanitizeUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return rawUrl;

  const path = rawUrl.slice(0, queryStart);
  const params = new URLSearchParams(rawUrl.slice(queryStart + 1));

  // Assembled by hand rather than via URLSearchParams.toString(), which would
  // percent-encode the placeholder into `%5BREDACTED%5D` — still redacted, but
  // no longer greppable in a log aggregator, which is the whole point of using
  // a fixed marker.
  const parts: string[] = [];
  for (const [key, value] of params) {
    parts.push(
      isSensitiveKey(key)
        ? `${encodeURIComponent(key)}=${REDACTED_PLACEHOLDER}`
        : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    );
  }

  return parts.length > 0 ? `${path}?${parts.join('&')}` : path;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Normalize unknown thrown values into a structured object for logging.
 * Error instances are expanded into `{ message, name, stack?, cause? }`.
 * Non-Error objects are JSON-stringified; primitives are coerced to string.
 */
export function formatError(error: unknown): FormattedError | string {
  if (error instanceof Error) {
    const formatted: FormattedError = {
      message: error.message,
      name: error.name,
    };

    if (error.stack) {
      formatted.stack = error.stack;
    }

    if ('cause' in error && error.cause !== undefined) {
      formatted.cause = formatError(error.cause);
    }

    return formatted;
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the `error` field inside a meta object and then redact all
 * sensitive fields so no credentials reach any log transport.
 *
 * The pipeline:
 *   1. Expand `error` (if present) using `formatError`.
 *   2. Redact sensitive keys / URL credentials / auth headers via the
 *      centralized redaction engine (`redactObject`).
 */
function formatMeta(meta: LogContext): LogContext {
  const normalized =
    'error' in meta && meta.error !== undefined
      ? { ...meta, error: formatError(meta.error) }
      : meta;

  // Redact sensitive fields before any transport receives the object. The
  // formatted error is walked too, so secrets in error messages/stacks (e.g.
  // a webhook URL in a fetch failure) are masked as well.
  return redactObject(normalized as Record<string, unknown>) as LogContext;
}

function logWithMeta(
  level: LogLevel,
  message: string,
  meta?: LogContext
): void {
  // The message itself is redacted too: interpolated strings such as
  // `Posting to ${webhookUrl}` would otherwise bypass metadata redaction.
  const safeMessage = typeof message === 'string' ? redactString(message) : message;
  if (meta && Object.keys(meta).length > 0) {
    baseLogger[level](safeMessage, formatMeta(meta));
  } else {
    baseLogger[level](safeMessage);
  }
}

// ---------------------------------------------------------------------------
// Winston instance
// ---------------------------------------------------------------------------

/**
 * Structured logger for the notification pipeline.
 *
 * All log entries include:
 *   - timestamp  – ISO 8601 timestamp (added automatically)
 *   - level      – log severity: `error | warn | info | debug`
 *   - message    – human-readable description of the event
 *
 * Recommended optional fields (see LogContext):
 *   - requestId  – identifier scoped to a single poll/request cycle
 *   - durationMs – elapsed time for timed operations
 *
 * **Configuration**
 * Set `LOG_LEVEL` to `debug | info | warn | error` to control verbosity
 * (default: `"info"`). Invalid values are silently downgraded to `"info"`.
 *
 * In development (`NODE_ENV` ≠ `"production"`) logs use a colorised
 * single-line format. In production they emit newline-delimited JSON suitable
 * for log aggregators (Datadog, CloudWatch, Loki, etc.).
 */
const baseLogger = winston.createLogger({
  level: resolveLogLevel(process.env.LOG_LEVEL),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: buildConsoleFormat(resolveLogFormat(process.env.LOG_FORMAT)),
    }),
  ],
});

/**
 * Builds the console formatter for a given output format.
 *
 * `json` emits newline-delimited JSON with a stable field set — `timestamp`,
 * `level`, `message`, plus whatever structured context the call site attached
 * — which is what a log aggregator needs to index consistently. `pretty` is
 * the colourised single-line form for a human reading a terminal.
 */
function buildConsoleFormat(format: LogFormat): winston.Logform.Format {
  if (format === 'json') {
    return winston.format.json();
  }

  return winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} ${level}: ${message}${metaStr}`;
    })
  );
}

// ---------------------------------------------------------------------------
// Public logger API
// ---------------------------------------------------------------------------

/**
 * Application-wide structured logger.
 *
 * Usage:
 * ```ts
 * import logger from '../utils/logger';
 *
 * logger.info('Poll cycle complete', { requestId, durationMs });
 * logger.error('Delivery failed',   { requestId, error });
 * logger.warn('Payload invalid',    { requestId, reason });
 * logger.debug('Raw RPC response',  { requestId, payload });
 * ```
 */
const logger = {
  debug: (message: string, meta?: LogContext) => logWithMeta('debug', message, meta),
  info:  (message: string, meta?: LogContext) => logWithMeta('info',  message, meta),
  warn:  (message: string, meta?: LogContext) => logWithMeta('warn',  message, meta),
  error: (message: string, meta?: LogContext) => logWithMeta('error', message, meta),
};

export default logger;

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Create a log-context object pre-populated with a `requestId`.
 * Thread this through all log calls within a single poll/request cycle so
 * every line can be correlated end-to-end:
 *
 * ```ts
 * const ctx = createRequestContext(requestId);
 * logger.info('Starting poll', ctx);
 * logger.info('Events received', { ...ctx, count: events.length });
 * logger.error('Delivery failed', { ...ctx, error });
 * ```
 */
export function createRequestContext(requestId: string): LogContext {
  return { requestId };
}

/**
 * Reconfigure the underlying Winston logger's active level at runtime.
 * Accepts the same values as the `LOG_LEVEL` env variable; invalid values
 * fall back to `"info"` without throwing.
 *
 * Primarily useful in tests or when hot-reloading config:
 * ```ts
 * configureLogger({ level: 'debug' });
 * ```
 */
export function configureLogger(options: { level?: string; format?: string }): void {
  if (options.level !== undefined) {
    baseLogger.level = resolveLogLevel(options.level);
  }

  if (options.format !== undefined) {
    const format = resolveLogFormat(options.format);
    for (const transport of baseLogger.transports) {
      transport.format = buildConsoleFormat(format);
    }
  }
}
