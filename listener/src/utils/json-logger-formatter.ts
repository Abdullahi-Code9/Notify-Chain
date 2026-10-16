/**
 * Structured JSON Log Formatter (Issue #685)
 *
 * Produces deterministic, machine-readable JSON logs for log aggregators
 * (Datadog, CloudWatch, Grafana Loki, Elasticsearch) with automated secret redaction.
 */

import winston from 'winston';
import { redactSensitiveData, redactString } from './redact';

export interface StructuredLogRecord {
  timestamp: string;
  level: string;
  message: string;
  service: string;
  environment: string;
  requestId?: string;
  durationMs?: number;
  error?: Record<string, unknown> | string;
  [key: string]: unknown;
}

export interface JsonFormatterOptions {
  serviceName?: string;
  environment?: string;
}

/**
 * Builds a Winston format function that converts log entries into normalized JSON.
 */
export function createStructuredJsonFormat(options: JsonFormatterOptions = {}) {
  const service = options.serviceName || process.env.SERVICE_NAME || 'notify-chain';
  const environment = options.environment || process.env.NODE_ENV || 'development';

  return winston.format.printf((info) => {
    const { level, message, timestamp, requestId, durationMs, error, ...rest } = info;

    // Sanitize message string
    const sanitizedMessage = typeof message === 'string' ? redactString(message) : String(message);

    // Sanitize extra metadata
    const sanitizedMetadata = redactSensitiveData(rest) as Record<string, unknown>;

    const record: StructuredLogRecord = {
      timestamp: (timestamp as string) || new Date().toISOString(),
      level,
      message: sanitizedMessage,
      service,
      environment,
      ...(requestId ? { requestId: String(requestId) } : {}),
      ...(durationMs !== undefined ? { durationMs: Number(durationMs) } : {}),
      ...(error ? { error: redactSensitiveData(error) as Record<string, unknown> } : {}),
      ...sanitizedMetadata,
    };

    return JSON.stringify(record);
  });
}

/**
 * Determines whether structured JSON logging should be enabled.
 */
export function isJsonLoggingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.STRUCTURED_LOGGING === 'true' || env.LOG_FORMAT === 'json') {
    return true;
  }
  if (env.NODE_ENV === 'production' && env.STRUCTURED_LOGGING !== 'false') {
    return true;
  }
  return false;
}
