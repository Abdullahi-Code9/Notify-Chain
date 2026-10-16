import * as StellarSDK from '@stellar/stellar-sdk';

/**
 * Actionable categories for event parsing failures (#832).
 *
 * Before this, every failure surfaced as a free-text `reason` string. A caller
 * could log it, but could not *act* on it: a missing field (a non-conforming
 * emitter, worth flagging) was indistinguishable from an unsupported event (an
 * ordinary configuration outcome) or a malformed payload (a protocol/RPC
 * problem, worth alerting on). Callers ended up doing `/id/i.test(reason)`
 * matching, or treating everything as "skipped".
 *
 * The categories are intentionally coarse and behavioural:
 *
 * - `missing_field`     — the payload is well-formed but a required field is
 *                         absent/empty. Usually the event producer's fault.
 * - `invalid_type`      — a field is present with an unusable type. Also a
 *                         producer/protocol mismatch, but a different fix.
 * - `malformed_payload` — the structure is not usable at all: a non-object, a
 *                         field whose *value* is out of range, or a topic that
 *                         cannot be decoded. Points at the RPC boundary.
 * - `unsupported_event` — a valid, named event that simply is not part of the
 *                         configured allow-list. Not an error condition; the
 *                         normal filtering outcome, kept distinct so it does
 *                         not drown out real parse failures in logs/metrics.
 */
export const EventParseErrorCategory = {
  MissingField: 'missing_field',
  InvalidType: 'invalid_type',
  MalformedPayload: 'malformed_payload',
  UnsupportedEvent: 'unsupported_event',
} as const;

export type EventParseErrorCategory =
  (typeof EventParseErrorCategory)[keyof typeof EventParseErrorCategory];

/**
 * A classified parsing failure.
 *
 * `field` names the offending field where one can be identified (`null` for
 * whole-payload problems and for filter outcomes). `detail` is a fixed,
 * non-sensitive description — it never echoes the field's value, since event
 * data is untrusted and may contain anything.
 */
export interface EventParseError {
  category: EventParseErrorCategory;
  field: string | null;
  detail: string;
}

export interface EventValidationResult {
  valid: boolean;
  /** Human-readable description. Retained for backward compatibility. */
  reason?: string;
  /** Structured classification of the failure. Absent when `valid` is true. */
  error?: EventParseError;
}

export interface RpcResponseValidationResult {
  valid: boolean;
  /** Human-readable description. Retained for backward compatibility. */
  reason?: string;
  /** Structured classification of the failure. Absent when `valid` is true. */
  error?: EventParseError;
}

/**
 * What a caller should do with an event, and why.
 *
 * `action` is the decision; `category` is `null` only when the event is
 * processable. This replaces the previous boolean-only contract from
 * `matchesEventFilter`, which could express "skip" but not "skip because".
 */
export interface EventClassification {
  action: 'process' | 'skip';
  category: EventParseErrorCategory | null;
  eventName: string | null;
  error?: EventParseError;
}

function missingField(field: string, detail: string): {
  valid: false;
  reason: string;
  error: EventParseError;
} {
  return {
    valid: false,
    reason: detail,
    error: { category: EventParseErrorCategory.MissingField, field, detail },
  };
}

function invalidType(field: string, detail: string): {
  valid: false;
  reason: string;
  error: EventParseError;
} {
  return {
    valid: false,
    reason: detail,
    error: { category: EventParseErrorCategory.InvalidType, field, detail },
  };
}

function malformedPayload(field: string | null, detail: string): {
  valid: false;
  reason: string;
  error: EventParseError;
} {
  return {
    valid: false,
    reason: detail,
    error: { category: EventParseErrorCategory.MalformedPayload, field, detail },
  };
}

/**
 * Renders a parse error as a single stable token for log fields and metric
 * labels, e.g. `missing_field:ledger`.
 *
 * Kept stable and low-cardinality on purpose: it is meant to be grouped on.
 */
export function describeEventParseError(error: EventParseError): string {
  return error.field ? `${error.category}:${error.field}` : error.category;
}

/**
 * The current event payload protocol version understood by this listener.
 * Matches `CURRENT_NOTIFICATION_VERSION` in the Soroban contract.
 */
export const CURRENT_EVENT_VERSION = 1;

/**
 * All event payload versions this listener can process.
 * Add a new entry here whenever the contract introduces a new schema version.
 */
export const SUPPORTED_EVENT_VERSIONS: ReadonlySet<number> = new Set([1]);

