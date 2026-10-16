/**
 * Diagnostic Configuration Snapshot Utility (Issue #695)
 *
 * Produces a sanitized, security-hardened snapshot of runtime settings
 * and environment configurations for operator diagnostics and troubleshooting.
 */

import { redactSensitiveData, redactString } from './redact';

export interface DiagnosticConfigSnapshot {
  system: {
    nodeEnv: string;
    nodeVersion: string;
    uptimeSeconds: number;
    timestamp: string;
  };
  network: {
    networkPassphrase: string;
    rpcUrl: string;
    pollIntervalMs: number;
    horizonUrl?: string;
  };
  contracts: {
    configuredCount: number;
    addresses: string[];
  };
  features: {
    analyticsEnabled: boolean;
    retrySchedulerEnabled: boolean;
    cleanupEnabled: boolean;
    deadLetterQueueEnabled: boolean;
  };
  providers: {
    discordEnabled: boolean;
    webhookEnabled: boolean;
  };
  security: {
    credentialsRedacted: boolean;
    secretsPresent: boolean;
  };
}

/**
 * Creates a sanitized diagnostic configuration representation.
 * All sensitive values, credentials, and API keys are strictly redacted.
 */
export function createDiagnosticSnapshot(
  customEnv: Record<string, string | undefined> = process.env
): DiagnosticConfigSnapshot {
  const nodeEnv = customEnv.NODE_ENV || 'development';
  const rpcUrl = customEnv.STELLAR_RPC_URL || customEnv.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const passphrase = customEnv.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
  const pollIntervalMs = parseInt(customEnv.POLL_INTERVAL_MS || '5000', 10);

  // Parse configured contract addresses safely
  let contractAddresses: string[] = [];
  try {
    const rawContracts = customEnv.CONTRACT_ADDRESSES;
    if (rawContracts) {
      const parsed = JSON.parse(rawContracts);
      if (Array.isArray(parsed)) {
        contractAddresses = parsed.map((c) => (typeof c === 'object' && c?.address ? c.address : String(c)));
      }
    }
  } catch {
    // If parse fails, fallback safely
  }

  const hasDiscord = Boolean(customEnv.DISCORD_WEBHOOK_URL);
  const hasSecrets = Boolean(
    customEnv.STELLAR_SECRET_KEY ||
    customEnv.API_KEYS ||
    customEnv.JWT_SECRET ||
    customEnv.DISCORD_WEBHOOK_URL
  );

  return {
    system: {
      nodeEnv,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime ? process.uptime() : 0),
      timestamp: new Date().toISOString(),
    },
    network: {
      networkPassphrase: redactString(passphrase),
      rpcUrl: redactString(rpcUrl),
      pollIntervalMs: isNaN(pollIntervalMs) ? 5000 : pollIntervalMs,
      horizonUrl: customEnv.HORIZON_URL ? redactString(customEnv.HORIZON_URL) : undefined,
    },
    contracts: {
      configuredCount: contractAddresses.length,
      addresses: contractAddresses,
    },
    features: {
      analyticsEnabled: customEnv.ENABLE_ANALYTICS !== 'false',
      retrySchedulerEnabled: customEnv.ENABLE_RETRY_SCHEDULER !== 'false',
      cleanupEnabled: customEnv.ENABLE_CLEANUP !== 'false',
      deadLetterQueueEnabled: customEnv.ENABLE_DLQ !== 'false',
    },
    providers: {
      discordEnabled: hasDiscord,
      webhookEnabled: Boolean(customEnv.WEBHOOK_SECRET || customEnv.WEBHOOK_URL),
    },
    security: {
      credentialsRedacted: true,
      secretsPresent: hasSecrets,
    },
  };
}
