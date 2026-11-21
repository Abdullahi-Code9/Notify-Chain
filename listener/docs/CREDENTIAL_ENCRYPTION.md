# Credential Encryption

## Overview

This document describes the foundational encryption system for protecting sensitive notification provider credentials (Discord webhook tokens, API keys, SMTP passwords, etc.) when persistence is required. This represents 1% of the complete credential encryption solution.

## Current Implementation (Phase 1 - 1%)

### Features

#### 1. Authenticated Encryption (AEAD)
- Uses **AES-256-GCM** (Galois/Counter Mode)
- Provides both confidentiality and authenticity
- Detects tampering through authentication tags
- Industry-standard encryption algorithm

#### 2. Secure Cryptographic Practices
- **Random IVs**: Each encryption uses a unique 12-byte initialization vector
- **Authentication Tags**: 16-byte tags prevent tampering
- **Key Validation**: Enforces proper 32-byte key length
- **Constant-Time Operations**: Uses Node.js crypto for timing-safe comparisons

#### 3. Serialization & Storage Format
- Compact serialization: `v1$keyId$iv$authTag$ciphertext`
- Base64url encoding for safe storage in databases/config files
- Version prefix for future format upgrades
- Key ID tracking for key rotation support

#### 4. Logging Protection
- Credential redaction utilities prevent accidental exposure
- Encrypted credentials show only version and key ID in logs
- Plaintext credentials show only prefix when logged

## Usage

### Basic Encryption/Decryption

```typescript
import {
  encryptCredential,
  decryptCredential,
  generateEncryptionKey,
  serializeEncryptedCredential,
  parseEncryptedCredential,
} from './utils/credential-encryption';

// Generate or load encryption key
const encryptionKey = generateEncryptionKey(); // 32-byte random key
const keyId = 'prod-key-001';

// Encrypt a credential
const discordWebhook = 'https://discord.com/api/webhooks/123/secret_token';
const encrypted = encryptCredential(discordWebhook, encryptionKey, keyId);

// Serialize for storage
const serialized = serializeEncryptedCredential(encrypted);
// Result: "v1$prod-key-001$<iv>$<tag>$<ciphertext>"

// Store in database/config
await db.saveCredential('discord_webhook', serialized);

// Later: Load and decrypt
const storedValue = await db.getCredential('discord_webhook');
const parsed = parseEncryptedCredential(storedValue);
const decrypted = decryptCredential(parsed, encryptionKey);
```

### Safe Logging

```typescript
import { redactCredential, isEncryptedCredential } from './utils/credential-encryption';

const credential = 'discord_webhook_secret_abc123';

// Check if already encrypted
if (isEncryptedCredential(credential)) {
  console.log('Using encrypted credential');
} else {
  console.warn('Credential is not encrypted!');
}

// Safe logging (always use this!)
console.log('Credential:', redactCredential(credential));
// Output: "Credential: discord_...[32 chars]"
```

### Key Derivation from Environment

```typescript
import { deriveKeyFromBase64 } from './utils/credential-encryption';

// Store in environment variable (base64-encoded 32-byte key)
// Generate with: openssl rand -base64 32
const keyBase64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
const encryptionKey = deriveKeyFromBase64(keyBase64);
```

## Security Features

### Implemented (Phase 1)
- ✅ AES-256-GCM authenticated encryption
- ✅ Random IV generation per encryption
- ✅ Tamper detection via authentication tags
- ✅ Key validation
- ✅ Safe serialization format
- ✅ Logging protection utilities

### Planned (Future Phases)
- ⏳ Key rotation mechanism
- ⏳ Migration from plaintext to encrypted credentials
- ⏳ Integration with key management services (AWS KMS, HashiCorp Vault)
- ⏳ Automatic decryption in application workflows
- ⏳ Audit logging for encryption/decryption operations
- ⏳ Multi-key support for gradual migrations
- ⏳ Key expiration and rotation policies

## Encryption Format

### Structure
```
version $ keyId $ iv $ authTag $ ciphertext
```

### Components
- **version**: Format version (`v1`)
- **keyId**: Identifier of the encryption key used
- **iv**: Initialization vector (12 bytes, base64url)
- **authTag**: Authentication tag (16 bytes, base64url)
- **ciphertext**: Encrypted credential (variable length, base64url)

### Example
```
v1$prod-key-001$a8Nf9xK2mP1qY7zR$kL3pM8nQ9rS7tV2wX$aHR0cHM6Ly9kaXNjb3Jk...
```

## Configuration

### Environment Variables

For production deployment:

```bash
# .env
# Generate with: openssl rand -base64 32
CREDENTIAL_ENCRYPTION_KEY=your-base64-encoded-32-byte-key-here

# Key identifier for tracking
CREDENTIAL_ENCRYPTION_KEY_ID=prod-key-001
```

### Key Storage Best Practices

1. **Never commit keys to version control**
2. **Use environment variables or secrets management**
3. **Rotate keys periodically** (future enhancement)
4. **Use different keys per environment** (dev/staging/prod)
5. **Back up keys securely** (encrypted backups)

## Security Considerations

### Cryptographic Strength