export interface EventVersionParseResult {
  /** Whether a version field was present and could be read. */
  found: boolean;
  /**
   * The numeric version extracted from the payload.
   * `undefined` when `found` is false (no version field present).
   */
  version: number | undefined;
  /**
   * Human-readable reason when the value could not be parsed as a valid
   * version number (e.g. wrong XDR type, non-integer).
   * Only set when `found` is true but the value is unusable.
   */
  parseError?: string;
}

/**
 * Attempt to extract `payload_version` from a raw Soroban `ScVal`.
 *
 * The Soroban contract serialises versioned event data as either:
 *   - An `ScvMap` containing a `payload_version` key (e.g. `NotificationScheduled`)
 *   - A direct `ScvU32` / `ScvU64` integer (future single-field events)
 *
 * Events that pre-date versioning (no `payload_version` key) return
 * `{ found: false, version: undefined }` so callers can apply a default
 * without breaking existing integrations.
 *
 * @param value - Raw `ScVal` from `StellarSDK.rpc.Api.EventResponse.value`
 */
export function parseEventVersion(value: StellarSDK.xdr.ScVal): EventVersionParseResult {
  if (value === undefined || value === null) {
    return { found: false, version: undefined };
  }

  try {
    const native = StellarSDK.scValToNative(value);

    // Case 1: struct/map — look for a payload_version key
    if (native !== null && typeof native === 'object' && !Array.isArray(native)) {
      const record = native as Record<string, unknown>;
      const raw = record['payload_version'];

      if (raw === undefined || raw === null) {
        // Map present but no payload_version key — pre-versioned event
        return { found: false, version: undefined };
      }

      const ver = Number(raw);
      if (!Number.isInteger(ver) || ver < 1) {
        return {
          found: true,
          version: undefined,
          parseError: `payload_version is not a positive integer: ${raw}`,
        };
      }

      return { found: true, version: ver };
    }

    // Case 2: bare integer value (u32 / u64 / i128 all convert to number/bigint)
    if (typeof native === 'number' || typeof native === 'bigint') {
      const ver = Number(native);
      if (!Number.isInteger(ver) || ver < 1) {
        return {
          found: true,
          version: undefined,
          parseError: `payload_version integer is not a positive integer: ${native}`,
        };
      }
      return { found: true, version: ver };
    }

    // Any other type (string, array, boolean…) — not a version field
    return { found: false, version: undefined };
  } catch {
    // scValToNative threw — XDR is malformed; treat as no version
    return { found: false, version: undefined };
  }
}

/**
 * Validate that the version extracted by `parseEventVersion` is supported.
 *
 * Returns `{ valid: true }` for:
 *   - Events with no version field (pre-versioning, treated as v1 for
 *     backward compatibility)
 *   - Events whose version is in `SUPPORTED_EVENT_VERSIONS`
 *
 * Returns `{ valid: false, reason }` for:
 *   - Malformed version values (non-integer, negative)
 *   - Versions greater than `CURRENT_EVENT_VERSION` (unknown future schema)
 *   - Versions that were explicitly removed from `SUPPORTED_EVENT_VERSIONS`
 */
export function validateEventVersion(value: StellarSDK.xdr.ScVal): EventValidationResult {
  const parsed = parseEventVersion(value);

  // No version field — backward-compatible; accept as v1
  if (!parsed.found) {
    return { valid: true };
  }

  // Version field found but could not be parsed as a usable integer
  if (parsed.version === undefined) {
    return {
      valid: false,
      reason: `Unsupported event payload version: ${parsed.parseError}`,
    };
  }

  if (!SUPPORTED_EVENT_VERSIONS.has(parsed.version)) {
    return {
      valid: false,
      reason: `Unsupported event payload version ${parsed.version}; supported versions are [${[...SUPPORTED_EVENT_VERSIONS].join(', ')}]`,
    };
  }

  return { valid: true };
}

export function validateRpcResponse(
  response: StellarSDK.rpc.Api.GetEventsResponse | null | undefined
): RpcResponseValidationResult {
  if (!response || typeof response !== 'object') {
    return malformedPayload(null, 'RPC response is missing or not an object');
  }

  if (response.events === undefined || response.events === null) {
    return missingField('events', 'RPC response is missing the events field');
  }

  if (!Array.isArray(response.events)) {
    return invalidType('events', 'RPC response events field is not an array');
  }

  if (response.cursor !== undefined && typeof response.cursor !== 'string') {
    return invalidType('cursor', 'RPC response cursor field is not a string');
  }

  return { valid: true };
}

