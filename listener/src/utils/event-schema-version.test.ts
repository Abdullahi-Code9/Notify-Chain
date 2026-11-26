import { xdr } from '@stellar/stellar-sdk';
import {
  DEFAULT_EVENT_SCHEMA_VERSION,
  isSupportedEventSchemaVersion,
  parseEventSchemaVersion,
} from './event-schema-version';
import { normalizeSorobanEvent } from '../services/event-normalization';

describe('event schema versioning (#1122)', () => {
  it('treats unsuffixed event names as v1 so existing events are unchanged', () => {
    expect(parseEventSchemaVersion('contract_paused')).toEqual({
      baseEventName: 'contract_paused',
      schemaVersion: 1,
      explicit: false,
    });
    expect(DEFAULT_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('reads an explicit _v<N> suffix', () => {
    expect(parseEventSchemaVersion('notification_scheduled_v2')).toEqual({
      baseEventName: 'notification_scheduled',
      schemaVersion: 2,
      explicit: true,
    });
    expect(parseEventSchemaVersion('a_v10').schemaVersion).toBe(10);
  });

  it.each(['notification_v0', 'notification_v', 'notification_v01', 'notification_vx', '_v2x'])(
    'does not treat %s as versioned',
    (name) => {
      const info = parseEventSchemaVersion(name);
      expect(info.explicit).toBe(false);
      expect(info.schemaVersion).toBe(1);
      expect(info.baseEventName).toBe(name);
    },
  );

  it.each([undefined, null, ''])('falls back to v1 for a missing name (%p) without throwing', (name) => {
    expect(parseEventSchemaVersion(name as any)).toEqual({
      baseEventName: null,
      schemaVersion: 1,
      explicit: false,
    });
  });

  it('supports v1 only until the listener learns newer versions', () => {
    expect(isSupportedEventSchemaVersion(1)).toBe(true);
    expect(isSupportedEventSchemaVersion(2)).toBe(false);
  });

  it.each([
    ['notification_scheduled', 'notification_scheduled', 1],
    ['notification_scheduled_v2', 'notification_scheduled', 2],
  ])('exposes the schema version of %s on normalized events', (name, base, version) => {
    const result = normalizeSorobanEvent(
      {
        id: 'evt-1',
        type: 'contract',
        ledger: 10,
        txHash: 'tx',
        topic: [xdr.ScVal.scvSymbol(name)],
        value: xdr.ScVal.scvU32(1),
      },
      { contractAddress: 'CCONTRACT' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventName).toBe(name);
    expect(result.event.baseEventName).toBe(base);
    expect(result.event.eventSchemaVersion).toBe(version);
  });
});
