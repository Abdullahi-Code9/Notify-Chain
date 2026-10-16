/**
 * Payload Viewer & Copy Utilities
 * Resolves Issue #609 — Add Raw Event Payload Viewer
 * Resolves Issue #610 — Add Event Payload Copy Action
 */

import { copyTextToClipboard } from './clipboard';

/**
 * List of property names considered sensitive configuration or security credentials.
 * Matching fields will be redacted in the raw JSON view to prevent credential leakage.
 */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /private[_-]?key/i,
  /token/i,
  /auth(orization)?/i,
  /credential/i,
  /session/i,
  /cookie/i,
  /bearer/i,
];

/**
 * Recursively redacts sensitive configuration values from an object or array payload.
 *
 * Circular references are replaced with the string `"[Circular]"` so that
 * arbitrary/unknown event payloads remain stringifiable instead of throwing or
 * recursing forever (issue #612).
 */
export function sanitizePayload(data: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (seen.has(data as object)) {
    return '[Circular]';
  }
  seen.add(data as object);

  try {
    if (Array.isArray(data)) {
      return data.map((item) => sanitizePayload(item, seen));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive && typeof value === 'string') {
        sanitized[key] = '[REDACTED]';
      } else if (isSensitive && typeof value === 'number') {
        sanitized[key] = 0;
      } else if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizePayload(value, seen);
      }
    }

    return sanitized;
  } finally {
    // Track the current path only, so repeated (non-circular) references in
    // sibling fields are still fully rendered.
    seen.delete(data as object);
  }
}

export interface FormattedPayloadResult {
  /** The formatted string ready for rendering or copying */
  formatted: string;
  /** True if the original value was valid JSON */
  isValidJson: boolean;
  /** True if sensitive configuration fields were detected and redacted */
  hasRedactions: boolean;
}

/**
 * Parses and formats an event payload for display or clipboard copy.
 * Ensures invalid JSON payloads do not crash the UI (Issue #609).
 */
export function formatRawPayload(value: string | unknown): FormattedPayloadResult {
  if (value === null || value === undefined) {
    return { formatted: 'null', isValidJson: false, hasRedactions: false };
  }

  let parsed: unknown = value;
  let isValidJson = false;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        parsed = JSON.parse(trimmed);
        isValidJson = true;
      } catch {
        isValidJson = false;
      }
    } else {
      // Check if primitive string can be parsed as JSON number/boolean
      try {
        parsed = JSON.parse(trimmed);
        isValidJson = typeof parsed === 'object' && parsed !== null;
      } catch {
        isValidJson = false;
      }
    }
  } else {
    isValidJson = typeof value === 'object';
  }

  if (isValidJson && parsed !== null) {
    try {
      const sanitized = sanitizePayload(parsed);
      const formatted = JSON.stringify(sanitized, null, 2);
      if (typeof formatted !== 'string') {
        return { formatted: String(value), isValidJson: false, hasRedactions: false };
      }

      let hasRedactions = false;
      try {
        hasRedactions = JSON.stringify(parsed) !== JSON.stringify(sanitized);
      } catch {
        // Non-serialisable original (e.g. circular reference or BigInt):
        // fall back to detecting the redaction marker in the formatted output.
        hasRedactions = formatted.includes('[REDACTED]');
      }

      return { formatted, isValidJson: true, hasRedactions };
    } catch {
      return { formatted: String(value), isValidJson: false, hasRedactions: false };
    }
  }

  // Fallback for non-JSON string or invalid payloads
  return { formatted: String(value), isValidJson: false, hasRedactions: false };
}

export interface PayloadPreviewResult {
  /** Single-line, inspectable representation that is always safe to render. */
  preview: string;
  /** The full formatted payload (pretty-printed JSON where possible). */
  full: string;
  /** True when `preview` was shortened because the payload was long. */
  truncated: boolean;
}

/**
 * Produces a compact, single-line preview of an arbitrary payload for inline
 * rendering, together with the full inspectable representation.
 *
 * Unknown event types can carry payload shapes the dashboard has never seen
 * (objects, arrays, primitives), so this helper never throws and always
 * returns a string — preventing "Objects are not valid as a React child"
 * rendering exceptions (issue #612).
 */
export function formatPayloadPreview(value: unknown, maxLength = 160): PayloadPreviewResult {
  const { formatted } = formatRawPayload(value);
  const singleLine = formatted.replace(/\s+/g, ' ').trim();
  const safe = singleLine.length > 0 ? singleLine : 'No payload';

  if (maxLength <= 0 || safe.length <= maxLength) {
    return { preview: safe, full: formatted, truncated: false };
  }

  return {
    preview: `${safe.slice(0, Math.max(0, maxLength - 1))}…`,
    full: formatted,
    truncated: true,
  };
}

export interface CopyPayloadResult {
  success: boolean;
  copiedText: string;
  isJson: boolean;
}

/**
 * Copies the event payload to the clipboard as valid formatted JSON where possible (Issue #610).
 * Handles clipboard errors gracefully without throwing.
 */
export async function copyPayloadToClipboard(value: string | unknown): Promise<CopyPayloadResult> {
  const { formatted, isValidJson } = formatRawPayload(value);

  try {
    const success = await copyTextToClipboard(formatted);
    return {
      success,
      copiedText: formatted,
      isJson: isValidJson,
    };
  } catch {
    return {
      success: false,
      copiedText: formatted,
      isJson: isValidJson,
    };
  }
}
