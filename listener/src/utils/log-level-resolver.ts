/**
 * Configurable Log Level Resolver & Manager (Issue #684)
 *
 * Resolves, validates, and manages application log verbosity levels
 * supporting environment configurations and dynamic runtime level switching.
 */

export const SUPPORTED_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type ValidLogLevel = (typeof SUPPORTED_LOG_LEVELS)[number];

export interface LogLevelResolutionResult {
  level: ValidLogLevel;
  source: 'environment' | 'default_fallback' | 'invalid_fallback';
  rawInput?: string;
  warning?: string;
}

/**
 * Resolves and validates log levels with environment awareness.
 */
export function resolveConfiguredLogLevel(
  rawInput: string | undefined = process.env.LOG_LEVEL,
  nodeEnv: string | undefined = process.env.NODE_ENV
): LogLevelResolutionResult {
  const defaultLevel: ValidLogLevel = nodeEnv === 'production' ? 'info' : 'debug';

  if (!rawInput || rawInput.trim() === '') {
    return {
      level: defaultLevel,
      source: 'default_fallback',
    };
  }

  const normalized = rawInput.trim().toLowerCase();

  if ((SUPPORTED_LOG_LEVELS as readonly string[]).includes(normalized)) {
    return {
      level: normalized as ValidLogLevel,
      source: 'environment',
      rawInput,
    };
  }

  return {
    level: defaultLevel,
    source: 'invalid_fallback',
    rawInput,
    warning: `Invalid LOG_LEVEL "${rawInput}". Allowed levels: ${SUPPORTED_LOG_LEVELS.join(', ')}. Falling back to "${defaultLevel}".`,
  };
}
