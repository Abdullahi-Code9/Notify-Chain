/**
 * Notification metadata validation.
 *
 * Ensures required fields are present and correctly formatted before a
 * notification is persisted. Invalid metadata is rejected early so malformed
 * data never reaches storage.
 */

import { validateExternalReference } from './reference-validator';

/** Maximum length for a single metadata string value. */
export const MAX_METADATA_STRING_LENGTH = 256;

/** Maximum number of custom metadata keys. */
export const MAX_METADATA_FIELDS = 20;

/** Required metadata keys that must be present when metadata is provided. */
export const REQUIRED_METADATA_FIELDS = ['source'] as const;

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataValidationError';
  }
}

export interface NotificationMetadataInput {
  /** Originating system / contract identifier (required when metadata is set). */
  source?: unknown;
  /** Optional human-readable description. */
  description?: unknown;
  /** Optional URI to additional payload data. */
  dataUri?: unknown;
  /** Arbitrary extra fields (string values only). */
  [key: string]: unknown;
}

/**
 * Validate notification metadata before storage.
 *
 * Rules:
 * - If `metadata` is null/undefined, it is treated as absent (valid).
 * - Must be a plain object (not an array).
 * - Required fields (currently `source`) must be non-empty strings.
 * - Optional string fields must not exceed MAX_METADATA_STRING_LENGTH.
 * - Total custom keys must not exceed MAX_METADATA_FIELDS.
 * - All values must be strings, numbers, or booleans (no nested objects/arrays).
 *
 * @throws {MetadataValidationError} when validation fails.
 */
export function validateNotificationMetadata(
  metadata: Record<string, unknown> | null | undefined
): void {
  if (metadata === null || metadata === undefined) {
    return;
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new MetadataValidationError('metadata must be a plain object');
  }

  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_FIELDS) {
    throw new MetadataValidationError(
      `metadata may contain at most ${MAX_METADATA_FIELDS} fields`
    );
  }

  for (const required of REQUIRED_METADATA_FIELDS) {
    const value = metadata[required];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new MetadataValidationError(
        `metadata.${required} is required and must be a non-empty string`
      );
    }
  }

  for (const key of keys) {
    if (key.length > MAX_METADATA_STRING_LENGTH) {
      throw new MetadataValidationError(
        `metadata key "${key.slice(0, 32)}…" exceeds ${MAX_METADATA_STRING_LENGTH} characters`
      );
    }

    const value = metadata[key];
    if (value === null || value === undefined) {
      throw new MetadataValidationError(`metadata.${key} must not be null`);
    }

    if (typeof value === 'object') {
      throw new MetadataValidationError(
        `metadata.${key} must be a string, number, or boolean (nested values are not allowed)`
      );
    }

    if (typeof value === 'string' && value.length > MAX_METADATA_STRING_LENGTH) {
      throw new MetadataValidationError(
        `metadata.${key} exceeds ${MAX_METADATA_STRING_LENGTH} characters`
      );
    }

    if (key === 'dataUri' && typeof value === 'string') {
      try {
        validateExternalReference(value, 'metadata.dataUri');
      } catch {
        throw new MetadataValidationError(
          'metadata.dataUri must be a valid IPFS or Arweave reference',
        );
      }
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new MetadataValidationError(
        `metadata.${key} has unsupported type ${typeof value}`
      );
    }
  }
}
