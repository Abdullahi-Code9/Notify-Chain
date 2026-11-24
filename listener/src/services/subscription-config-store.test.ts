/**
 * Tests for versioned subscription configurations and audit history (Task 2).
 *
 * Acceptance criteria verified here:
 * 1. Creating a config records version 1; every update increments the version.
 * 2. Historical snapshots are immutable and remain queryable after later updates.
 * 3. Processed events retain the config version active at processing time, even
 *    after subsequent config updates.
 * 4. Existing records are never overwritten or corrupted.
 * 5. Unknown subscriptions and invalid input are handled explicitly.
 */

import { SubscriptionConfigStore } from './subscription-config-store';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeStore(): SubscriptionConfigStore {
  let tick = 1_000;
  return new SubscriptionConfigStore({ now: () => (tick += 1_000) });
}

describe('SubscriptionConfigStore — creation and versioning', () => {
  it('records version 1 on creation with merged defaults', () => {
    const store = makeStore();
    const v1 = store.createConfig('sub-1', { eventTypes: ['transfer'] }, { actor: 'alice' });

    expect(v1.version).toBe(1);
    expect(v1.subscriptionId).toBe('sub-1');
    expect(v1.actor).toBe('alice');
    expect(v1.changeSummary).toBe('created');
    expect(v1.previousSettings).toBeNull();
    expect(v1.settings.eventTypes).toEqual(['transfer']);
    expect(v1.settings.channels).toEqual([]);
    expect(v1.settings.active).toBe(true);
  });

  it('increments the version on each update', () => {
    const store = makeStore();
    store.createConfig('sub-1', { eventTypes: ['transfer'] });

    const v2 = store.updateConfig('sub-1', { channels: ['discord'] }, { actor: 'bob' });
    const v3 = store.updateConfig('sub-1', { active: false });

    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(store.getCurrentVersionNumber('sub-1')).toBe(3);
  });

  it('records a summary of what changed on update', () => {
    const store = makeStore();
    store.createConfig('sub-1', { eventTypes: ['transfer'], channels: ['discord'] });

    const v2 = store.updateConfig('sub-1', { channels: ['email'] });

    expect(v2.changeSummary).toBe('updated');
    expect(v2.changedKeys).toEqual(['channels']);
    expect(v2.previousSettings?.channels).toEqual(['discord']);
  });

  it('merges option patches rather than replacing them', () => {
    const store = makeStore();
    store.createConfig('sub-1', { options: { a: 1 } });
    const v2 = store.updateConfig('sub-1', { options: { b: 2 } });
    expect(v2.settings.options).toEqual({ a: 1, b: 2 });
  });

  it('throws when creating a subscription that already exists', () => {
    const store = makeStore();
    store.createConfig('sub-1');
    expect(() => store.createConfig('sub-1')).toThrow(/already exists/);
  });

  it('treats updateConfig on an unknown subscription as a creation (version 1)', () => {
    const store = makeStore();
    const v1 = store.updateConfig('sub-new', { eventTypes: ['x'] });
    expect(v1.version).toBe(1);
    expect(v1.changeSummary).toBe('created');
  });

  it('rejects blank subscription ids', () => {
    const store = makeStore();
    expect(() => store.createConfig('   ')).toThrow(/subscriptionId is required/);
    expect(() => store.updateConfig('', { active: true })).toThrow(/subscriptionId is required/);
  });
});

