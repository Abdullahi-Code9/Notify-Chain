/**
 * Credential Encryption Utility (Phase 1 - 1% Implementation)
 * 
 * Provides foundational authenticated encryption for sensitive notification
 * provider credentials (Discord webhooks, API keys, SMTP passwords, etc.).
 * 
 * Security Features:
 * - AES-256-GCM authenticated encryption (AEAD)
 * - Per-credential random initialization vectors (IVs)
 * - Tamper detection via authentication tags
 * - Constant-time comparison for tag verification
 * 
 * This is 1% of the complete credential encryption solution.
 * Future enhancements will include key rotation, migration handling, and
 * integration with key management services.
 */

import * as crypto from 'crypto';

/**
 * Encryption algorithm used for credentials
 * AES-256-GCM provides authenticated encryption with associated data (AEAD)
 */
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm' as const;

/**
 * Length of the initialization vector (IV) in bytes
 * 12 bytes is the recommended IV length for GCM mode
 */
export const IV_LENGTH = 12;

/**
 * Length of the authentication tag in bytes
 * 16 bytes provides 128-bit authentication strength
 */
export const AUTH_TAG_LENGTH = 16;

/**
 * Encoding format for encrypted credentials
 * Format: <version>$<keyId>$<iv>$<authTag>$<ciphertext>
 */
export const ENCRYPTED_CREDENTIAL_VERSION = 'v1' as const;

/**
 * Encrypted credential structure
 */
export interface EncryptedCredential {
  version: string;
  keyId: string;
  iv: string;        // base64url encoded
  authTag: string;   // base64url encoded
  ciphertext: string; // base64url encoded
}

/**
 * Encryption key configuration
 */
export interface EncryptionKey {
  id: string;        // Unique identifier for the key
  key: Buffer;       // 32-byte encryption key
  createdAt: Date;
  active: boolean;   // Whether this key should be used for new encryptions
}

/**
 * Error thrown when decryption fails
 */
export class DecryptionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Error thrown when encryption fails
 */
export class EncryptionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Validates that a buffer is a valid AES-256 key (32 bytes)
 */
export function validateEncryptionKey(key: Buffer): void {
  if (!Buffer.isBuffer(key)) {
    throw new Error('Encryption key must be a Buffer');
  }
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`);
  }
}

/**
 * Generates a new random encryption key suitable for AES-256
 * 
 * @returns A 32-byte random key
 */
export function generateEncryptionKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Derives an encryption key from a base64-encoded string
 * 
 * @param encodedKey - Base64-encoded key material
 * @returns Decoded encryption key
 * @throws Error if the key is invalid
 */
export function deriveKeyFromBase64(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  validateEncryptionKey(key);
  return key;
}

/**
 * Encrypts a plaintext credential using AES-256-GCM
 * 
 * @param plaintext - The sensitive credential to encrypt
 * @param key - The encryption key to use
 * @param keyId - Identifier for the encryption key (for key rotation)
 * @returns Encrypted credential structure
 * @throws EncryptionError if encryption fails
 */
export function encryptCredential(
  plaintext: string,
  key: Buffer,
  keyId: string
): EncryptedCredential {
  try {
    validateEncryptionKey(key);

    if (!plaintext) {
      throw new Error('Plaintext credential cannot be empty');
    }

    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Key ID must be a non-empty string');
    }

    // Generate a random IV for this encryption
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher and encrypt
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    // Encrypt the plaintext
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    // Get the authentication tag
    const authTag = cipher.getAuthTag();

    return {
      version: ENCRYPTED_CREDENTIAL_VERSION,
      keyId,
      iv: iv.toString('base64url'),
      authTag: authTag.toString('base64url'),
      ciphertext: encrypted.toString('base64url'),
    };
  } catch (error: any) {
    throw new EncryptionError(
      `Failed to encrypt credential: ${error.message}`,
      error
    );
  }
}

/**
 * Decrypts an encrypted credential using AES-256-GCM
 * 
 * @param encrypted - The encrypted credential structure
 * @param key - The decryption key
 * @returns Decrypted plaintext credential
 * @throws DecryptionError if decryption or authentication fails
 */
export function decryptCredential(
  encrypted: EncryptedCredential,
  key: Buffer
): string {
  try {
    validateEncryptionKey(key);

    // Validate encrypted credential structure
    if (!encrypted.version || !encrypted.keyId || !encrypted.iv || 
        !encrypted.authTag || !encrypted.ciphertext) {
      throw new Error('Invalid encrypted credential structure');
    }

    // Only support v1 format for now
    if (encrypted.version !== ENCRYPTED_CREDENTIAL_VERSION) {
      throw new Error(
        `Unsupported credential version: ${encrypted.version}`
      );
    }

    // Decode components
    const iv = Buffer.from(encrypted.iv, 'base64url');
    const authTag = Buffer.from(encrypted.authTag, 'base64url');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url');

    // Validate lengths
    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${authTag.length}`);
    }

    // Create decipher and decrypt
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    // Set the authentication tag
    decipher.setAuthTag(authTag);

    // Decrypt and verify
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // This will throw if authentication fails
    ]);

    return decrypted.toString('utf8');
  } catch (error: any) {
    // Authentication failure or other decryption errors
    throw new DecryptionError(
      `Failed to decrypt credential: ${error.message}`,
      error
    );
  }
}

/**
 * Serializes an encrypted credential to a single string for storage
 * Format: v1$keyId$iv$authTag$ciphertext (all base64url except version and keyId)
 * 
 * @param encrypted - Encrypted credential structure
 * @returns Serialized string
 */
export function serializeEncryptedCredential(encrypted: EncryptedCredential): string {
  return `${encrypted.version}$${encrypted.keyId}$${encrypted.iv}$${encrypted.authTag}$${encrypted.ciphertext}`;
}

/**
 * Parses a serialized encrypted credential string
 * 
 * @param serialized - Serialized credential string
 * @returns Encrypted credential structure
 * @throws Error if format is invalid
 */
export function parseEncryptedCredential(serialized: string): EncryptedCredential {
  const parts = serialized.split('$');
  
  if (parts.length !== 5) {
    throw new Error(
      `Invalid encrypted credential format: expected 5 parts, got ${parts.length}`
    );
  }

  const [version, keyId, iv, authTag, ciphertext] = parts;

  if (!version || !keyId || !iv || !authTag || !ciphertext) {
    throw new Error('Invalid encrypted credential: missing required components');
  }

  return { version, keyId, iv, authTag, ciphertext };
}

/**
 * Checks if a string appears to be an encrypted credential
 * 
 * @param value - String to check
 * @returns True if it looks like an encrypted credential
 */
export function isEncryptedCredential(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }
  return value.startsWith(`${ENCRYPTED_CREDENTIAL_VERSION}$`);
}

/**
 * Redacts a credential for safe logging
 * Shows only a prefix to aid debugging without exposing the full value
 * 
 * @param credential - Credential to redact (encrypted or plaintext)
 * @returns Redacted string safe for logs
 */
export function redactCredential(credential: string): string {
  if (!credential) {
    return '[empty]';
  }

  if (isEncryptedCredential(credential)) {
    // For encrypted credentials, show version and key ID
    const parts = credential.split('$');
    if (parts.length >= 2) {
      return `[encrypted:${parts[0]}:key=${parts[1]}]`;
    }
    return '[encrypted:format-error]';
  }

  // For plaintext, show only first 8 characters
  const prefix = credential.substring(0, 8);
  return `${prefix}...[${credential.length} chars]`;
}
