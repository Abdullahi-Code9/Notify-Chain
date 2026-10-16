/**
 * Integration tests for startup configuration validation (issue #494).
 * 
 * These tests verify that invalid listener configuration is detected
 * BEFORE blockchain event processing begins, and that multiple configuration
 * errors are reported together to avoid fix-and-restart cycles.
 */

import { loadConfig, validateConfig, ConfigError } from '../config';

describe('Startup Configuration Validation Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Default valid config to isolate each test
    process.env.CONTRACT_ADDRESSES = JSON.stringify([
      { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] }
    ]);
    process.env.DATABASE_PATH = ':memory:'; // Use in-memory DB for tests
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Valid configuration allows startup', () => {
    it('loads and validates a complete valid configuration without errors', () => {
      process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org:443';
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      process.env.POLL_INTERVAL_MS = '30000';
      process.env.EVENTS_API_PORT = '8787';

      const config = loadConfig();
      
      // This should NOT throw
      expect(() => validateConfig(config)).not.toThrow();

      // Verify critical required config is present
      expect(config.contractAddresses).toHaveLength(1);
      expect(config.stellarRpcUrl).toBe('https://soroban-testnet.stellar.org:443');
      expect(config.pollIntervalMs).toBe(30000);
    });
  });

  describe('Invalid configuration prevents startup', () => {
    it('prevents service instantiation by throwing ConfigError during validation', () => {
      // Set invalid configuration
      process.env.CONTRACT_ADDRESSES = '[]'; // Empty - no contracts to monitor
      process.env.POLL_INTERVAL_MS = '500'; // Too low - would hammer RPC
      
      const config = loadConfig();
      
      // Validation should throw before we even try to start services
      expect(() => validateConfig(config)).toThrow(ConfigError);
      
      // In production index.ts, this prevents EventSubscriber creation:
      // main() catches ConfigError and exits before creating any services
      let serviceCreationAttempted = false;
      try {
        validateConfig(config);
        // This line should never execute due to throw above
        serviceCreationAttempted = true;
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
      }
      
      expect(serviceCreationAttempted).toBe(false);
    });

    it('detects missing required blockchain connection config', () => {
      process.env.STELLAR_RPC_URL = '';
      
      const config = loadConfig();
      config.stellarRpcUrl = ''; // Simulate empty value
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow('STELLAR_RPC_URL');
    });

    it('detects missing database path', () => {
      const config = loadConfig();
      config.databasePath = '';
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow('DATABASE_PATH');
    });
  });

  describe('Multiple configuration errors reported together', () => {
    it('collects and reports all configuration errors in a single message', () => {
      // Set multiple invalid values
      process.env.CONTRACT_ADDRESSES = '[]'; // Empty
      process.env.STELLAR_RPC_URL = 'ftp://invalid'; // Wrong protocol
      process.env.POLL_INTERVAL_MS = '100'; // Too low
      process.env.EVENTS_API_PORT = '99999'; // Out of range
      process.env.MAX_RECONNECT_ATTEMPTS = '0'; // Invalid
      
      const config = loadConfig();
      
      let caughtError: ConfigError | null = null;
      try {
        validateConfig(config);
      } catch (error) {
        caughtError = error as ConfigError;
      }
      
      expect(caughtError).toBeInstanceOf(ConfigError);
      expect(caughtError?.message).toContain('Configuration validation failed with');
      
      // All errors should be present in the message
      expect(caughtError?.message).toContain('CONTRACT_ADDRESSES is empty');
      expect(caughtError?.message).toContain('STELLAR_RPC_URL');
      expect(caughtError?.message).toContain('POLL_INTERVAL_MS');
      expect(caughtError?.message).toContain('EVENTS_API_PORT');
      expect(caughtError?.message).toContain('MAX_RECONNECT_ATTEMPTS');
    });

    it('reports exact count of validation errors', () => {
      // Set exactly 3 invalid values
      process.env.POLL_INTERVAL_MS = '500'; // Too low
      process.env.EVENTS_API_PORT = '70000'; // Out of range  
      process.env.MAX_RECONNECT_ATTEMPTS = '-1'; // Negative
      
      const config = loadConfig();
      
      try {
        validateConfig(config);
        fail('Should have thrown ConfigError');
      } catch (error) {
        if (error instanceof ConfigError) {
          expect(error.message).toContain('Configuration validation failed with 3 error(s)');
        } else {
          throw error;
        }
      }
    });
  });

  describe('Validation prevents event processing', () => {
    it('ensures invalid config is caught before any service initialization', () => {
      // Simulate the startup flow from index.ts
      process.env.CONTRACT_ADDRESSES = '[]';
      
      const config = loadConfig();
      
      // Step 1: Validation should fail
      expect(() => validateConfig(config)).toThrow(ConfigError);
      
      // Step 2: Any subsequent service initialization should never be reached
      // In the real startup flow (index.ts), ConfigError is caught and process exits
      let serviceInitAttempted = false;
      try {
        validateConfig(config);
        // This should not execute due to throw above
        serviceInitAttempted = true;
        // In real code: await initializeDatabase(), new EventSubscriber(), etc.
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(serviceInitAttempted).toBe(false);
      }
    });
  });

  describe('Specific listener configuration requirements', () => {
    it('requires at least one contract address to monitor', () => {
      process.env.CONTRACT_ADDRESSES = '[]';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'CONTRACT_ADDRESSES is empty. The listener requires at least one contract to monitor'
      );
    });

    it('validates contract address format for Stellar contracts', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'GXXXXX', events: ['*'] } // Wrong prefix for contracts
      ]);
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        "must start with 'C' for Stellar contracts"
      );
    });

    it('validates contract address is exactly 56 characters', () => {
      process.env.CONTRACT_ADDRESSES = JSON.stringify([
        { address: 'CSHORT', events: ['*'] }
      ]);
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'must be exactly 56 characters'
      );
    });

    it('validates RPC URL is reachable format', () => {
      process.env.STELLAR_RPC_URL = 'not-a-valid-url';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow('STELLAR_RPC_URL is not a valid URL');
    });

    it('validates network passphrase matches known Stellar networks', () => {
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Custom Wrong Network';
      process.env.STELLAR_NETWORK = 'testnet';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'STELLAR_NETWORK_PASSPHRASE does not match known Stellar networks'
      );
    });

    it('accepts valid testnet passphrase', () => {
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts valid mainnet passphrase', () => {
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('validates polling interval is not too aggressive', () => {
      process.env.POLL_INTERVAL_MS = '999'; // Less than 1 second
      
      const config = loadConfig();
      
      expect(() => validateConfig(config)).toThrow(ConfigError);
      expect(() => validateConfig(config)).toThrow(
        'POLL_INTERVAL_MS must be at least 1000 ms to avoid excessive RPC load'
      );
    });
  });
});
