import { EventFixtures } from './event-fixtures';
import { xdr } from '@stellar/stellar-sdk';

describe('EventFixtures', () => {
  it('generates a valid event', () => {
    const event = EventFixtures.valid();
    expect(event.id).toBe('evt-valid-1');
    expect(event.type).toBe('contract');
    expect(event.topic).toBeDefined();
    expect(event.value).toBeDefined();
  });

  it('generates duplicate events', () => {
    const events = EventFixtures.duplicate();
    expect(events.length).toBe(2);
    expect(events[0].id).toBe(events[1].id);
    expect(events[0].txHash).toBe(events[1].txHash);
  });

  it('generates missing fields event', () => {
    const event = EventFixtures.missingFields();
    expect(event.type).toBe('contract');
    expect(event.id).toBeUndefined();
  });

  it('generates unsupported version event', () => {
    const event = EventFixtures.unsupportedVersion();
    const val = event.value.map();
    expect(val).toBeDefined();
    const versionEntry = val?.find((entry) => entry.key().sym().toString() === 'version');
    expect(versionEntry?.val().u32()).toBe(999);
  });

  it('generates malformed payload event', () => {
    const event = EventFixtures.malformedPayload();
    expect(event.ledger).toBe(-1);
  });
});
