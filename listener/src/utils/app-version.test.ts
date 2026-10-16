/**
 * Unit tests for getAppVersion / APP_VERSION (#624).
 *
 * The version source is listener/package.json.  These tests verify that the
 * function returns a well-formed value in every scenario.
 */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import * as fsModule from 'fs';
import { getAppVersion } from './app-version';

jest.mock('fs');

const mockFs = fsModule as jest.Mocked<typeof fsModule>;

describe('getAppVersion', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('returns a non-empty string', () => {
    const version = getAppVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  it('returns either a semver string or "unknown"', () => {
    const version = getAppVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+.*$|^unknown$/);
  });

  it('returns "unknown" when no package.json is readable', () => {
    mockFs.existsSync.mockReturnValue(false);
    const version = getAppVersion();
    expect(version).toBe('unknown');
  });

  it('returns "unknown" when package.json has no version field', () => {
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ name: 'listener' })
    );
    const version = getAppVersion();
    expect(version).toBe('unknown');
  });

  it('returns "unknown" when package.json is malformed JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue('{ invalid json }');
    const version = getAppVersion();
    expect(version).toBe('unknown');
  });

  it('returns "unknown" when readFileSync throws', () => {
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const version = getAppVersion();
    expect(version).toBe('unknown');
  });

  it('returns the version from package.json when found', () => {
    mockFs.existsSync.mockReturnValue(true);
    (mockFs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ name: 'listener', version: '2.3.4' })
    );
    const version = getAppVersion();
    expect(version).toBe('2.3.4');
  });
});

describe('APP_VERSION', () => {
  it('is a non-empty string', () => {
    // Re-import to get the cached module-level constant.
    const { APP_VERSION } = require('./app-version');
    expect(typeof APP_VERSION).toBe('string');
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });
});
