/**
 * Tests for Credential Encryption Utility
 */

import * as crypto from 'crypto';
import {
  encryptCredential,
  decryptCredential,
  generateEncryptionKey,
  deriveKeyFromBase64,
  validateEncryptionKey,
  serializeEncryptedCredential,
  parseEncryptedCredential,
  isEncryptedCredential,
  redactCredential,
  EncryptionError,
  DecryptionError,
  ENCRYPTION_ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  ENCRYPTED_CREDENTIAL_VERSION,
  EncryptedCredential,
} from './credential-encryption';

describe('Credential Encryption Utility', () => {
  let testKey: Buffer;
  const keyId = 'test-key-001';
  const testCredential = 'discord_webhook_token_abc123xyz';

  beforeEach(() => {
    testKey = generateEncryptionKey();
  });

  describe('generateEncryptionKey', () => {
    it('should generate a 32-byte key', () => {
      const key = generateEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('validateEncryptionKey', () => {
    it('should accept valid 32-byte keys', () => {
      const key = crypto.randomBytes(32);
      expect(() => validateEncryptionKey(key)).not.toThrow();
    });

    it('should reject non-Buffer values', () => {
      expect(() => validateEncryptionKey('not a buffer' as any)).toThrow(
        'Encryption key must be a Buffer'
      );
    });

    it('should reject keys of incorrect length', () => {
      const shortKey = crypto.randomBytes(16);
      expect(() => validateEncryptionKey(shortKey)).toThrow(
        'Encryption key must be 32 bytes'
      );

      const longKey = crypto.randomBytes(64);
      expect(() => validateEncryptionKey(longKey)).toThrow(
        'Encryption key must be 32 bytes'
      );
    });
  });

  describe('deriveKeyFromBase64', () => {
    it('should decode a valid base64 key', () => {
      const originalKey = crypto.randomBytes(32);
      const encoded = originalKey.toString('base64');
      const decoded = deriveKeyFromBase64(encoded);
      expect(decoded.equals(originalKey)).toBe(true);
    });

    it('should reject invalid base64', () => {
      expect(() => deriveKeyFromBase64('not-valid-base64!!!')).toThrow();
    });

    it('should reject keys of wrong length', () => {
      const wrongLengthKey = crypto.randomBytes(16).toString('base64');
      expect(() => deriveKeyFromBase64(wrongLengthKey)).toThrow(
        'Encryption key must be 32 bytes'
      );
    });
  });

  describe('encryptCredential', () => {
    it('should encrypt a credential successfully', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      
      expect(encrypted.version).toBe(ENCRYPTED_CREDENTIAL_VERSION);
      expect(encrypted.keyId).toBe(keyId);
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.ciphertext).toBeTruthy();
    });

    it('should produce different ciphertext for same plaintext (random IVs)', () => {
      const encrypted1 = encryptCredential(testCredential, testKey, keyId);
      const encrypted2 = encryptCredential(testCredential, testKey, keyId);
      
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it('should reject empty plaintext', () => {
      expect(() => encryptCredential('', testKey, keyId)).toThrow(
        EncryptionError
      );
    });

    it('should reject invalid key', () => {
      const invalidKey = crypto.randomBytes(16);
      expect(() => encryptCredential(testCredential, invalidKey, keyId)).toThrow(
        EncryptionError
      );
    });

    it('should reject empty key ID', () => {
      expect(() => encryptCredential(testCredential, testKey, '')).toThrow(
        EncryptionError
      );
    });

    it('should handle special characters in credentials', () => {
      const specialChars = 'webhook_token!@#$%^&*()_+-={}[]|:";\'<>?,./\\';
      const encrypted = encryptCredential(specialChars, testKey, keyId);
      const decrypted = decryptCredential(encrypted, testKey);
      expect(decrypted).toBe(specialChars);
    });

    it('should handle unicode in credentials', () => {
      const unicode = '测试密钥🔐密码';
      const encrypted = encryptCredential(unicode, testKey, keyId);
      const decrypted = decryptCredential(encrypted, testKey);
      expect(decrypted).toBe(unicode);
    });
  });

  describe('decryptCredential', () => {
    it('should decrypt a valid encrypted credential', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const decrypted = decryptCredential(encrypted, testKey);
      expect(decrypted).toBe(testCredential);
    });

    it('should fail with wrong key', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const wrongKey = generateEncryptionKey();
      
      expect(() => decryptCredential(encrypted, wrongKey)).toThrow(DecryptionError);
    });

    it('should fail with tampered ciphertext', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      
      // Tamper with the ciphertext
      const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64url');
      tamperedCiphertext[0] ^= 0xFF; // Flip bits
      
      const tampered: EncryptedCredential = {
        ...encrypted,
        ciphertext: tamperedCiphertext.toString('base64url'),
      };

      expect(() => decryptCredential(tampered, testKey)).toThrow(DecryptionError);
    });

    it('should fail with tampered auth tag', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      
      // Tamper with the auth tag
      const tamperedTag = Buffer.from(encrypted.authTag, 'base64url');
      tamperedTag[0] ^= 0xFF;
      
      const tampered: EncryptedCredential = {
        ...encrypted,
        authTag: tamperedTag.toString('base64url'),
      };

      expect(() => decryptCredential(tampered, testKey)).toThrow(DecryptionError);
    });

    it('should fail with tampered IV', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      
      // Tamper with the IV
      const tamperedIV = Buffer.from(encrypted.iv, 'base64url');
      tamperedIV[0] ^= 0xFF;
      
      const tampered: EncryptedCredential = {
        ...encrypted,
        iv: tamperedIV.toString('base64url'),
      };

      expect(() => decryptCredential(tampered, testKey)).toThrow(DecryptionError);
    });

    it('should reject invalid credential structure', () => {
      const invalid: any = {
        version: ENCRYPTED_CREDENTIAL_VERSION,
        keyId: 'test',
        // Missing iv, authTag, ciphertext
      };

      expect(() => decryptCredential(invalid, testKey)).toThrow(DecryptionError);
    });

    it('should reject unsupported version', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const unsupported: EncryptedCredential = {
        ...encrypted,
        version: 'v999',
      };

      expect(() => decryptCredential(unsupported, testKey)).toThrow(
        /Unsupported credential version/
      );
    });

    it('should reject invalid IV length', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const invalidIV: EncryptedCredential = {
        ...encrypted,
        iv: crypto.randomBytes(8).toString('base64url'), // Wrong length
      };

      expect(() => decryptCredential(invalidIV, testKey)).toThrow(
        /Invalid IV length/
      );
    });

    it('should reject invalid auth tag length', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const invalidTag: EncryptedCredential = {
        ...encrypted,
        authTag: crypto.randomBytes(8).toString('base64url'), // Wrong length
      };

      expect(() => decryptCredential(invalidTag, testKey)).toThrow(
        /Invalid auth tag length/
      );
    });
  });

  describe('serializeEncryptedCredential', () => {
    it('should serialize to string format', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      
      expect(typeof serialized).toBe('string');
      expect(serialized).toContain('$');
      expect(serialized.startsWith(ENCRYPTED_CREDENTIAL_VERSION)).toBe(true);
    });

    it('should contain all components', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      const parts = serialized.split('$');
      
      expect(parts).toHaveLength(5);
      expect(parts[0]).toBe(encrypted.version);
      expect(parts[1]).toBe(encrypted.keyId);
      expect(parts[2]).toBe(encrypted.iv);
      expect(parts[3]).toBe(encrypted.authTag);
      expect(parts[4]).toBe(encrypted.ciphertext);
    });
  });

  describe('parseEncryptedCredential', () => {
    it('should parse a valid serialized credential', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      const parsed = parseEncryptedCredential(serialized);
      
      expect(parsed.version).toBe(encrypted.version);
      expect(parsed.keyId).toBe(encrypted.keyId);
      expect(parsed.iv).toBe(encrypted.iv);
      expect(parsed.authTag).toBe(encrypted.authTag);
      expect(parsed.ciphertext).toBe(encrypted.ciphertext);
    });

    it('should reject invalid format with wrong number of parts', () => {
      expect(() => parseEncryptedCredential('v1$key$iv$tag')).toThrow(
        /expected 5 parts/
      );
    });

    it('should reject format with missing components', () => {
      expect(() => parseEncryptedCredential('v1$key$$tag$ciphertext')).toThrow(
        /missing required components/
      );
    });
  });

  describe('round-trip serialization', () => {
    it('should successfully decrypt after serialization round-trip', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      const parsed = parseEncryptedCredential(serialized);
      const decrypted = decryptCredential(parsed, testKey);
      
      expect(decrypted).toBe(testCredential);
    });
  });

  describe('isEncryptedCredential', () => {
    it('should return true for encrypted credentials', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      expect(isEncryptedCredential(serialized)).toBe(true);
    });

    it('should return false for plaintext credentials', () => {
      expect(isEncryptedCredential('discord_webhook_token')).toBe(false);
      expect(isEncryptedCredential('sk_test_abc123')).toBe(false);
    });

    it('should return false for empty or null values', () => {
      expect(isEncryptedCredential('')).toBe(false);
      expect(isEncryptedCredential(null as any)).toBe(false);
      expect(isEncryptedCredential(undefined as any)).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(isEncryptedCredential(123 as any)).toBe(false);
      expect(isEncryptedCredential({} as any)).toBe(false);
    });
  });

  describe('redactCredential', () => {
    it('should redact encrypted credentials showing version and key ID', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      const redacted = redactCredential(serialized);
      
      expect(redacted).toContain('[encrypted');
      expect(redacted).toContain(ENCRYPTED_CREDENTIAL_VERSION);
      expect(redacted).toContain(keyId);
      expect(redacted).not.toContain(encrypted.ciphertext);
    });

    it('should redact plaintext credentials showing only prefix', () => {
      const plaintext = 'discord_webhook_secret_token_12345';
      const redacted = redactCredential(plaintext);
      
      expect(redacted).toContain('discord_');
      expect(redacted).toContain(`[${plaintext.length} chars]`);
      expect(redacted).not.toContain('secret');
      expect(redacted).not.toContain('12345');
    });

    it('should handle empty credentials', () => {
      expect(redactCredential('')).toBe('[empty]');
    });

    it('should handle short credentials', () => {
      const redacted = redactCredential('abc');
      expect(redacted).toContain('abc');
    });
  });

  describe('security properties', () => {
    it('should use authenticated encryption (tamper detection)', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      expect(encrypted.authTag).toBeTruthy();
      expect(Buffer.from(encrypted.authTag, 'base64url').length).toBe(AUTH_TAG_LENGTH);
    });

    it('should use unique IVs for each encryption', () => {
      const ivs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const encrypted = encryptCredential(testCredential, testKey, keyId);
        ivs.add(encrypted.iv);
      }
      expect(ivs.size).toBe(100); // All unique
    });

    it('should use proper IV length for GCM', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const ivBuffer = Buffer.from(encrypted.iv, 'base64url');
      expect(ivBuffer.length).toBe(IV_LENGTH);
    });

    it('should not expose plaintext in encrypted structure', () => {
      const encrypted = encryptCredential(testCredential, testKey, keyId);
      const serialized = serializeEncryptedCredential(encrypted);
      
      expect(serialized).not.toContain(testCredential);
      expect(encrypted.ciphertext).not.toContain(testCredential);
    });
  });
});
