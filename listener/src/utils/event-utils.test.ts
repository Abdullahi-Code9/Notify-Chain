import { xdr } from '@stellar/stellar-sdk';
import {
  EventParseErrorCategory,
  classifyEvent,
  describeEventParseError,
  getEventName,
  matchesEventFilter,
  validateEventPayload,
  validateRpcResponse,
  parseEventVersion,
  validateEventVersion,
  CURRENT_EVENT_VERSION,
  SUPPORTED_EVENT_VERSIONS,
} from './event-utils';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';

function createValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    type: 'contract',
    ledger: 100,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'hash',
    topic: [xdr.ScVal.scvSymbol('TaskCreated')],
    value: xdr.ScVal.scvU32(1),
    ...overrides,
  };
}

function createValidRpcResponse(overrides: Record<string, unknown> = {}) {
  return {
    latestLedger: 123,
    events: [
      {
        id: 'event-1',
        type: 'contract',
        ledger: 100,
        txHash: 'hash',
        topic: [],
        value: 1,
      },
    ],
    cursor: 'cursor-1',
    ...overrides,
  };
}

describe('event-utils', () => {
  describe('validateEventPayload', () => {
    it('accepts a complete event payload', () => {
      expect(validateEventPayload(createValidEvent() as any)).toEqual({
        valid: true,
      });
    });

    it('rejects missing event id', () => {
      const result = validateEventPayload(createValidEvent({ id: '' }) as any);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/id/i);
    });

    it('rejects missing event type', () => {
      const result = validateEventPayload(
        createValidEvent({ type: undefined }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/type/i);
    });

    it('rejects invalid ledger values', () => {
      const result = validateEventPayload(createValidEvent({ ledger: -1 }) as any);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/ledger/i);
    });

    it('rejects non-array topics', () => {
      const result = validateEventPayload(
        createValidEvent({ topic: undefined }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/topic/i);
    });

    it('rejects missing event value', () => {
      const result = validateEventPayload(
        createValidEvent({ value: undefined }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/value/i);
    });
  });

  describe('getEventName', () => {
    it('extracts symbol names from topics', () => {
      expect(
        getEventName([xdr.ScVal.scvSymbol('AutoshareCreated')])
      ).toBe('AutoshareCreated');
    });

    it('returns null for empty topics', () => {
      expect(getEventName([])).toBeNull();
    });
  });

  describe('matchesEventFilter', () => {
    it('matches all events when wildcard is configured', () => {
      expect(matchesEventFilter('TaskCreated', ['*'])).toBe(true);
      expect(matchesEventFilter(null, ['*'])).toBe(true);
    });

    it('matches only configured event names', () => {
      expect(matchesEventFilter('TaskCreated', ['TaskCreated'])).toBe(true);
      expect(matchesEventFilter('WorkSubmitted', ['TaskCreated'])).toBe(false);
    });

    it('rejects unnamed events when specific filters are configured', () => {
      expect(matchesEventFilter(null, ['TaskCreated'])).toBe(false);
    });
  });

  describe('validateRpcResponse', () => {
    it('accepts a complete RPC response', () => {
      expect(validateRpcResponse(createValidRpcResponse() as any)).toEqual({
        valid: true,
      });
    });

    it('rejects a null response', () => {
      const result = validateRpcResponse(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });

    it('rejects a non-object response', () => {
      const result = validateRpcResponse('not-an-object' as any);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not an object/i);
    });

    it('rejects a response missing the events field', () => {
      const result = validateRpcResponse(
        createValidRpcResponse({ events: undefined }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/events/i);
    });

    it('rejects a response whose events field is not an array', () => {
      const result = validateRpcResponse(
        createValidRpcResponse({ events: 'not-an-array' }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/events field is not an array/i);
    });

    it('rejects a response whose cursor is not a string', () => {
      const result = validateRpcResponse(
        createValidRpcResponse({ cursor: 123 }) as any
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/cursor/i);
    });

    it('accepts a response without a cursor', () => {
      const { cursor, ...rest } = createValidRpcResponse();
      expect(validateRpcResponse(rest as any)).toEqual({ valid: true });
    });
  });

  // -------------------------------------------------------------------------
  // Error classification (#832)
  // -------------------------------------------------------------------------

  describe('validateEventPayload error classification', () => {
    it('classifies a field that is present but of the wrong type as invalid_type', () => {
      const result = validateEventPayload(createValidEvent({ id: 42 }) as any);

      expect(result.valid).toBe(false);
      expect(result.error).toEqual({
        category: EventParseErrorCategory.InvalidType,
        field: 'id',
        detail: 'Missing or invalid event id',
      });
    });

    it.each([
      ['id', { id: undefined }, 'id'],
      ['an empty id', { id: '' }, 'id'],
      ['type', { type: undefined }, 'type'],
      ['ledger', { ledger: undefined }, 'ledger'],
      ['topic', { topic: undefined }, 'topic'],
      ['value', { value: undefined }, 'value'],
    ])('classifies %s as missing_field', (_label, overrides, field) => {
      const result = validateEventPayload(createValidEvent(overrides as any) as any);

      expect(result.valid).toBe(false);
      expect(result.error?.category).toBe(EventParseErrorCategory.MissingField);
      expect(result.error?.field).toBe(field);
    });

    it('classifies a right-typed but out-of-range ledger as malformed_payload', () => {
      const negative = validateEventPayload(createValidEvent({ ledger: -1 }) as any);
      const fractional = validateEventPayload(createValidEvent({ ledger: 1.5 }) as any);

      expect(negative.error?.category).toBe(EventParseErrorCategory.MalformedPayload);
      expect(negative.error?.field).toBe('ledger');
      expect(fractional.error?.category).toBe(EventParseErrorCategory.MalformedPayload);
    });

    it('classifies a non-object payload as malformed_payload without a field', () => {
      const result = validateEventPayload(null as any);

      expect(result.error?.category).toBe(EventParseErrorCategory.MalformedPayload);
      expect(result.error?.field).toBeNull();
    });

    it('still exposes a human-readable reason alongside the category', () => {
      const result = validateEventPayload(createValidEvent({ value: undefined }) as any);

      // Backward compatibility: callers that only log `reason` keep working.
      expect(result.reason).toMatch(/value/i);
      expect(result.error?.detail).toBe(result.reason);
    });

    it('omits the classification entirely when the payload is valid', () => {
      const result = validateEventPayload(createValidEvent() as any);

      expect(result).toEqual({ valid: true });
      expect(result.error).toBeUndefined();
    });
  });

  describe('validateRpcResponse error classification', () => {
    it('classifies a missing events field as missing_field', () => {
      const result = validateRpcResponse(createValidRpcResponse({ events: undefined }) as any);

      expect(result.error).toEqual({
        category: EventParseErrorCategory.MissingField,
        field: 'events',
        detail: 'RPC response is missing the events field',
      });
    });

    it('classifies a non-array events field as invalid_type', () => {
      const result = validateRpcResponse(createValidRpcResponse({ events: 'nope' }) as any);

      expect(result.error?.category).toBe(EventParseErrorCategory.InvalidType);
      expect(result.error?.field).toBe('events');
    });

    it('classifies a non-string cursor as invalid_type', () => {
      const result = validateRpcResponse(createValidRpcResponse({ cursor: 123 }) as any);

      expect(result.error?.category).toBe(EventParseErrorCategory.InvalidType);
      expect(result.error?.field).toBe('cursor');
    });

    it('classifies a non-object response as malformed_payload', () => {
      expect(validateRpcResponse(null).error?.category).toBe(
        EventParseErrorCategory.MalformedPayload
      );
      expect(validateRpcResponse('nope' as any).error?.category).toBe(
        EventParseErrorCategory.MalformedPayload
      );
    });
  });

  describe('classifyEvent', () => {
    it('processes a valid, allow-listed event', () => {
      const result = classifyEvent(createValidEvent() as any, ['TaskCreated']);

      expect(result).toEqual({
        action: 'process',
        category: null,
        eventName: 'TaskCreated',
      });
    });

    it('processes any event when the allow-list is a wildcard', () => {
      expect(classifyEvent(createValidEvent() as any, ['*']).action).toBe('process');
      expect(classifyEvent(createValidEvent() as any, []).action).toBe('process');
    });

    it('distinguishes a named but unsupported event from a parse failure', () => {
      const result = classifyEvent(createValidEvent() as any, ['WorkSubmitted']);

      expect(result.action).toBe('skip');
      expect(result.category).toBe(EventParseErrorCategory.UnsupportedEvent);
      expect(result.eventName).toBe('TaskCreated');
      expect(result.error?.detail).toMatch(/not in the configured allow-list/);
      // A filter outcome is not a payload defect, so no field is blamed.
      expect(result.error?.field).toBeNull();
    });

    it('classifies an undecodable topic as malformed_payload, not unsupported_event', () => {
      // A topic the listener cannot decode is a format mismatch, not a routine
      // filtering outcome -- conflating them would hide real ingestion faults.
      const event = createValidEvent({ topic: [xdr.ScVal.scvU32(7)] });
      const result = classifyEvent(event as any, ['TaskCreated']);

      expect(result.action).toBe('skip');
      expect(result.category).toBe(EventParseErrorCategory.MalformedPayload);
      expect(result.eventName).toBeNull();
      expect(result.error?.field).toBe('topic');
    });

    it('reports the payload classification for an invalid event', () => {
      const result = classifyEvent(createValidEvent({ ledger: undefined }) as any, ['*']);

      expect(result.action).toBe('skip');
      expect(result.category).toBe(EventParseErrorCategory.MissingField);
      expect(result.error?.field).toBe('ledger');
    });

    it('never echoes untrusted field values into the classification', () => {
      const untrusted = 'attacker-controlled-content';
      const result = classifyEvent(createValidEvent({ type: 99, txHash: untrusted }) as any, ['*']);

      expect(result.action).toBe('skip');
      expect(result.category).toBe(EventParseErrorCategory.InvalidType);
      // Diagnostics name the field, never its contents.
      expect(JSON.stringify(result)).not.toContain(untrusted);
    });
  });

  describe('describeEventParseError', () => {
    it('renders a stable token for log fields and metric labels', () => {
      expect(
        describeEventParseError({
          category: EventParseErrorCategory.MissingField,
          field: 'ledger',
          detail: 'Missing or invalid ledger',
        })
      ).toBe('missing_field:ledger');

      expect(
        describeEventParseError({
          category: EventParseErrorCategory.UnsupportedEvent,
          field: null,
          detail: 'nope',
        })
      ).toBe('unsupported_event');
    });

    it('produces four distinct tokens for the four categories', () => {
      const tokens = new Set([
        EventParseErrorCategory.MissingField,
        EventParseErrorCategory.InvalidType,
        EventParseErrorCategory.MalformedPayload,
        EventParseErrorCategory.UnsupportedEvent,
      ]);

      expect(tokens.size).toBe(4);
    });
  });
});
