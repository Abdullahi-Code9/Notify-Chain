/**
 * Tests for EventDecoderRegistry (Tasks 2 & 3)
 *
 * Coverage:
 * - Decoder registration, lookup, overwrite, removal
 * - Successful decoding produces a DecodedEvent<T>
 * - Unknown event name → RawUndecodedEvent with reason 'no_decoder'
 * - Decoder returning null → RawUndecodedEvent with reason 'decode_failed'
 * - Decoder throwing → RawUndecodedEvent with reason 'decode_failed'
 * - Raw events always preserve source identifiers (Task 2)
 * - API distinguishes decoded vs raw via `kind` discriminant (Task 2)
 * - Singleton helpers (get / set / reset)
 */

import {
  EventDecoderRegistry,
  getEventDecoderRegistry,
  resetEventDecoderRegistry,
  setEventDecoderRegistry,
  type DecoderInput,
  type DecodedEvent,
  type EventDecoder,
  type RawUndecodedEvent,
} from './event-decoder-registry';
import type { NormalizedEvent } from './event-normalization';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal NormalizedEvent factory. */
function makeNormalized(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'event-001',
    contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    eventName: 'notification_scheduled',
    eventType: 'contract',
    ledger: 1000,
    topic: ['notification_scheduled', 'GCREATOR', 'Notification', 'Medium'],
    value: '{"notification_id":"abc","payload_version":1}',
    txHash: 'tx-hash-001',
    payloadVersion: 1,
    ...overrides,
  };
}

/** Typed payload for a decoded notification_scheduled event. */
interface NotificationScheduledPayload {
  notificationId: string;
  payloadVersion: number;
}

/**
 * A simple well-behaved decoder for `notification_scheduled`.
 */
const notificationScheduledDecoder: EventDecoder<NotificationScheduledPayload> = {
  eventName: 'notification_scheduled',
  decode(input: DecoderInput): NotificationScheduledPayload | null {
    if (!input.payloadVersion) return null;
    return {
      notificationId: input.topic[1] ?? 'unknown',
      payloadVersion: input.payloadVersion,
    };
  },
};

/** A decoder that always returns null (simulating a parse failure). */
const alwaysNullDecoder: EventDecoder<never> = {
  eventName: 'bad_event',
  decode(): null {
    return null;
  },
};

