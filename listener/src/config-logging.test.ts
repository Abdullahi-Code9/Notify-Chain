/**
 * Configuration of log verbosity, log format and the request-size limit.
 *
 * These go through the same loadConfig/validateConfig mechanism as every other
 * setting, so an operator changes them the same way they change anything else
 * — and a typo is caught at startup rather than silently ignored.
 */

import { loadConfig, validateConfig, ConfigError } from './config';

/** A well-formed 56-character contract address, so the shared required-env
 *  check passes and these tests fail only on the fields they are about. */
const TEST_CONTRACT_ADDRESS = `C${'A'.repeat(55)}`;

const BASE_ENV: Record<string, string> = {
  CONTRACT_ADDRESSES: `[{"address":"${TEST_CONTRACT_ADDRESS}","events":["notify"]}]`,
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LOG_') || key.startsWith('API_MAX_')) delete process.env[key];
    }
    Object.assign(process.env, BASE_ENV);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    process.env = saved;
  }
}

// ── Log level ───────────────────────────────────────────────────────────────

describe('LOG_LEVEL configuration', () => {
  it.each(['error', 'warn', 'info', 'debug'])('accepts %s', (level) => {
    withEnv({ LOG_LEVEL: level }, () => {
      const config = loadConfig();
      expect(config.logging?.level).toBe(level);
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  it('defaults to info when unset', () => {
    // Production default stays conservative: info, not debug.
    withEnv({ LOG_LEVEL: undefined }, () => {
      expect(loadConfig().logging?.level).toBe('info');
    });
  });

  it('rejects an unrecognised level instead of silently downgrading', () => {
    // A typo that quietly resolves to "info" hides the debug output the
    // operator asked for, with no signal that the setting did not take.
    withEnv({ LOG_LEVEL: 'verbose' }, () => {
      const config = loadConfig();
      expect(() => validateConfig(config)).toThrow(ConfigError);
    });
  });

  it('names the supported levels in the rejection message', () => {
    withEnv({ LOG_LEVEL: 'trace' }, () => {
      try {
        validateConfig(loadConfig());
        throw new Error('expected validateConfig to throw');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('LOG_LEVEL');
        expect(message).toContain('debug');
        expect(message).toContain('trace');
      }
    });
  });
});

// ── Log format ──────────────────────────────────────────────────────────────

describe('LOG_FORMAT configuration', () => {
  it('accepts json', () => {
    withEnv({ LOG_FORMAT: 'json' }, () => {
      const config = loadConfig();
      expect(config.logging?.format).toBe('json');
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  it('accepts pretty', () => {
    withEnv({ LOG_FORMAT: 'pretty' }, () => {
      expect(loadConfig().logging?.format).toBe('pretty');
    });
  });

  it('enables JSON in a non-production environment when asked', () => {
    // The point of making this configurable: reproducing an aggregator
    // problem locally should not require pretending to be production.
    withEnv({ LOG_FORMAT: 'json', NODE_ENV: 'development' }, () => {
      expect(loadConfig().logging?.format).toBe('json');
    });
  });

  it('preserves the previous environment-based default when unset', () => {
    withEnv({ LOG_FORMAT: undefined, NODE_ENV: 'production' }, () => {
      expect(loadConfig().logging?.format).toBe('json');
    });
    withEnv({ LOG_FORMAT: undefined, NODE_ENV: 'development' }, () => {
      expect(loadConfig().logging?.format).toBe('pretty');
    });
  });

  it('rejects an unrecognised format', () => {
    withEnv({ LOG_FORMAT: 'logfmt' }, () => {
      expect(() => validateConfig(loadConfig())).toThrow(ConfigError);
    });
  });
});

// ── Request size limit ──────────────────────────────────────────────────────

describe('API_MAX_BODY_BYTES configuration', () => {
  it('defaults to 1 MiB', () => {
    withEnv({ API_MAX_BODY_BYTES: undefined }, () => {
      expect(loadConfig().api?.maxBodyBytes).toBe(1_048_576);
    });
  });

  it('accepts an explicit limit', () => {
    withEnv({ API_MAX_BODY_BYTES: '65536' }, () => {
      const config = loadConfig();
      expect(config.api?.maxBodyBytes).toBe(65_536);
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  it('rejects a non-positive limit', () => {
    // Zero would refuse every request with a body; negative is meaningless.
    withEnv({ API_MAX_BODY_BYTES: '0' }, () => {
      expect(() => validateConfig(loadConfig())).toThrow(ConfigError);
    });
    withEnv({ API_MAX_BODY_BYTES: '-1' }, () => {
      expect(() => validateConfig(loadConfig())).toThrow(ConfigError);
    });
  });

  it('rejects a non-numeric limit at load time', () => {
    withEnv({ API_MAX_BODY_BYTES: 'huge' }, () => {
      expect(() => loadConfig()).toThrow(ConfigError);
    });
  });
});

// ── Combined reporting ──────────────────────────────────────────────────────

describe('validation reporting', () => {
  it('reports every bad value at once rather than one per restart', () => {
    withEnv({ LOG_LEVEL: 'nope', LOG_FORMAT: 'nope', API_MAX_BODY_BYTES: '0' }, () => {
      try {
        validateConfig(loadConfig());
        throw new Error('expected validateConfig to throw');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('LOG_LEVEL');
        expect(message).toContain('LOG_FORMAT');
        expect(message).toContain('API_MAX_BODY_BYTES');
      }
    });
  });
});
