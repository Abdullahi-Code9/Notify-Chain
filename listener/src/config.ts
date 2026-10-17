import {
  Config,
  ContractConfig,
  DiscordConfig,
  WebhookSecret,
  AppCleanupConfig,
  EventQueueConfig,
  RetrySchedulerOptions,
  RetryPolicyOptions,
  AnalyticsConfig,
  ExpirationConfig,
  ApiKey,
  BackfillConfig,
  LoggingConfig,
  ApiConfig,
  RpcRateLimitConfig,
  RpcFallbackConfig,
  EventBatchingConfig,
  DigestConfig,
  LocalizationConfig,
} from './types';
import { validateCorsOrigin, CorsValidationError } from './utils/cors-validator';
import { validateSecrets } from './config/validate-secrets';
import { ConfigurationSchemaValidator, APP_CONFIG_SCHEMA } from './config-schema';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './i18n';
import {
  RetryFailureType,
  RETRY_FAILURE_TYPES,
  DEFAULT_RETRYABLE_FAILURE_TYPES,
  parseRetryableFailureTypes,
} from './services/retry-policy';
import type { CircuitBreakerConfig } from './services/circuit-breaker';
import {
  SUPPORTED_LOG_FORMATS,
  SUPPORTED_LOG_LEVELS,
  parseLogFormat,
  parseLogLevel,
} from './utils/logger';
import { DEFAULT_MAX_BODY_BYTES } from './middleware/body-limit';
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  MAX_WEBHOOK_TIMEOUT_MS,
} from './services/webhook-delivery-service';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

// Environment variables the listener cannot safely start without.
// Keep this list in sync with the "Required" column in
// ENVIRONMENT_VARIABLES_AND_SECRETS.md.
const REQUIRED_ENV_VARS = ['CONTRACT_ADDRESSES'];

function validateRequiredEnvVars(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !trimEnv(name));

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env and set them before starting the listener.',
    );
  }
}

function parseIntegerEnv(name: string, defaultValue: string): number {
  const rawValue = trimEnv(name);
  const value = rawValue !== undefined ? rawValue : defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`${name} must be a valid integer, got "${value}"`);
  }
  return parsed;
}

function loadNotificationDefaultTtlSeconds(): number {
  const rawValue = trimEnv('NOTIFICATION_DEFAULT_TTL_SECONDS') ?? '0';
  if (!/^\d+$/.test(rawValue)) {
    throw new ConfigError('NOTIFICATION_DEFAULT_TTL_SECONDS must be a non-negative integer');
  }
  const seconds = Number(rawValue);
  if (!Number.isSafeInteger(seconds) || seconds > Math.floor(8.64e15 / 1000)) {
    throw new ConfigError('NOTIFICATION_DEFAULT_TTL_SECONDS must be a supported non-negative integer');
  }
  return seconds;
}

function parseStrictIntegerEnv(name: string, defaultValue: string): number {
  const rawValue = trimEnv(name);