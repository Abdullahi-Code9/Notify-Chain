/**
 * Explicit contract for turning a raw Soroban RPC event into the listener's
 * internal event model (issue #948).
 *
 * Input is the RPC event plus the contract it was read from. Output is either
 * a normalized event or a list of parse errors. Topic and value formatting
 * stay on the existing helpers, so supported event names keep their current
 * shape.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { formatScValArray, formatScValValue } from '../utils/scval-format';
import {
  EventParseError,
  EventParseErrorCategory,
  getEventName,
  parseEventVersion,
  validateEventPayload,
} from '../utils/event-utils';

/** RPC event types this listener already accepts and passes through unchanged. */
export const SUPPORTED_RPC_EVENT_TYPES = ['contract', 'system', 'diagnostic'] as const;

export type SupportedRpcEventType = (typeof SUPPORTED_RPC_EVENT_TYPES)[number];

export interface NormalizationContext {
  contractAddress: string;
}

export interface NormalizedEvent {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  eventType: string;
  ledger: number;
  topic: string[];
  value: string;
  txHash: string | null;
  payloadVersion: number | null;
}

export type NormalizationResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; errors: EventParseError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(field: string | null, detail: string): EventParseError {
  return { category: EventParseErrorCategory.MalformedPayload, field, detail };
}

function missing(field: string, detail: string): EventParseError {
  return { category: EventParseErrorCategory.MissingField, field, detail };
}

/**
 * Convert one raw Soroban event into the internal model.
 *
 * A failed result lists every problem found on the payload and the contract
 * context. Error details name fields only; they do not echo untrusted values.
 */
export function normalizeSorobanEvent(
  event: unknown,
  context: NormalizationContext,
): NormalizationResult {
  const errors: EventParseError[] = [];

  if (
    !context ||
    typeof context.contractAddress !== 'string' ||
    context.contractAddress.trim() === ''
  ) {
    errors.push(missing('contractAddress', 'Contract address is required to normalize an event'));
  }

  if (!isRecord(event)) {
    errors.push(malformed(null, 'Event payload is missing or not an object'));
    return { ok: false, errors };
  }

  const validation = validateEventPayload(event as unknown as StellarSDK.rpc.Api.EventResponse);
  if (!validation.valid && validation.error) {
    errors.push(validation.error);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const raw = event as unknown as StellarSDK.rpc.Api.EventResponse;
  let topic: string[];
  let value: string;
  let eventName: string | null;

  try {
    topic = formatScValArray(raw.topic);
    value = formatScValValue(raw.value);
    eventName = getEventName(raw.topic);
  } catch {
    return {
      ok: false,
      errors: [malformed('topic', 'Event topic or value could not be decoded')],
    };
  }

  const version = parseEventVersion(raw.value);
  const payloadVersion = version.found && version.version !== undefined ? version.version : null;
  const txHash = typeof raw.txHash === 'string' && raw.txHash.length > 0 ? raw.txHash : null;

  return {
    ok: true,
    event: {
      eventId: raw.id,
      contractAddress: context.contractAddress.trim(),
      eventName,
      eventType: raw.type,
      ledger: raw.ledger,
      topic,
      value,
      txHash,
      payloadVersion,
    },
  };
}