describe('SubscriptionConfigStore — history and immutability', () => {
  it('lists versions in ascending order', () => {
    const store = makeStore();
    store.createConfig('sub-1', { eventTypes: ['a'] });
    store.updateConfig('sub-1', { eventTypes: ['a', 'b'] });
    store.updateConfig('sub-1', { eventTypes: ['a', 'b', 'c'] });

    const versions = store.listConfigVersions('sub-1').map((v) => v.version);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('returns the exact historical snapshot after later updates', () => {
    const store = makeStore();
    const v1 = store.createConfig('sub-1', { eventTypes: ['a'] });
    store.updateConfig('sub-1', { eventTypes: ['a', 'b'] });

    const historical = store.getConfigVersion('sub-1', 1);
    expect(historical).toBe(v1);
    expect(historical?.settings.eventTypes).toEqual(['a']);
    expect(store.getConfigVersion('sub-1', 99)).toBeNull();
  });

  it('freezes stored snapshots so they cannot be mutated in place', () => {
    const store = makeStore();
    const v1 = store.createConfig('sub-1', { eventTypes: ['a'] });

    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v1.settings)).toBe(true);
    expect(Object.isFrozen(v1.settings.eventTypes)).toBe(true);

    expect(() => (v1.settings.eventTypes as string[]).push('b')).toThrow();
    expect(() => {
      (v1.settings as { active: boolean }).active = false;
    }).toThrow();
  });

  it('isolates stored snapshots from the caller-provided settings object', () => {
    const store = makeStore();
    const eventTypes = ['transfer'];
    const v1 = store.createConfig('sub-1', { eventTypes });

    eventTypes.push('injected');

    expect(v1.settings.eventTypes).toEqual(['transfer']);
    expect(store.getConfigVersion('sub-1', 1)?.settings.eventTypes).toEqual(['transfer']);
  });

  it('returns a fresh array so callers cannot mutate stored history', () => {
    const store = makeStore();
    store.createConfig('sub-1');
    const listed = store.listConfigVersions('sub-1');
    listed.pop();
    listed.length && listed.length; // no-op to satisfy lint on unused
    expect(store.listConfigVersions('sub-1')).toHaveLength(1);
  });

  it('returns null for unknown subscriptions', () => {
    const store = makeStore();
    expect(store.getCurrentConfig('missing')).toBeNull();
    expect(store.getCurrentVersionNumber('missing')).toBeNull();
    expect(store.listConfigVersions('missing')).toEqual([]);
  });
});

describe('SubscriptionConfigStore — processed event linking', () => {
  it('links a processed event to the config version active at processing time', () => {
    const store = makeStore();
    store.createConfig('sub-1', { eventTypes: ['a'] }); // version 1
    const link = store.recordProcessedEvent('sub-1', 'event-1', { contractAddress: 'CABC' });

    expect(link.configVersion).toBe(1);
    expect(link.subscriptionId).toBe('sub-1');
    expect(link.contractAddress).toBe('CABC');
    expect(Object.isFrozen(link)).toBe(true);
  });

  it('retains the original version reference after subsequent config updates', () => {
    const store = makeStore();
    store.createConfig('sub-1', { eventTypes: ['a'] });
    const link = store.recordProcessedEvent('sub-1', 'event-1');

    store.updateConfig('sub-1', { eventTypes: ['a', 'b'] }); // version 2
    store.updateConfig('sub-1', { active: false }); // version 3

    const stored = store.getProcessedEvent('event-1');
    expect(stored).toBe(link);
    expect(stored?.configVersion).toBe(1);
    // The referenced version snapshot is unchanged and still queryable.
    expect(store.getConfigVersion('sub-1', 1)?.settings.eventTypes).toEqual(['a']);
    expect(store.getCurrentVersionNumber('sub-1')).toBe(3);
  });

  it('records events processed under different config versions independently', () => {
    const store = makeStore();
    store.createConfig('sub-1'); // v1
    const first = store.recordProcessedEvent('sub-1', 'event-1');
    store.updateConfig('sub-1', { channels: ['discord'] }); // v2
    const second = store.recordProcessedEvent('sub-1', 'event-2');

    expect(first.configVersion).toBe(1);
    expect(second.configVersion).toBe(2);
    expect(store.listProcessedEvents('sub-1').map((l) => l.configVersion)).toEqual([1, 2]);
  });

  it('rejects a blank event id', () => {
    const store = makeStore();
    store.createConfig('sub-1');
    expect(() => store.recordProcessedEvent('sub-1', '  ')).toThrow(/eventId is required/);
  });
});