- **Algorithm**: AES-256-GCM (NIST approved, FIPS 140-2 compliant)
- **Key Size**: 256 bits (32 bytes)
- **IV Size**: 96 bits (12 bytes) - recommended for GCM
- **Tag Size**: 128 bits (16 bytes) - maximum authentication strength

### Authentication

AES-GCM provides **authenticated encryption with associated data (AEAD)**:
- Encrypts the plaintext
- Authenticates the ciphertext
- Detects any tampering or corruption
- Prevents bit-flipping attacks

### Tamper Detection

Any modification to the encrypted credential will be detected:
```typescript
try {
  const decrypted = decryptCredential(tamperedCiphertext, key);
} catch (error) {
  // DecryptionError: Authentication failed
  console.error('Credential has been tampered with!');
}
```

## Testing

Run the credential encryption tests:

```bash
cd listener
npm test -- credential-encryption.test.ts
```

### Test Coverage
- ✅ Encryption and decryption
- ✅ Tamper detection (ciphertext, IV, auth tag)
- ✅ Key validation
- ✅ Serialization and parsing
- ✅ Round-trip integrity
- ✅ Unicode and special character handling
- ✅ Security properties (unique IVs, proper lengths)
- ✅ Error handling

## Limitations (Phase 1)

This is a foundational implementation (1% of complete solution). Current limitations:

1. **No Key Rotation**: Keys cannot be rotated without manual intervention
2. **No Migration Support**: Existing plaintext credentials must be manually encrypted
3. **No KMS Integration**: Keys stored in environment variables only
4. **No Audit Logging**: Encryption/decryption operations are not logged
5. **Manual Integration**: Application code must explicitly call encryption functions
6. **Single Key**: Only one active encryption key supported

## Migration Path (Future Phases)

### Phase 2: Key Rotation (Planned)
- Support multiple encryption keys simultaneously
- Automatic re-encryption with new keys
- Graceful key deprecation

### Phase 3: Credential Migration (Planned)
- Detect and encrypt plaintext credentials automatically
- Migration utilities for existing databases
- Backwards compatibility during transition

### Phase 4: KMS Integration (Planned)
- AWS KMS support
- HashiCorp Vault integration
- Azure Key Vault support
- Google Cloud KMS support

### Phase 5: Application Integration (Planned)
- Transparent decryption in notification providers
- Automatic encryption on credential updates
- Configuration schema updates
- Environment variable encryption

### Phase 6: Audit & Compliance (Planned)
- Audit logging for all encryption operations
- Compliance reporting (PCI-DSS, SOC 2)
- Key usage analytics
- Security event monitoring

## Integration Examples

### Discord Webhook Encryption

```typescript
// Before (plaintext in config)
const discordConfig = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL, // ⚠️ Plaintext
};

// After (encrypted in database)
const encryptedWebhook = await db.getCredential('discord_webhook');
const decryptionKey = deriveKeyFromBase64(process.env.CREDENTIAL_ENCRYPTION_KEY);
const parsed = parseEncryptedCredential(encryptedWebhook);
const webhookUrl = decryptCredential(parsed, decryptionKey);

const discordConfig = {
  webhookUrl, // ✅ Decrypted only in memory
};
```

### API Key Encryption

```typescript
// Encrypt new API keys
async function storeApiKey(name: string, apiKey: string) {
  const encryptionKey = deriveKeyFromBase64(process.env.CREDENTIAL_ENCRYPTION_KEY);
  const keyId = process.env.CREDENTIAL_ENCRYPTION_KEY_ID || 'default';
  
  const encrypted = encryptCredential(apiKey, encryptionKey, keyId);
  const serialized = serializeEncryptedCredential(encrypted);
  
  await db.saveCredential(name, serialized);
  console.log(`Stored encrypted credential: ${name}`);
}

// Retrieve and decrypt
async function getApiKey(name: string): Promise<string> {
  const stored = await db.getCredential(name);
  
  if (!isEncryptedCredential(stored)) {
    throw new Error(`Credential ${name} is not encrypted`);
  }
  
  const encryptionKey = deriveKeyFromBase64(process.env.CREDENTIAL_ENCRYPTION_KEY);
  const parsed = parseEncryptedCredential(stored);
  return decryptCredential(parsed, encryptionKey);
}
```

## Acceptance Criteria Status

From the original requirements:

| Criterion | Status | Notes |
|-----------|--------|-------|
| Stored credentials are encrypted | ✅ Implemented | AES-256-GCM encryption |
| Decryption restricted to authorized workflows | ⏳ Planned | Phase 5 (application integration) |
| Invalid ciphertext handled safely | ✅ Implemented | DecryptionError on tampering |
| Key rotation doesn't expose plaintext | ⏳ Planned | Phase 2 (key rotation) |
| Prevent decrypted values in logs | ✅ Implemented | Redaction utilities |

**Current Progress**: 1% (foundational encryption implemented)

## Related Files

- `listener/src/utils/credential-encryption.ts` - Main implementation
- `listener/src/utils/credential-encryption.test.ts` - Test suite
- `listener/docs/CREDENTIAL_ENCRYPTION.md` - This documentation

## Security Contact

For security concerns related to credential encryption, please follow responsible disclosure practices outlined in the project's security policy.

## References

- [NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final) - GCM Mode Specification
- [RFC 5116](https://tools.ietf.org/html/rfc5116) - AEAD Cipher Suites
- [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html)