/** A decoder that always throws. */
const alwaysThrowsDecoder: EventDecoder<never> = {
  eventName: 'throwing_event',
  decode(): never {
    throw new Error('Decoder internal error');
  },
};

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — registration', () => {
  let registry: EventDecoderRegistry;

  beforeEach(() => {
    registry = new EventDecoderRegistry();
  });

  it('registers a decoder and confirms with has()', () => {
    registry.register(notificationScheduledDecoder);
    expect(registry.has('notification_scheduled')).toBe(true);
  });

  it('listRegistered includes the registered event name', () => {
    registry.register(notificationScheduledDecoder);
    expect(registry.listRegistered()).toContain('notification_scheduled');
  });

  it('can register multiple decoders', () => {
    registry.register(notificationScheduledDecoder);
    registry.register(alwaysNullDecoder);
    expect(registry.listRegistered()).toHaveLength(2);
  });

  it('overwrites an existing decoder without throwing', () => {
    registry.register(notificationScheduledDecoder);
    const replacement: EventDecoder<{ replaced: true }> = {
      eventName: 'notification_scheduled',
      decode: () => ({ replaced: true }),
    };
    expect(() => registry.register(replacement)).not.toThrow();
    expect(registry.has('notification_scheduled')).toBe(true);
  });

  it('unregister removes a registered decoder', () => {
    registry.register(notificationScheduledDecoder);
    expect(registry.unregister('notification_scheduled')).toBe(true);
    expect(registry.has('notification_scheduled')).toBe(false);
  });

  it('unregister returns false for an unknown event name', () => {
    expect(registry.unregister('does_not_exist')).toBe(false);
  });

  it('throws when decoder eventName is empty', () => {
    const bad: EventDecoder<never> = { eventName: '', decode: () => null };
    expect(() => registry.register(bad)).toThrow(/non-empty string/);
  });

  it('clear removes all decoders', () => {
    registry.register(notificationScheduledDecoder);
    registry.register(alwaysNullDecoder);
    registry.clear();
    expect(registry.listRegistered()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Decoding — success path
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — decode (success)', () => {
  let registry: EventDecoderRegistry;

  beforeEach(() => {
    registry = new EventDecoderRegistry();
    registry.register(notificationScheduledDecoder);
  });

  it('returns a DecodedEvent with kind "decoded"', () => {
    const event = makeNormalized();
    const result = registry.decode(event);
    expect(result.kind).toBe('decoded');
  });

  it('decoded event carries source identifiers', () => {
    const event = makeNormalized({ eventId: 'my-event', contractAddress: 'CA123' });
    const result = registry.decode(event);
    expect(result.eventId).toBe('my-event');
    expect(result.contractAddress).toBe('CA123');
  });

  it('decoded event carries ledger and txHash', () => {
    const event = makeNormalized({ ledger: 9999, txHash: 'tx-xyz' });
    const result = registry.decode(event);
    expect(result.ledger).toBe(9999);
    expect(result.txHash).toBe('tx-xyz');
  });

  it('decoded event payload has typed fields', () => {
    const event = makeNormalized({ payloadVersion: 2 });
    const result = registry.decode<NotificationScheduledPayload>(event);
    if (result.kind !== 'decoded') throw new Error('Expected decoded');
    expect(result.payload.payloadVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Decoding — unknown event (Task 2 + 3)
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — decode (unknown event / fallback)', () => {
  let registry: EventDecoderRegistry;

  beforeEach(() => {
    registry = new EventDecoderRegistry();
    // Intentionally do NOT register a decoder for 'unknown_event'
  });

  it('returns RawUndecodedEvent with kind "raw" for unregistered event', () => {
    const event = makeNormalized({ eventName: 'unknown_event' });
    const result = registry.decode(event);
    expect(result.kind).toBe('raw');
  });

  it('raw result has reason "no_decoder"', () => {
    const event = makeNormalized({ eventName: 'unknown_event' });
    const result = registry.decode(event);
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.reason).toBe('no_decoder');
  });

  it('raw result preserves the source eventId (Task 2 — source identifiers)', () => {
    const event = makeNormalized({ eventId: 'preserve-me', eventName: 'unknown_event' });
    const result = registry.decode(event);
    expect(result.eventId).toBe('preserve-me');
  });

  it('raw result preserves contractAddress (Task 2)', () => {
    const event = makeNormalized({
      contractAddress: 'CA-UNKNOWN-CONTRACT',
      eventName: 'unknown_event',
    });
    const result = registry.decode(event);
    expect(result.contractAddress).toBe('CA-UNKNOWN-CONTRACT');
  });

  it('raw result preserves the raw topic array (Task 2)', () => {
    const event = makeNormalized({
      eventName: 'unknown_event',
      topic: ['unknown_event', 'raw_payload_data'],
    });
    const result = registry.decode(event);
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.rawTopic).toEqual(['unknown_event', 'raw_payload_data']);
  });

  it('raw result preserves the raw value string (Task 2)', () => {
    const event = makeNormalized({
      eventName: 'unknown_event',
      value: '{"some":"raw","data":true}',
    });
    const result = registry.decode(event);
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.rawValue).toBe('{"some":"raw","data":true}');
  });

  it('handles null eventName gracefully (completely unrecognized contract)', () => {
    const event = makeNormalized({ eventName: null as unknown as string });
    const result = registry.decode(event);
    expect(result.kind).toBe('raw');
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.reason).toBe('no_decoder');
  });
});

