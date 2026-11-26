/**
 * Backup Security Utility
 * 
 * Provides foundational security controls for database backups:
 * - Restrict backup file permissions to owner-only (0600)
 * - Validate backup destination paths
 * - Prevent path traversal attacks
 * 
 * This is 1% of the complete backup security implementation.
 * Future enhancements will include encryption, key management, and integrity verification.
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const chmod = promisify(fs.chmod);
const access = promisify(fs.access);
const stat = promisify(fs.stat);

/**
 * Secure file permissions for backup files (owner read/write only)
 */
export const SECURE_BACKUP_PERMISSIONS = 0o600;

/**
 * Configuration for backup security
 */
export interface BackupSecurityConfig {
  allowedBackupDirectories: string[];
  enforcePermissions: boolean;
}

/**
 * Validates that a backup destination path is safe and within allowed directories
 * 
 * @param destinationPath - The intended backup file path
 * @param config - Security configuration
 * @returns Normalized absolute path if valid
 * @throws Error if path is invalid or unsafe
 */
export async function validateBackupDestination(
  destinationPath: string,
  config: BackupSecurityConfig
): Promise<string> {
  // Resolve to absolute path and normalize
  const absolutePath = path.resolve(destinationPath);
  const normalizedPath = path.normalize(absolutePath);

  // Check for path traversal attempts
  if (normalizedPath.includes('..')) {
    throw new Error('Path traversal detected in backup destination');
  }

  // Validate against allowed directories
  const isAllowed = config.allowedBackupDirectories.some((allowedDir) => {
    const normalizedAllowedDir = path.normalize(path.resolve(allowedDir));
    return normalizedPath.startsWith(normalizedAllowedDir);
  });

  if (!isAllowed) {
    throw new Error(
      `Backup destination ${normalizedPath} is not within allowed directories: ${config.allowedBackupDirectories.join(', ')}`
    );
  }

  // Check if parent directory exists
  const parentDir = path.dirname(normalizedPath);
  try {
    const parentStat = await stat(parentDir);
    if (!parentStat.isDirectory()) {
      throw new Error(`Parent path ${parentDir} is not a directory`);
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`Parent directory ${parentDir} does not exist`);
    }
    throw error;
  }

  return normalizedPath;
}

/**
 * Applies secure file permissions to a backup file
 * Restricts access to owner read/write only (0600)
 * 
 * @param backupFilePath - Path to the backup file
 * @throws Error if permissions cannot be set
 */
export async function restrictBackupFilePermissions(
  backupFilePath: string
): Promise<void> {
  try {
    // Verify file exists
    await access(backupFilePath, fs.constants.F_OK);

    // Set restrictive permissions (owner read/write only)
    await chmod(backupFilePath, SECURE_BACKUP_PERMISSIONS);

    // Verify permissions were set correctly
    const stats = await stat(backupFilePath);
    const actualPermissions = stats.mode & 0o777;

    if (actualPermissions !== SECURE_BACKUP_PERMISSIONS) {
      throw new Error(
        `Failed to set secure permissions. Expected ${SECURE_BACKUP_PERMISSIONS.toString(8)}, got ${actualPermissions.toString(8)}`
      );
    }
  } catch (error: any) {
    throw new Error(`Failed to restrict backup file permissions: ${error.message}`);
  }
}

/**
 * Verifies that a backup file has secure permissions
 * 
 * @param backupFilePath - Path to the backup file to verify
 * @returns True if permissions are secure (0600), false otherwise
 */
export async function verifyBackupFilePermissions(
  backupFilePath: string
): Promise<boolean> {
  try {
    const stats = await stat(backupFilePath);
    const actualPermissions = stats.mode & 0o777;
    return actualPermissions === SECURE_BACKUP_PERMISSIONS;
  } catch (error) {
    return false;
  }
}

/**
 * Creates a secure backup with restricted permissions
 * This is a utility wrapper that combines validation and permission setting
 * 
 * @param sourcePath - Source file to backup
 * @param destinationPath - Destination for backup
 * @param config - Security configuration
 * @returns The validated destination path
 */
export async function createSecureBackup(
  sourcePath: string,
  destinationPath: string,
  config: BackupSecurityConfig
): Promise<string> {
  // Validate destination path
  const validatedPath = await validateBackupDestination(destinationPath, config);

  // Copy file (actual backup logic would go here)
  // For now, this is a placeholder showing the interface

  // Apply secure permissions if enforcement is enabled
  if (config.enforcePermissions) {
    // Note: In production, this would be called after the actual file copy
    // For now, we just document the expected flow
    throw new Error('Backup copy logic not yet implemented - this is 1% of the solution');
  }

  return validatedPath;
}
