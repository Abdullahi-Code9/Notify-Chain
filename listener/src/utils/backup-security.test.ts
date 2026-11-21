/**
 * Tests for Backup Security Utility
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import {
  validateBackupDestination,
  restrictBackupFilePermissions,
  verifyBackupFilePermissions,
  createSecureBackup,
  SECURE_BACKUP_PERMISSIONS,
  BackupSecurityConfig,
} from './backup-security';

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const stat = promisify(fs.stat);

describe('Backup Security Utility', () => {
  let testDir: string;
  let allowedBackupDir: string;
  let config: BackupSecurityConfig;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `backup-security-test-${Date.now()}`);
    allowedBackupDir = path.join(testDir, 'backups');
    await mkdir(testDir, { recursive: true });
    await mkdir(allowedBackupDir, { recursive: true });

    config = {
      allowedBackupDirectories: [allowedBackupDir],
      enforcePermissions: true,
    };
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      const files = fs.readdirSync(allowedBackupDir);
      for (const file of files) {
        await unlink(path.join(allowedBackupDir, file));
      }
      await rmdir(allowedBackupDir);
      await rmdir(testDir);
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('validateBackupDestination', () => {
    it('should accept valid paths within allowed directories', async () => {
      const validPath = path.join(allowedBackupDir, 'backup.db');
      const result = await validateBackupDestination(validPath, config);
      expect(result).toBe(path.resolve(validPath));
    });

    it('should reject paths with traversal attempts', async () => {
      const maliciousPath = path.join(allowedBackupDir, '..', '..', 'etc', 'passwd');
      await expect(validateBackupDestination(maliciousPath, config)).rejects.toThrow(
        'Path traversal detected'
      );
    });

    it('should reject paths outside allowed directories', async () => {
      const outsidePath = '/tmp/unauthorized/backup.db';
      await expect(validateBackupDestination(outsidePath, config)).rejects.toThrow(
        'not within allowed directories'
      );
    });

    it('should reject paths where parent directory does not exist', async () => {
      const nonExistentParent = path.join(testDir, 'nonexistent', 'backup.db');
      await expect(validateBackupDestination(nonExistentParent, config)).rejects.toThrow(
        'Parent directory'
      );
    });
  });

  describe('restrictBackupFilePermissions', () => {
    it('should set secure permissions on backup file', async () => {
      const testFile = path.join(allowedBackupDir, 'test-backup.db');
      await writeFile(testFile, 'test data');

      await restrictBackupFilePermissions(testFile);

      const stats = await stat(testFile);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(SECURE_BACKUP_PERMISSIONS);
    });

    it('should throw error for non-existent file', async () => {
      const nonExistentFile = path.join(allowedBackupDir, 'does-not-exist.db');
      await expect(restrictBackupFilePermissions(nonExistentFile)).rejects.toThrow();
    });

    it('should verify permissions after setting', async () => {
      const testFile = path.join(allowedBackupDir, 'verify-test.db');
      await writeFile(testFile, 'test data');

      await restrictBackupFilePermissions(testFile);

      const stats = await stat(testFile);
      const actualPermissions = stats.mode & 0o777;
      expect(actualPermissions).toBe(0o600);
    });
  });

  describe('verifyBackupFilePermissions', () => {
    it('should return true for files with secure permissions', async () => {
      const testFile = path.join(allowedBackupDir, 'secure-file.db');
      await writeFile(testFile, 'test data');
      await restrictBackupFilePermissions(testFile);

      const isSecure = await verifyBackupFilePermissions(testFile);
      expect(isSecure).toBe(true);
    });

    it('should return false for files with insecure permissions', async () => {
      const testFile = path.join(allowedBackupDir, 'insecure-file.db');
      await writeFile(testFile, 'test data');
      // Default permissions are typically 0644, which is insecure

      const isSecure = await verifyBackupFilePermissions(testFile);
      expect(isSecure).toBe(false);
    });

    it('should return false for non-existent files', async () => {
      const nonExistentFile = path.join(allowedBackupDir, 'does-not-exist.db');
      const isSecure = await verifyBackupFilePermissions(nonExistentFile);
      expect(isSecure).toBe(false);
    });
  });

  describe('createSecureBackup', () => {
    it('should validate destination path', async () => {
      const sourcePath = path.join(testDir, 'source.db');
      const destinationPath = path.join(allowedBackupDir, 'backup.db');

      await expect(
        createSecureBackup(sourcePath, destinationPath, config)
      ).rejects.toThrow('not yet implemented');
    });

    it('should reject invalid destination paths', async () => {
      const sourcePath = path.join(testDir, 'source.db');
      const maliciousPath = '/etc/passwd';

      await expect(
        createSecureBackup(sourcePath, maliciousPath, config)
      ).rejects.toThrow('not within allowed directories');
    });
  });

  describe('SECURE_BACKUP_PERMISSIONS constant', () => {
    it('should be set to 0600 (owner read/write only)', () => {
      expect(SECURE_BACKUP_PERMISSIONS).toBe(0o600);
    });
  });
});
