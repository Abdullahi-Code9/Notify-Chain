/**
 * Tests for ContractVersionRegistry (Task 1)
 *
 * Coverage:
 * - Schema registration and overwrite
 * - resolveSchema: found / not_found results
 * - diagnose: compatible / incompatible / unsupported
 * - Structured diagnostics carry correct fields
 * - Singleton helpers (get / set / reset)
 * - Input validation (bad version, empty events)
 */

import {
  ContractVersionRegistry,
  getContractVersionRegistry,
  resetContractVersionRegistry,
  setContractVersionRegistry,
  type VersionedSchemaSnapshot,
} from './contract-version-registry';
import type { ContractEventSchema, OffConsumerEventSchema } from './compatibility-check';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid consumer event definition used across tests. */
const EVENT_NOTIFICATION_SCHEDULED: OffConsumerEventSchema = {
  eventName: 'NotificationScheduled',
  expectedTopics: [
    { name: 'creator', type: 'Address' },
    { name: 'category', type: 'NotificationCategory' },
    { name: 'priority', type: 'NotificationPriority' },
  ],
  expectedFields: [
    { name: 'notification_id', type: 'BytesN<32>' },
    { name: 'payload_version', type: 'u32' },
  ],
};

/** A second minimal event definition. */
const EVENT_CONTRACT_PAUSED: OffConsumerEventSchema = {
  eventName: 'ContractPaused',
  expectedTopics: [
    { name: 'admin', type: 'Address' },
    { name: 'category', type: 'NotificationCategory' },
    { name: 'priority', type: 'NotificationPriority' },
  ],
  expectedFields: [],
};

/** Contract-side representation of NotificationScheduled (matching the consumer). */
function makeContractEvent(
  name: string,
  topics: Array<[string, string]>,
  dataFields: Array<[string, string]>,
): ContractEventSchema {
  return {
    name,
    topics: topics.map(([n, t]) => ({ name: n, type: t })),
    dataFields: dataFields.map(([n, t]) => ({ name: n, type: t })),
  };
}

const CONTRACT_EVENT_NOTIFICATION_SCHEDULED = makeContractEvent(
  'NotificationScheduled',
  [
    ['creator', 'Address'],
    ['category', 'NotificationCategory'],
    ['priority', 'NotificationPriority'],
  ],
  [
    ['notification_id', 'BytesN<32>'],
    ['payload_version', 'u32'],
  ],
);

const CONTRACT_EVENT_CONTRACT_PAUSED = makeContractEvent(
  'ContractPaused',
  [
    ['admin', 'Address'],
    ['category', 'NotificationCategory'],
    ['priority', 'NotificationPriority'],
  ],
  [],
);

