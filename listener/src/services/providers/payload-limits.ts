/**
 * Pre-delivery payload-limit validation.
 *
 * Providers declare the payload constraints they can handle via
 * `ProviderMetadata.payloadLimits`. The orchestration layer (`ProviderRegistry`)
 * runs this validator before dispatch so a message that a provider cannot
 * handle is rejected with a descriptive error instead of being sent and
 * failing (or being silently truncated) downstream.
 */

import { PayloadLimits } from '../../types/provider-capabilities';

/** Fields inspected, in priority order, when measuring the message body. */
const BODY_KEYS = ['body', 'message', 'content', 'text', 'markdownContent'] as const;

/** Fields inspected, in priority order, when measuring the title/subject. */
const TITLE_KEYS = ['title', 'subject'] as const;

export type PayloadLimitKey = keyof PayloadLimits;

export interface PayloadLimitViolation {
  /** Which declared limit was exceeded. */
  limit: PayloadLimitKey;
  /** The observed value (length / count / bytes). */
  actual: number;
  /** The declared maximum. */
  max: number;
  /** Human-readable description, safe to surface to callers. */
  message: string;
}

export interface PayloadLimitValidationResult {
  valid: boolean;
  violations: PayloadLimitViolation[];
}

function firstStringLength(payload: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') {
      return value.length;
    }
  }
  return 0;
}

function attachmentCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.attachments) ? payload.attachments.length : 0;
}

/**
 * Validate a payload object against a provider's declared limits.
 *
 * @param payload - The outbound payload body (already a plain object).
 * @param limits  - The provider's declared limits, or `undefined` for none.
 * @returns `{ valid, violations }` — `valid` is `true` when no limit is exceeded.
 */
export function validatePayloadLimits(
  payload: Record<string, unknown> | undefined,
  limits: PayloadLimits | undefined
): PayloadLimitValidationResult {
  const violations: PayloadLimitViolation[] = [];
  if (!limits) {
    return { valid: true, violations };
  }

  const body = payload ?? {};

  if (limits.maxBodyLength !== undefined) {
    const actual = firstStringLength(body, BODY_KEYS);
    if (actual > limits.maxBodyLength) {
      violations.push({
        limit: 'maxBodyLength',
        actual,
        max: limits.maxBodyLength,
        message: `message body length ${actual} exceeds the provider maximum of ${limits.maxBodyLength}`,
      });
    }
  }

  if (limits.maxTitleLength !== undefined) {
    const actual = firstStringLength(body, TITLE_KEYS);
    if (actual > limits.maxTitleLength) {
      violations.push({
        limit: 'maxTitleLength',
        actual,
        max: limits.maxTitleLength,
        message: `title/subject length ${actual} exceeds the provider maximum of ${limits.maxTitleLength}`,
      });
    }
  }

  if (limits.maxAttachmentCount !== undefined) {
    const actual = attachmentCount(body);
    if (actual > limits.maxAttachmentCount) {
      violations.push({
        limit: 'maxAttachmentCount',
        actual,
        max: limits.maxAttachmentCount,
        message: `attachment count ${actual} exceeds the provider maximum of ${limits.maxAttachmentCount}`,
      });
    }
  }

  if (limits.maxFieldCount !== undefined) {
    const actual = Object.keys(body).length;
    if (actual > limits.maxFieldCount) {
      violations.push({
        limit: 'maxFieldCount',
        actual,
        max: limits.maxFieldCount,
        message: `payload field count ${actual} exceeds the provider maximum of ${limits.maxFieldCount}`,
      });
    }
  }

  if (limits.maxPayloadBytes !== undefined) {
    let actual: number;
    try {
      actual = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
      // A non-serializable payload cannot be measured; surface it as oversized
      // so the caller receives an explicit, actionable error.
      actual = limits.maxPayloadBytes + 1;
    }
    if (actual > limits.maxPayloadBytes) {
      violations.push({
        limit: 'maxPayloadBytes',
        actual,
        max: limits.maxPayloadBytes,
        message: `serialized payload size ${actual} bytes exceeds the provider maximum of ${limits.maxPayloadBytes}`,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}
