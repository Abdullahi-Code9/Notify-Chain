import { xdr } from '@stellar/stellar-sdk';
import { EventParseErrorCategory, getEventName } from '../utils/event-utils';
import { formatScValArray, formatScValValue } from '../utils/scval-format';
import { SUPPORTED_RPC_EVENT_TYPES, normalizeSorobanEvent } from './event-normalization';

const CONTRACT = 'CCONTRACTADDRESS';

const SUPPORTED_EVENT_NAMES = [
  'AutoshareCreated',
  'NotificationScheduled',
  'NotificationDelivered',
  'NotificationExpired',
  'NotificationRevoked',
] as const;

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    type: 'contract',
    ledger: 100,
    txHash: 'abc123',
    topic: [xdr.ScVal.scvSymbol('NotificationScheduled')],
    value: xdr.ScVal.scvU32(1),
    ...overrides,
  };
}

describe('normalizeSorobanEvent', () => {
  it.each(SUPPORTED_EVENT_NAMES)('keeps the %s event name and formatted fields', (eventName) => {
    const topic = [xdr.ScVal.scvSymbol(eventName)];
    const value = xdr.ScVal.scvU32(1);
    const result = normalizeSorobanEvent(rawEvent({ topic, value }), { contractAddress: CONTRACT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.event.eventName).toBe(getEventName(topic));
    expect(result.event.topic).toEqual(formatScValArray(topic));
    expect(result.event.value).toBe(formatScValValue(value));
    expect(result.event.eventType).toBe('contract');
  });

  it.each(SUPPORTED_RPC_EVENT_TYPES)(
    'passes the %s RPC event type through unchanged',
    (eventType) => {
      const result = normalizeSorobanEvent(rawEvent({ type: eventType }), {
        contractAddress: CONTRACT,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.eventType).toBe(eventType);
    },
  );

  it('reads a symbol that follows a non-name topic entry', () => {
    const result = normalizeSorobanEvent(
      rawEvent({ topic: [xdr.ScVal.scvU32(7), xdr.ScVal.scvSymbol('NotificationDelivered')] }),
      { contractAddress: CONTRACT },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventName).toBe('NotificationDelivered');
  });

  it('accepts an empty topic and leaves the event name null', () => {
    const result = normalizeSorobanEvent(rawEvent({ topic: [] }), { contractAddress: CONTRACT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventName).toBeNull();
    expect(result.event.topic).toEqual([]);
  });

  it('reads a string topic name the same way as a symbol', () => {
    const result = normalizeSorobanEvent(
      rawEvent({ topic: [xdr.ScVal.scvString('NotificationRecalled')] }),
      { contractAddress: CONTRACT },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventName).toBe('NotificationRecalled');
  });

  it('stores a missing transaction hash as null', () => {
    const result = normalizeSorobanEvent(rawEvent({ txHash: undefined }), {
      contractAddress: `  ${CONTRACT}  `,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.txHash).toBeNull();
    expect(result.event.contractAddress).toBe(CONTRACT);
  });

  it('records payload_version when the value is a map', () => {
    const result = normalizeSorobanEvent(
      rawEvent({
        value: xdr.ScVal.scvMap({ payload_version: 1, notification_id: 'abc' }),
      }),
      { contractAddress: CONTRACT },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.payloadVersion).toBe(1);
  });

  it('treats a bare integer value as the payload version', () => {
    const result = normalizeSorobanEvent(rawEvent({ value: xdr.ScVal.scvU32(1) }), {
      contractAddress: CONTRACT,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.payloadVersion).toBe(1);
    expect(result.event.value).toBe('1');
  });

  it('rejects a non-object payload and a missing contract together', () => {
    const result = normalizeSorobanEvent(null, { contractAddress: '  ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual(['contractAddress', null]);
    expect(result.errors[1].category).toBe(EventParseErrorCategory.MalformedPayload);
  });

  it.each([
    ['missing id', { id: '' }, 'id'],
    ['non-string id', { id: 12 }, 'id'],
    ['missing ledger', { ledger: undefined }, 'ledger'],
    ['negative ledger', { ledger: -1 }, 'ledger'],
    ['fractional ledger', { ledger: 1.5 }, 'ledger'],
    ['missing topic', { topic: undefined }, 'topic'],
    ['non-array topic', { topic: 'NotificationScheduled' }, 'topic'],
    ['missing value', { value: undefined }, 'value'],
  ])('reports %s', (_label, overrides, field) => {
    const result = normalizeSorobanEvent(rawEvent(overrides), { contractAddress: CONTRACT });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe(field);
    expect(JSON.stringify(result.errors)).not.toContain('attacker');
  });

  it('does not echo an untrusted topic value when decoding fails', () => {
    const result = normalizeSorobanEvent(
      rawEvent({
        topic: [
          {
            switch: () => {
              throw new Error('secret-topic-bytes');
            },
          },
        ],
      }),
      { contractAddress: CONTRACT },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe('topic');
    expect(JSON.stringify(result.errors)).not.toContain('secret-topic-bytes');
  });
});