// A broken contract event that renamed `payload_version` → `schema_version`
const CONTRACT_EVENT_NOTIFICATION_SCHEDULED_BROKEN = makeContractEvent(
  'NotificationScheduled',
  [
    ['creator', 'Address'],
    ['category', 'NotificationCategory'],
    ['priority', 'NotificationPriority'],
  ],
  [
    ['notification_id', 'BytesN<32>'],
    ['schema_version', 'u32'], // renamed — breaking change
  ],
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContractEvents(
  ...events: ContractEventSchema[]
): Map<string, ContractEventSchema> {
  const map = new Map<string, ContractEventSchema>();
  for (const e of events) map.set(e.name, e);
  return map;
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — registration', () => {
  let registry: ContractVersionRegistry;

  beforeEach(() => {
    registry = new ContractVersionRegistry();
  });

  it('registers a snapshot and confirms with has()', () => {
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    expect(registry.has(1)).toBe(true);
  });

  it('lists registered versions in ascending order', () => {
    registry.register(3, [EVENT_CONTRACT_PAUSED]);
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    registry.register(2, [EVENT_NOTIFICATION_SCHEDULED, EVENT_CONTRACT_PAUSED]);
    expect(registry.registeredVersions()).toEqual([1, 2, 3]);
  });

  it('overwrites an existing snapshot', () => {
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    registry.register(1, [EVENT_CONTRACT_PAUSED]); // overwrite
    const result = registry.resolveSchema(1);
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.snapshot.events).toHaveLength(1);
      expect(result.snapshot.events[0].eventName).toBe('ContractPaused');
    }
  });

  it('deregisters a snapshot', () => {
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    expect(registry.deregister(1)).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it('returns false when deregistering an unregistered version', () => {
    expect(registry.deregister(99)).toBe(false);
  });

  it('throws for non-positive contract version', () => {
    expect(() => registry.register(0, [EVENT_NOTIFICATION_SCHEDULED])).toThrow(
      /positive integer/,
    );
    expect(() => registry.register(-1, [EVENT_NOTIFICATION_SCHEDULED])).toThrow(
      /positive integer/,
    );
  });

  it('throws for non-integer contract version', () => {
    expect(() => registry.register(1.5, [EVENT_NOTIFICATION_SCHEDULED])).toThrow(
      /positive integer/,
    );
  });

  it('throws when events array is empty', () => {
    expect(() => registry.register(1, [])).toThrow(/non-empty array/);
  });

  it('clears all snapshots', () => {
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    registry.register(2, [EVENT_CONTRACT_PAUSED]);
    registry.clear();
    expect(registry.registeredVersions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveSchema tests
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — resolveSchema', () => {
  let registry: ContractVersionRegistry;

  beforeEach(() => {
    registry = new ContractVersionRegistry();
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
  });

  it('returns found status for a registered version', () => {
    const result = registry.resolveSchema(1);
    expect(result.status).toBe('found');
  });

  it('returns the correct snapshot when found', () => {
    const result = registry.resolveSchema(1);
    if (result.status !== 'found') throw new Error('Expected found');
    expect(result.snapshot.contractVersion).toBe(1);
    expect(result.snapshot.events).toHaveLength(1);
    expect(result.snapshot.events[0].eventName).toBe('NotificationScheduled');
  });

  it('returns not_found for an unregistered version', () => {
    const result = registry.resolveSchema(42);
    expect(result.status).toBe('not_found');
  });

  it('not_found result includes the requested version and registered versions', () => {
    const result = registry.resolveSchema(42);
    if (result.status !== 'not_found') throw new Error('Expected not_found');
    expect(result.requestedVersion).toBe(42);
    expect(result.registeredVersions).toContain(1);
    expect(result.message).toMatch(/42/);
    expect(result.message).toMatch(/register/i);
  });

  it('not_found message is informative when no versions are registered', () => {
    const empty = new ContractVersionRegistry();
    const result = empty.resolveSchema(5);
    if (result.status !== 'not_found') throw new Error('Expected not_found');
    expect(result.registeredVersions).toHaveLength(0);
    expect(result.message).toMatch(/none/i);
  });
});

// ---------------------------------------------------------------------------
// diagnose — compatible
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — diagnose (compatible)', () => {
  let registry: ContractVersionRegistry;

  beforeEach(() => {
    registry = new ContractVersionRegistry();
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED, EVENT_CONTRACT_PAUSED]);
  });

  it('returns compatible when contract events match the snapshot', () => {
    const contractEvents = makeContractEvents(
      CONTRACT_EVENT_NOTIFICATION_SCHEDULED,
      CONTRACT_EVENT_CONTRACT_PAUSED,
    );
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.status).toBe('compatible');
  });

  it('compatible diagnostic has no breaking changes', () => {
    const contractEvents = makeContractEvents(
      CONTRACT_EVENT_NOTIFICATION_SCHEDULED,
      CONTRACT_EVENT_CONTRACT_PAUSED,
    );
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.breakingChanges).toHaveLength(0);
  });

  it('compatible diagnostic includes registeredVersions', () => {
    const contractEvents = makeContractEvents(CONTRACT_EVENT_NOTIFICATION_SCHEDULED);
    registry.register(2, [EVENT_NOTIFICATION_SCHEDULED]);
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.registeredVersions).toContain(1);
    expect(diag.registeredVersions).toContain(2);
  });

  it('safe additions are surfaced when the contract has extra events', () => {
    // The snapshot only knows about NotificationScheduled
    // The contract also has ContractPaused — that is a safe addition
    const contractEvents = makeContractEvents(
      CONTRACT_EVENT_NOTIFICATION_SCHEDULED,
      CONTRACT_EVENT_CONTRACT_PAUSED,
    );
    registry.clear();
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.status).toBe('compatible');
    expect(diag.safeAdditions.length).toBeGreaterThan(0);
    expect(diag.safeAdditions.some((s) => s.toLowerCase().includes('contractpaused'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// diagnose — incompatible
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — diagnose (incompatible)', () => {
  let registry: ContractVersionRegistry;

  beforeEach(() => {
    registry = new ContractVersionRegistry();
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
  });

  it('returns incompatible when a data field is renamed', () => {
    const contractEvents = makeContractEvents(CONTRACT_EVENT_NOTIFICATION_SCHEDULED_BROKEN);
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.status).toBe('incompatible');
  });

  it('incompatible diagnostic lists breaking changes', () => {
    const contractEvents = makeContractEvents(CONTRACT_EVENT_NOTIFICATION_SCHEDULED_BROKEN);
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.breakingChanges.length).toBeGreaterThan(0);
  });

  it('incompatible message mentions the version and breaking change count', () => {
    const contractEvents = makeContractEvents(CONTRACT_EVENT_NOTIFICATION_SCHEDULED_BROKEN);
    const diag = registry.diagnose(contractEvents, 1);
    expect(diag.message).toMatch(/1/);
    expect(diag.message).toMatch(/breaking/i);
  });

  it('returns incompatible when a consumer-expected event is missing from contract', () => {
    // Snapshot requires NotificationScheduled but the contract map is empty
    const diag = registry.diagnose(new Map(), 1);
    expect(diag.status).toBe('incompatible');
    expect(diag.breakingChanges.some((c) => c.toLowerCase().includes('missing'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// diagnose — unsupported
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — diagnose (unsupported)', () => {
  let registry: ContractVersionRegistry;

  beforeEach(() => {
    registry = new ContractVersionRegistry();
    registry.register(1, [EVENT_NOTIFICATION_SCHEDULED]);
  });

  it('returns unsupported for an unregistered version', () => {
    const contractEvents = makeContractEvents(CONTRACT_EVENT_NOTIFICATION_SCHEDULED);
    const diag = registry.diagnose(contractEvents, 99);
    expect(diag.status).toBe('unsupported');
  });

  it('unsupported diagnostic message is actionable', () => {
    const diag = registry.diagnose(new Map(), 99);
    expect(diag.message).toMatch(/99/);
    expect(diag.message).toMatch(/register/i);
    expect(diag.message).toMatch(/supported/i);
  });

  it('unsupported diagnostic has no breaking changes', () => {
    const diag = registry.diagnose(new Map(), 99);
    expect(diag.breakingChanges).toHaveLength(0);
    expect(diag.safeAdditions).toHaveLength(0);
  });

  it('unsupported diagnostic surfaces registered versions', () => {
    const diag = registry.diagnose(new Map(), 99);
    expect(diag.registeredVersions).toContain(1);
  });

  it('unsupported when registry is completely empty', () => {
    const empty = new ContractVersionRegistry();
    const diag = empty.diagnose(new Map(), 1);
    expect(diag.status).toBe('unsupported');
    expect(diag.registeredVersions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

describe('ContractVersionRegistry — singleton helpers', () => {
  afterEach(() => {
    resetContractVersionRegistry();
  });

  it('getContractVersionRegistry returns a ContractVersionRegistry', () => {
    const reg = getContractVersionRegistry();
    expect(reg).toBeInstanceOf(ContractVersionRegistry);
  });

  it('getContractVersionRegistry returns the same instance on repeated calls', () => {
    const a = getContractVersionRegistry();
    const b = getContractVersionRegistry();
    expect(a).toBe(b);
  });

  it('setContractVersionRegistry replaces the singleton', () => {
    const custom = new ContractVersionRegistry();
    setContractVersionRegistry(custom);
    expect(getContractVersionRegistry()).toBe(custom);
  });

  it('resetContractVersionRegistry forces a fresh instance on next get', () => {
    const first = getContractVersionRegistry();
    resetContractVersionRegistry();
    const second = getContractVersionRegistry();
    expect(second).not.toBe(first);
  });
});
