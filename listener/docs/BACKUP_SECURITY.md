# Database Backup Security

## Overview

This document describes the foundational security controls implemented for database backups in the Notify-Chain system. This represents 1% of the complete backup security solution, focusing on file permission restrictions and path validation.

## Current Implementation (Phase 1 - 1%)

### Features

#### 1. Restricted File Permissions
- Backup files are automatically set to `0600` permissions (owner read/write only)
- Prevents unauthorized users from accessing backup files
- Enforced at the filesystem level

#### 2. Backup Destination Validation
- Validates backup destinations against an allowlist of approved directories
- Prevents path traversal attacks (e.g., `../../etc/passwd`)
- Ensures parent directories exist before attempting backup

#### 3. Permission Verification
- Utility functions to verify backup files have secure permissions
- Can be used in compliance audits and security checks

## Usage

### Basic Usage

```typescript
import {
  validateBackupDestination,
  restrictBackupFilePermissions,
  verifyBackupFilePermissions,
  BackupSecurityConfig
} from './utils/backup-security';

// Configuration
const config: BackupSecurityConfig = {
  allowedBackupDirectories: [
    '/var/backups/notify-chain',
    '/mnt/secure-storage/backups'
  ],
  enforcePermissions: true
};

// Validate a backup destination
try {
  const validPath = await validateBackupDestination(
    '/var/backups/notify-chain/backup-2024-01-15.db',
    config
  );
  console.log('Validated path:', validPath);
} catch (error) {
  console.error('Invalid backup destination:', error.message);
}

// Restrict permissions on an existing backup
await restrictBackupFilePermissions('/var/backups/notify-chain/backup.db');

// Verify permissions
const isSecure = await verifyBackupFilePermissions('/var/backups/notify-chain/backup.db');
if (!isSecure) {
  console.warn('Backup file does not have secure permissions!');
}
```

## Security Controls

### Implemented (Phase 1)
- ✅ File permission restrictions (0600)
- ✅ Backup destination validation
- ✅ Path traversal prevention
- ✅ Allowlist-based directory access

### Planned (Future Phases)
- ⏳ Backup encryption at rest
- ⏳ Separate encryption key management
- ⏳ Backup integrity verification (checksums/signatures)
- ⏳ Secure restoration procedures
- ⏳ Encryption key rotation
- ⏳ Automated backup testing
- ⏳ Audit logging for backup operations
- ⏳ Role-based access control for backup operations

## Configuration

### Environment Variables

For production use, configure allowed backup directories:

```bash
# .env
BACKUP_ALLOWED_DIRECTORIES=/var/backups/notify-chain,/mnt/secure-storage/backups
BACKUP_ENFORCE_PERMISSIONS=true
```

### File Permissions

The system uses `0600` (octal) permissions for backup files:
- **Owner**: Read + Write
- **Group**: No access
- **Others**: No access

This ensures only the file owner (typically the application service account) can read or modify backup files.

## Compliance

This implementation addresses the following security requirements:

1. **Unauthorized Access Prevention**: File permissions restrict access to backup files
2. **Path Traversal Protection**: Validation prevents attacks attempting to write to unauthorized locations
3. **Directory Allowlisting**: Only approved directories can store backups

## Testing

Run the backup security tests:

```bash
cd listener
npm test -- backup-security.test.ts
```

### Test Coverage
- Valid path acceptance
- Path traversal rejection
- Unauthorized directory rejection
- Permission setting and verification
- Non-existent file handling

## Limitations (Phase 1)

This is a foundational implementation (1% of complete solution). Current limitations:

1. **No Encryption**: Backups are not encrypted (sensitive data is stored in plaintext)
2. **No Integrity Verification**: No checksums or signatures to verify backup integrity
3. **No Key Management**: Future encryption features will require key management
4. **Manual Restoration**: Restoration procedures are not yet automated or documented
5. **No Backup Rotation**: Automated backup rotation not implemented

## Future Enhancements

### Phase 2: Encryption (Planned)
- Implement AES-256-GCM encryption for backups
- Separate encryption key storage (environment variables, key management service)
- Key rotation capabilities

### Phase 3: Integrity Verification (Planned)
- SHA-256 checksums for backup files
- HMAC signatures for tamper detection
- Automated integrity checks

### Phase 4: Operational Security (Planned)
- Secure restoration procedures
- Automated backup testing
- Audit logging
- Role-based access control

## Related Files

- `listener/src/utils/backup-security.ts` - Main implementation
- `listener/src/utils/backup-security.test.ts` - Test suite
- `listener/docs/BACKUP_SECURITY.md` - This documentation

## Questions & Support

For questions about backup security or to contribute to future phases, please refer to the project's contribution guidelines.

## Acceptance Criteria Status

From the original requirements:

| Criterion | Status | Notes |
|-----------|--------|-------|
| Backups can be encrypted and decrypted by authorized operators | ⏳ Planned | Phase 2 |
| Unauthorized users cannot access backup files | ✅ Implemented | File permissions (0600) |
| Backup integrity can be verified | ⏳ Planned | Phase 3 |
| Restoration procedures do not expose credentials | ⏳ Planned | Phase 4 |

**Current Progress**: 1% (foundational file security implemented)