// ---------------------------------------------------------------------------
// Decoding — decoder returns null (parse failure)
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — decode (decoder returns null)', () => {
  let registry: EventDecoderRegistry;

  beforeEach(() => {
    registry = new EventDecoderRegistry();
    registry.register(alwaysNullDecoder);
  });

  it('returns RawUndecodedEvent when decoder returns null', () => {
    const event = makeNormalized({ eventName: 'bad_event' });
    const result = registry.decode(event);
    expect(result.kind).toBe('raw');
  });

  it('reason is "decode_failed" when decoder returns null', () => {
    const event = makeNormalized({ eventName: 'bad_event' });
    const result = registry.decode(event);
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.reason).toBe('decode_failed');
  });

  it('raw result still preserves source identifiers when decoder fails', () => {
    const event = makeNormalized({ eventId: 'fail-event-id', eventName: 'bad_event' });
    const result = registry.decode(event);
    expect(result.eventId).toBe('fail-event-id');
  });
});

// ---------------------------------------------------------------------------
// Decoding — decoder throws (pipeline robustness, Task 3)
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — decode (decoder throws)', () => {
  let registry: EventDecoderRegistry;

  beforeEach(() => {
    registry = new EventDecoderRegistry();
    registry.register(alwaysThrowsDecoder);
  });

  it('does not propagate decoder exceptions', () => {
    const event = makeNormalized({ eventName: 'throwing_event' });
    expect(() => registry.decode(event)).not.toThrow();
  });

  it('returns RawUndecodedEvent when decoder throws', () => {
    const event = makeNormalized({ eventName: 'throwing_event' });
    const result = registry.decode(event);
    expect(result.kind).toBe('raw');
  });

  it('reason is "decode_failed" when decoder throws', () => {
    const event = makeNormalized({ eventName: 'throwing_event' });
    const result = registry.decode(event);
    if (result.kind !== 'raw') throw new Error('Expected raw');
    expect(result.reason).toBe('decode_failed');
  });
});

// ---------------------------------------------------------------------------
// API distinguishes decoded vs raw (Task 2)
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — API discriminates decoded vs raw (Task 2)', () => {
  it('kind field is the sole discriminant — no instanceof checks needed', () => {
    const registry = new EventDecoderRegistry();
    registry.register(notificationScheduledDecoder);

    const decoded = registry.decode(makeNormalized());
    const raw = registry.decode(makeNormalized({ eventName: 'unfamiliar_event' }));

    // Callers branch on `kind` only:
    expect(decoded.kind).toBe('decoded');
    expect(raw.kind).toBe('raw');

    // TypeScript narrowing: these properties exist on each branch
    if (decoded.kind === 'decoded') {
      expect(decoded.payload).toBeDefined();
    }
    if (raw.kind === 'raw') {
      expect(raw.rawTopic).toBeDefined();
      expect(raw.rawValue).toBeDefined();
      expect(raw.reason).toBeDefined();
    }
  });

  it('decoded result does not expose rawTopic or rawValue', () => {
    const registry = new EventDecoderRegistry();
    registry.register(notificationScheduledDecoder);

    const result = registry.decode(makeNormalized());
    expect('rawTopic' in result).toBe(false);
    expect('rawValue' in result).toBe(false);
  });

  it('raw result does not expose a payload', () => {
    const registry = new EventDecoderRegistry();
    const result = registry.decode(makeNormalized({ eventName: 'unknown' }));
    expect('payload' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

describe('EventDecoderRegistry — singleton helpers', () => {
  afterEach(() => {
    resetEventDecoderRegistry();
  });

  it('getEventDecoderRegistry returns an EventDecoderRegistry', () => {
    const reg = getEventDecoderRegistry();
    expect(reg).toBeInstanceOf(EventDecoderRegistry);
  });

  it('getEventDecoderRegistry returns the same instance on repeated calls', () => {
    const a = getEventDecoderRegistry();
    const b = getEventDecoderRegistry();
    expect(a).toBe(b);
  });

  it('setEventDecoderRegistry replaces the singleton', () => {
    const custom = new EventDecoderRegistry();
    setEventDecoderRegistry(custom);
    expect(getEventDecoderRegistry()).toBe(custom);
  });

  it('resetEventDecoderRegistry forces a fresh instance on next get', () => {
    const first = getEventDecoderRegistry();
    resetEventDecoderRegistry();
    const second = getEventDecoderRegistry();
    expect(second).not.toBe(first);
  });
});
