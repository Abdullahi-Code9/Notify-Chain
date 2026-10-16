/**
 * Configuration Schema Validation Engine (Issue #694)
 *
 * Provides deterministic, schema-based validation for application environment
 * variables and runtime configurations, precisely identifying failing fields.
 */

export interface ConfigValidationErrorDetail {
  field: string;
  value: unknown;
  message: string;
}

export class ConfigSchemaValidationError extends Error {
  public readonly errors: ConfigValidationErrorDetail[];

  constructor(errors: ConfigValidationErrorDetail[]) {
    const summary = errors.map((e) => `[Field: ${e.field}] ${e.message}`).join('; ');
    super(`Configuration schema validation failed: ${summary}`);
    this.name = 'ConfigSchemaValidationError';
    this.errors = errors;
  }
}

export const ALLOWED_NETWORKS = ['local', 'testnet', 'mainnet', 'standalone'] as const;
export type StellarNetwork = (typeof ALLOWED_NETWORKS)[number];

export const ALLOWED_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

export interface ValidatedAppConfig {
  contractAddresses: string[];
  stellarNetwork: StellarNetwork;
  rpcUrl: string;
  networkPassphrase?: string;
  pollIntervalMs: number;
  logLevel: LogLevel;
  port: number;
  enableAnalytics: boolean;
}

/**
 * Validates a raw environment map against the strict configuration schema.
 */
export function validateConfigSchema(
  rawEnv: Record<string, string | undefined> = process.env
): ValidatedAppConfig {
  const errors: ConfigValidationErrorDetail[] = [];

  // 1. Validate CONTRACT_ADDRESSES (Required, JSON Array of C... addresses)
  let contractAddresses: string[] = [];
  const rawContracts = rawEnv.CONTRACT_ADDRESSES?.trim();

  if (!rawContracts) {
    errors.push({
      field: 'CONTRACT_ADDRESSES',
      value: rawContracts,
      message: 'Required environment variable is missing or empty.',
    });
  } else {
    try {
      const parsed = JSON.parse(rawContracts);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        errors.push({
          field: 'CONTRACT_ADDRESSES',
          value: rawContracts,
          message: 'Must be a non-empty JSON array of contract objects or strings.',
        });
      } else {
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          const address = typeof item === 'object' && item !== null && 'address' in item ? item.address : item;
          if (typeof address !== 'string' || address.length < 50) {
            errors.push({
              field: `CONTRACT_ADDRESSES[${i}]`,
              value: address,
              message: 'Invalid Soroban contract address format (must start with C and be valid StrKey).',
            });
          } else {
            contractAddresses.push(address);
          }
        }
      }
    } catch {
      errors.push({
        field: 'CONTRACT_ADDRESSES',
        value: rawContracts,
        message: 'Must be a valid JSON-encoded string array.',
      });
    }
  }

  // 2. Validate STELLAR_NETWORK (Enum)
  const rawNetwork = (rawEnv.STELLAR_NETWORK?.trim().toLowerCase() || 'testnet') as StellarNetwork;
  if (!ALLOWED_NETWORKS.includes(rawNetwork)) {
    errors.push({
      field: 'STELLAR_NETWORK',
      value: rawEnv.STELLAR_NETWORK,
      message: `Invalid network. Allowed values: ${ALLOWED_NETWORKS.join(', ')}.`,
    });
  }

  // 3. Validate RPC URL
  const rawRpcUrl = rawEnv.STELLAR_RPC_URL?.trim() || rawEnv.SOROBAN_RPC_URL?.trim() || 'https://soroban-testnet.stellar.org';
  if (!rawRpcUrl.startsWith('http://') && !rawRpcUrl.startsWith('https://')) {
    errors.push({
      field: 'STELLAR_RPC_URL',
      value: rawRpcUrl,
      message: 'Must be a valid HTTP or HTTPS endpoint URL.',
    });
  }

  // 4. Validate POLL_INTERVAL_MS (Numeric Range)
  const rawPoll = rawEnv.POLL_INTERVAL_MS?.trim() || '5000';
  const pollIntervalMs = parseInt(rawPoll, 10);
  if (isNaN(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 3600000) {
    errors.push({
      field: 'POLL_INTERVAL_MS',
      value: rawPoll,
      message: 'Must be an integer between 100ms and 3,600,000ms (1 hour).',
    });
  }

  // 5. Validate LOG_LEVEL (Enum)
  const rawLogLevel = (rawEnv.LOG_LEVEL?.trim().toLowerCase() || 'info') as LogLevel;
  if (!ALLOWED_LOG_LEVELS.includes(rawLogLevel)) {
    errors.push({
      field: 'LOG_LEVEL',
      value: rawEnv.LOG_LEVEL,
      message: `Invalid log level. Allowed values: ${ALLOWED_LOG_LEVELS.join(', ')}.`,
    });
  }

  // 6. Validate PORT (Numeric Range)
  const rawPort = rawEnv.PORT?.trim() || '3000';
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push({
      field: 'PORT',
      value: rawPort,
      message: 'Must be a valid TCP port number between 1 and 65535.',
    });
  }

  if (errors.length > 0) {
    throw new ConfigSchemaValidationError(errors);
  }

  return {
    contractAddresses,
    stellarNetwork: rawNetwork,
    rpcUrl: rawRpcUrl,
    networkPassphrase: rawEnv.STELLAR_NETWORK_PASSPHRASE?.trim(),
    pollIntervalMs,
    logLevel: rawLogLevel,
    port,
    enableAnalytics: rawEnv.ENABLE_ANALYTICS !== 'false',
  };
}
