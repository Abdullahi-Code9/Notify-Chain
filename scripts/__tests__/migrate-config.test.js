/**
 * Tests for migrate-config.js — deterministic config migration (#1050)
 *
 * Uses Node's built-in test runner (node:test) and assert module.
 * Run with: node --test scripts/__tests__/migrate-config.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';

// Import helpers directly from the migration module
import {
  parseEnvFile,
  validateV1,
  migrateConfig,
  serializeEnv,
} from '../migrate-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATE_SCRIPT = path.resolve(__dirname, '..', 'migrate-config.js');

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Write content to a temp file and return its path. */
function writeTempFile(content) {
  const tmpFile = path.join(os.tmpdir(), `notify-chain-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(tmpFile, content, 'utf8');
  return tmpFile;
}

/** Minimal valid v1 config content (all required keys present). */
const VALID_V1_CONTENT = `
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK=testnet
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
CONTRACT_ADDRESSES=[{"address":"CXXX"}]
LOG_LEVEL=info
`.trim();

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  test('parses KEY=VALUE lines', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux');
    assert.deepEqual(result, { FOO: 'bar', BAZ: 'qux' });
  });

  test('ignores comment lines and blank lines', () => {
    const result = parseEnvFile('# comment\n\nFOO=bar\n\n# another\nBAZ=qux');
    assert.deepEqual(result, { FOO: 'bar', BAZ: 'qux' });
  });

  test('handles empty values', () => {
    const result = parseEnvFile('FOO=');
    assert.deepEqual(result, { FOO: '' });
  });

  test('handles values containing equals signs', () => {
    const result = parseEnvFile('URL=https://example.com?a=1&b=2');
    assert.deepEqual(result, { URL: 'https://example.com?a=1&b=2' });
  });
});

describe('validateV1', () => {
  test('returns empty array for valid config', () => {
    const parsed = parseEnvFile(VALID_V1_CONTENT);
    assert.deepEqual(validateV1(parsed), []);
  });

  test('returns missing required keys', () => {
    const parsed = { STELLAR_RPC_URL: 'x', STELLAR_NETWORK: 'testnet' };
    const missing = validateV1(parsed);
    assert.ok(missing.includes('STELLAR_NETWORK_PASSPHRASE'));
    assert.ok(missing.includes('CONTRACT_ADDRESSES'));
    assert.ok(missing.includes('LOG_LEVEL'));
  });
});

describe('migrateConfig — renamed keys are mapped correctly', () => {
  test('DB_HOST → DATABASE_HOST', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DB_HOST: 'localhost' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DATABASE_HOST'], 'localhost');
    assert.equal(migrated['DB_HOST'], undefined);
  });

  test('DB_PORT → DATABASE_PORT', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DB_PORT: '5432' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DATABASE_PORT'], '5432');
    assert.equal(migrated['DB_PORT'], undefined);
  });

  test('DB_USER → DATABASE_USER', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DB_USER: 'admin' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DATABASE_USER'], 'admin');
    assert.equal(migrated['DB_USER'], undefined);
  });

  test('DB_PASS → DATABASE_PASSWORD', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DB_PASS: 's3cr3t' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DATABASE_PASSWORD'], 's3cr3t');
    assert.equal(migrated['DB_PASS'], undefined);
  });

  test('DB_NAME → DATABASE_NAME', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DB_NAME: 'mydb' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DATABASE_NAME'], 'mydb');
    assert.equal(migrated['DB_NAME'], undefined);
  });

  test('STELLAR_RPC_URL → STELLAR_RPC_ENDPOINT', () => {
    const parsed = parseEnvFile(VALID_V1_CONTENT);
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['STELLAR_RPC_ENDPOINT'], 'https://soroban-testnet.stellar.org:443');
    assert.equal(migrated['STELLAR_RPC_URL'], undefined);
  });

  test('DISCORD_WEBHOOK_ID → DISCORD_WEBHOOK_CHANNEL_ID', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), DISCORD_WEBHOOK_ID: 'abc123' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['DISCORD_WEBHOOK_CHANNEL_ID'], 'abc123');
    assert.equal(migrated['DISCORD_WEBHOOK_ID'], undefined);
  });

  test('NOTIFY_ENDPOINT → NOTIFICATION_ENDPOINT', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), NOTIFY_ENDPOINT: 'https://notify.example.com' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['NOTIFICATION_ENDPOINT'], 'https://notify.example.com');
    assert.equal(migrated['NOTIFY_ENDPOINT'], undefined);
  });

  test('RETRY_COUNT → MAX_RETRY_ATTEMPTS', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), RETRY_COUNT: '3' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['MAX_RETRY_ATTEMPTS'], '3');
    assert.equal(migrated['RETRY_COUNT'], undefined);
  });

  test('EVENT_FILTER → CONTRACT_EVENT_FILTER', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), EVENT_FILTER: 'Transfer' };
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['CONTRACT_EVENT_FILTER'], 'Transfer');
    assert.equal(migrated['EVENT_FILTER'], undefined);
  });
});

describe('migrateConfig — removed keys produce warnings, not failures', () => {
  test('VITE_STELLAR_NETWORK is dropped from output', () => {
    const parsed = { ...parseEnvFile(VALID_V1_CONTENT), VITE_STELLAR_NETWORK: 'TESTNET' };
    // Should not throw
    const migrated = migrateConfig(parsed);
    assert.equal(migrated['VITE_STELLAR_NETWORK'], undefined);
  });
});

describe('migrateConfig — deterministic output', () => {
  test('output keys are sorted alphabetically', () => {
    const parsed = parseEnvFile(VALID_V1_CONTENT);
    const migrated = migrateConfig(parsed);
    const keys = Object.keys(migrated);
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(keys, sorted);
  });

  test('same input always produces identical output', () => {
    const parsed = parseEnvFile(VALID_V1_CONTENT);
    const out1 = serializeEnv(migrateConfig(parsed));
    const out2 = serializeEnv(migrateConfig(parsed));
    assert.equal(out1, out2);
  });

  test('serialized output contains header comment', () => {
    const parsed = parseEnvFile(VALID_V1_CONTENT);
    const output = serializeEnv(migrateConfig(parsed));
    assert.ok(output.startsWith('# Migrated from v1 to v2 by migrate-config.js'));
  });
});

describe('CLI — invalid config causes exit code 1', () => {
  test('missing required keys → exit code 1', () => {
    const tmpFile = writeTempFile('FOO=bar\nBAR=baz');
    try {
      const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, tmpFile], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes('Error'));
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('non-existent input file → exit code 1', () => {
    const result = spawnSync(
      process.execPath,
      [MIGRATE_SCRIPT, '/tmp/does-not-exist-notify-chain.env'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Error'));
  });
});

describe('CLI — dry-run does NOT write any file', () => {
  test('no .migrated file created in dry-run mode', () => {
    const tmpFile = writeTempFile(VALID_V1_CONTENT);
    const migratedPath = `${tmpFile}.migrated`;
    try {
      const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, tmpFile], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(fs.existsSync(migratedPath), false, '.migrated file must not exist after dry-run');
    } finally {
      fs.rmSync(tmpFile, { force: true });
      fs.rmSync(migratedPath, { force: true });
    }
  });

  test('dry-run prints migrated config to stdout', () => {
    const tmpFile = writeTempFile(VALID_V1_CONTENT);
    try {
      const result = spawnSync(process.execPath, [MIGRATE_SCRIPT, tmpFile], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('STELLAR_RPC_ENDPOINT='));
      assert.ok(result.stdout.includes('# Migrated from v1 to v2 by migrate-config.js'));
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

describe('CLI — --confirm writes to the correct output path', () => {
  test('--confirm creates <input>.migrated with migrated content', () => {
    const tmpFile = writeTempFile(VALID_V1_CONTENT);
    const migratedPath = `${tmpFile}.migrated`;
    try {
      const result = spawnSync(
        process.execPath,
        [MIGRATE_SCRIPT, tmpFile, '--confirm'],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(fs.existsSync(migratedPath), '.migrated file must exist after --confirm');
      const content = fs.readFileSync(migratedPath, 'utf8');
      assert.ok(content.includes('STELLAR_RPC_ENDPOINT='));
      assert.ok(content.includes('# Migrated from v1 to v2 by migrate-config.js'));
    } finally {
      fs.rmSync(tmpFile, { force: true });
      fs.rmSync(migratedPath, { force: true });
    }
  });

  test('--confirm prints "Written to" message to stdout', () => {
    const tmpFile = writeTempFile(VALID_V1_CONTENT);
    const migratedPath = `${tmpFile}.migrated`;
    try {
      const result = spawnSync(
        process.execPath,
        [MIGRATE_SCRIPT, tmpFile, '--confirm'],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('Written to'));
    } finally {
      fs.rmSync(tmpFile, { force: true });
      fs.rmSync(migratedPath, { force: true });
    }
  });

  test('--confirm does NOT modify the original input file', () => {
    const tmpFile = writeTempFile(VALID_V1_CONTENT);
    const migratedPath = `${tmpFile}.migrated`;
    const originalContent = fs.readFileSync(tmpFile, 'utf8');
    try {
      spawnSync(process.execPath, [MIGRATE_SCRIPT, tmpFile, '--confirm'], {
        encoding: 'utf8',
      });
      const afterContent = fs.readFileSync(tmpFile, 'utf8');
      assert.equal(afterContent, originalContent, 'Input file must not be modified');
    } finally {
      fs.rmSync(tmpFile, { force: true });
      fs.rmSync(migratedPath, { force: true });
    }
  });
});
