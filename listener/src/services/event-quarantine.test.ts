import { EventQuarantineController } from './event-quarantine';

const EVENT = {
  eventId: 'event-bad',
  contractAddress: 'CCONTRACT',
  ledger: 88,
  reason: 'topic could not be decoded',
  category: 'malformed_payload',
};

describe('EventQuarantineController', () => {
  it('keeps a malformed event observable until the threshold, then blocks only that event', () => {
    const quarantine = new EventQuarantineController(2);

    const first = quarantine.recordMalformed(EVENT);
    expect(first.blocked).toBe(false);
    expect(first.record?.consecutiveFailures).toBe(1);
    expect(quarantine.isBlocked('event-ok', 'CCONTRACT')).toBe(false);

    const second = quarantine.recordMalformed(EVENT);
    expect(second.blocked).toBe(true);
    expect(second.record).toMatchObject({
      eventId: 'event-bad',
      contractAddress: 'CCONTRACT',
      ledger: 88,
      reason: 'topic could not be decoded',
      category: 'malformed_payload',
      status: 'quarantined',
      quarantineCount: 1,
    });
    expect(second.record?.quarantinedAt).toEqual(expect.any(String));
    expect(quarantine.isBlocked('event-bad', 'CCONTRACT')).toBe(true);
    expect(quarantine.isBlocked('event-ok', 'CCONTRACT')).toBe(false);
  });

  it('retains diagnostic context and requires an explicit recover call', () => {
    const quarantine = new EventQuarantineController(1);
    quarantine.recordMalformed({
      ...EVENT,
      reason: 'https://discord.com/api/webhooks/1/secret-token failed',
    });

    const blocked = quarantine.get('event-bad', 'CCONTRACT');
    expect(blocked?.reason).not.toContain('secret-token');
    expect(blocked?.reason).toContain('***');
    expect(blocked).not.toHaveProperty('dlqId');
    expect(blocked).not.toHaveProperty('provider');
    expect(blocked).not.toHaveProperty('payload');

    expect(() => quarantine.recover('event-ok', 'CCONTRACT')).toThrow(/not quarantined/i);
    expect(quarantine.isBlocked('event-bad', 'CCONTRACT')).toBe(true);

    const recovered = quarantine.recover('event-bad', 'CCONTRACT');
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAt).toEqual(expect.any(String));
    expect(recovered.ledger).toBe(88);
    expect(quarantine.isBlocked('event-bad', 'CCONTRACT')).toBe(false);
  });

  it('does not record a signal that has no event id', () => {
    const quarantine = new EventQuarantineController(1);
    expect(quarantine.recordMalformed({ ...EVENT, eventId: ' ' }).recorded).toBe(false);
    expect(quarantine.list()).toHaveLength(0);
  });

  it('rejects a threshold below 1', () => {
    expect(() => new EventQuarantineController(0)).toThrow(/threshold/i);
  });
});