export function validateEventPayload(
  event: StellarSDK.rpc.Api.EventResponse
): EventValidationResult {
  if (!event || typeof event !== 'object') {
    return malformedPayload(null, 'Event payload is missing or not an object');
  }

  if (event.id === undefined || event.id === null || event.id === '') {
    return missingField('id', 'Missing or invalid event id');
  }
  if (typeof event.id !== 'string') {
    return invalidType('id', 'Missing or invalid event id');
  }

  // `EventType` is a non-empty literal union, so an emptiness check cannot be
  // written as `=== ''` without a type error; falsiness covers undefined/null/
  // empty in one place. A present-but-non-string value is caught below.
  if (!event.type) {
    return missingField('type', 'Missing or invalid event type');
  }
  if (typeof event.type !== 'string') {
    return invalidType('type', 'Missing or invalid event type');
  }

  if (event.ledger === undefined || event.ledger === null) {
    return missingField('ledger', 'Missing or invalid ledger');
  }
  if (typeof event.ledger !== 'number' || !Number.isFinite(event.ledger)) {
    return invalidType('ledger', 'Missing or invalid ledger');
  }
  if (!Number.isInteger(event.ledger) || event.ledger < 0) {
    // Right type, unusable value: a range/shape problem rather than a missing
    // or mis-typed field.
    return malformedPayload('ledger', 'Missing or invalid ledger');
  }

  if (event.topic === undefined || event.topic === null) {
    return missingField('topic', 'Missing or invalid topic');
  }
  if (!Array.isArray(event.topic)) {
    return invalidType('topic', 'Missing or invalid topic');
  }

  if (event.value === undefined || event.value === null) {
    return missingField('value', 'Missing event value');
  }

  return { valid: true };
}

export function getEventName(topic: StellarSDK.xdr.ScVal[]): string | null {
  if (!topic || topic.length === 0) {
    return null;
  }

  for (const entry of topic) {
    const name = scValToString(entry);
    if (name) {
      return name;
    }
  }

  return null;
}

export function matchesEventFilter(
  eventName: string | null,
  allowedEvents: string[]
): boolean {
  if (!allowedEvents || allowedEvents.length === 0 || allowedEvents.includes('*')) {
    return true;
  }

  if (!eventName) {
    return false;
  }

  return allowedEvents.includes(eventName);
}

/**
 * Classifies an event into a single actionable outcome.
 *
 * This composes the three checks the subscriber used to perform inline —
 * payload validation, name extraction and allow-list filtering — so the reason
 * a batch item was dropped is one value instead of three inferred ones. The
 * distinction that matters most in practice:
 *
 * - a named event outside the allow-list is `unsupported_event` (expected,
 *   routine, should not page anyone), whereas
 * - a topic that yields no name while the allow-list is specific is
 *   `malformed_payload` (the topic format is not what this listener expects,
 *   which is a real signal).
 *
 * @param event         - Candidate event from the RPC response.
 * @param allowedEvents - Configured allow-list; empty or `['*']` means all.
 */
export function classifyEvent(
  event: StellarSDK.rpc.Api.EventResponse,
  allowedEvents: string[]
): EventClassification {
  const validation = validateEventPayload(event);
  if (!validation.valid) {
    const result: EventClassification = {
      action: 'skip',
      category: validation.error?.category ?? EventParseErrorCategory.MalformedPayload,
      eventName: null,
    };
    if (validation.error) {
      result.error = validation.error;
    }
    return result;
  }

  const eventName = getEventName(event.topic);

  if (!matchesEventFilter(eventName, allowedEvents)) {
    if (eventName === null) {
      const error: EventParseError = {
        category: EventParseErrorCategory.MalformedPayload,
        field: 'topic',
        detail: 'Event topic does not decode to a known event name',
      };
      return { action: 'skip', category: error.category, eventName: null, error };
    }

    const error: EventParseError = {
      category: EventParseErrorCategory.UnsupportedEvent,
      field: null,
      detail: `Event "${eventName}" is not in the configured allow-list`,
    };
    return { action: 'skip', category: error.category, eventName, error };
  }

  return { action: 'process', category: null, eventName };
}

function scValToString(val: StellarSDK.xdr.ScVal): string | null {
  switch (val.switch()) {
    case StellarSDK.xdr.ScValType.scvSymbol():
      return val.sym().toString();
    case StellarSDK.xdr.ScValType.scvString():
      return val.str().toString();
    default:
      return null;
  }
}
