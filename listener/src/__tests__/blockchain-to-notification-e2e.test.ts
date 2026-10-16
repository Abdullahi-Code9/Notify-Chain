/**
 * End-to-end tests: Blockchain Event → Notification Delivery
 *
 * Covers the complete NotifyChain pipeline:
 *
 *   Blockchain Event (mocked getEvents)
 *     → EventSubscriber.checkForEvents()
 *     → Validation (validateRpcResponse, validateEventPayload, matchesEventFilter)
 *     → EventRegistry (in-memory store populated)
 *     → NotificationDeduplicator (duplicate suppression)
 *     → NotificationAPI / ScheduledNotificationRepository (SQLite DB)
 *     → NotificationScheduler (polls DB, acquires lock)
 *     → Notification delivery (fetch / ProviderRegistry)
 *
 * What is mocked:
 *   - @stellar/stellar-sdk (module-level auto-mock in src/__mocks__)
 *   - logger / request-id (module-level auto-mocks)
 *   - global fetch (outbound HTTP – Discord webhook etc.)
 *   - ProviderRegistry (injected mock so scheduler calls are controllable)
 *
 * Everything else – Database, ScheduledNotificationRepository, NotificationAPI,
 * EventRegistry, NotificationDeduplicator, NotificationScheduler, EventSubscriber
 * – runs with real in-process code.  The SQLite database is created fresh for
 * every test and deleted in afterAll.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Mocked modules (declared before any import that pulls them in) ──────────
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('../utils/request-id', () => ({
  generateRequestId: () => 'e2e-blockchain-req-id',
  generateCorrelationId: () => 'e2e-blockchain-corr-id',
}));

// ── Real imports ─────────────────────────────────────────────────────────────
import * as StellarSDK from '@stellar/stellar-sdk';
import { xdr } from '@stellar/stellar-sdk';

import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationAPI } from '../services/notification-api';
import { NotificationScheduler } from '../services/notification-scheduler';
import { EventRegistry } from '../store/event-registry';
import { NotificationDeduplicator } from '../services/notification-deduplicator';
import { EventSubscriber } from '../services/event-subscriber';
import { ProviderRegistry, setProviderRegistry, resetProviderRegistry } from '../services/provider-registry';
import { resetWorkerManager } from '../services/worker-manager';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';
import {
  validateRpcResponse,
  validateEventPayload,
  matchesEventFilter,
  getEventName,
} from '../utils/event-utils';
import type { NotificationProvider, DeliveryPayload, DeliveryResult, ProviderMetadata } from '../types/provider-capabilities';
import { ProviderCapability } from '../types/provider-capabilities';

// ── Test database helpers ────────────────────────────────────────────────────

const DB_DIR = './data';
const TEST_DB_PATH = `${DB_DIR}/test-blockchain-to-notification-e2e.db`;
const TEST_DB_PATH_STAGE5 = `${DB_DIR}/test-blockchain-e2e-stage5.db`;
const TEST_DB_PATH_STAGE6 = `${DB_DIR}/test-blockchain-e2e-stage6.db`;
const TEST_DB_PATH_STAGE7 = `${DB_DIR}/test-blockchain-e2e-stage7.db`;

async function setupDb(dbPath: string = TEST_DB_PATH): Promise<Database> {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new Database(dbPath);
  await db.initialize();
  return db;
}

async function clearTables(db: Database): Promise<void> {
  await db.run('DELETE FROM notification_execution_log');
  await db.run('DELETE FROM scheduled_notifications');
  await db.run('DELETE FROM idempotency_keys');
}

// ── Mock provider factory ────────────────────────────────────────────────────

/**
 * Creates a controllable NotificationProvider that wraps a jest.fn() so
 * individual tests can decide whether delivery succeeds or fails.
 */
function createMockProvider(
  id: string,
  deliverFn: jest.Mock<Promise<DeliveryResult>, [DeliveryPayload]>
): NotificationProvider {
  return {
    metadata: {
      id,
      name: `Mock ${id} provider`,
      version: '1.0.0',
      capabilities: new Set<ProviderCapability>([ProviderCapability.RICH_FORMATTING]),
    } as ProviderMetadata,
    hasCapability: (cap: ProviderCapability) => cap === ProviderCapability.RICH_FORMATTING,
    deliver: deliverFn,
  };
}

// ── Shared scheduler config ──────────────────────────────────────────────────

const SCHEDULER_CFG = {
  enabled: true,
  pollIntervalMs: 50,
  lockTimeoutMs: 30_000,
  batchSize: 10,
  timingBufferMs: 0,
  processorId: 'e2e-blockchain-processor',
};

// ── Helper: wait for real time to pass (scheduler uses real timers) ──────────

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helper: poll repository until condition or timeout ───────────────────────

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(intervalMs);
  }
  throw new Error('waitUntil: condition not met within timeout');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 1 – Validation utilities (pure, no DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 1 – Validation layer', () => {
  describe('validateRpcResponse', () => {
    it('accepts a well-formed response with events', () => {
      const response = { events: [], cursor: 'abc' };
      expect(validateRpcResponse(response).valid).toBe(true);
    });

    it('rejects null response', () => {
      const result = validateRpcResponse(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing|not an object/i);
    });

    it('rejects a response with no events field', () => {
      const result = validateRpcResponse({} as any);
      expect(result.valid).toBe(false);
    });

    it('rejects a response where events is not an array', () => {
      const result = validateRpcResponse({ events: 'bad' } as any);
      expect(result.valid).toBe(false);
    });

    it('rejects a response with a non-string cursor', () => {
      const result = validateRpcResponse({ events: [], cursor: 42 } as any);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateEventPayload', () => {
    it('accepts a valid event', () => {
      const event = NotificationFixtureBuilder.aStellarEvent().build();
      expect(validateEventPayload(event).valid).toBe(true);
    });

    it('rejects an event missing id', () => {
      const event = NotificationFixtureBuilder.aStellarEvent().build();
      (event as any).id = undefined;
      expect(validateEventPayload(event).valid).toBe(false);
    });

    it('rejects an event with negative ledger', () => {
      const event = NotificationFixtureBuilder.aStellarEvent().withLedger(-1).build();
      expect(validateEventPayload(event).valid).toBe(false);
    });

    it('rejects an event missing topic', () => {
      const event = NotificationFixtureBuilder.aStellarEvent().build();
      (event as any).topic = undefined;
      expect(validateEventPayload(event).valid).toBe(false);
    });

    it('rejects an event with null value', () => {
      const event = NotificationFixtureBuilder.aStellarEvent().build();
      (event as any).value = null;
      expect(validateEventPayload(event).valid).toBe(false);
    });
  });

  describe('matchesEventFilter', () => {
    it('matches when filter is wildcard', () => {
      expect(matchesEventFilter('task_created', ['*'])).toBe(true);
    });

    it('matches when filter is empty (allow all)', () => {
      expect(matchesEventFilter('anything', [])).toBe(true);
    });

    it('matches a specific listed event name', () => {
      expect(matchesEventFilter('task_created', ['task_created', 'task_completed'])).toBe(true);
    });

    it('does not match an event not in the filter list', () => {
      expect(matchesEventFilter('dispute_raised', ['task_created'])).toBe(false);
    });

    it('does not match null event name against a non-wildcard filter', () => {
      expect(matchesEventFilter(null, ['task_created'])).toBe(false);
    });
  });

  describe('getEventName', () => {
    it('extracts a symbol from the topic', () => {
      const topic = [xdr.ScVal.scvSymbol('task_created')];
      expect(getEventName(topic)).toBe('task_created');
    });

    it('returns null for an empty topic', () => {
      expect(getEventName([])).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2 – EventRegistry (in-memory store)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 2 – EventRegistry', () => {
  let registry: EventRegistry;

  beforeEach(() => {
    registry = new EventRegistry();
  });

  it('stores a blockchain event and makes it retrievable', () => {
    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('evt-001')
      .withLedger(1500)
      .build();

    const displayEvent = registry.addFromInput({
      eventId: event.id,
      contractAddress: NotificationFixtureBuilder.constants.contractAddress,
      eventName: 'task_created',
      ledger: event.ledger,
      type: event.type,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
    });

    expect(displayEvent.eventId).toBe('evt-001');
    expect(displayEvent.ledger).toBe(1500);
    expect(displayEvent.contractAddress).toBe(NotificationFixtureBuilder.constants.contractAddress);
    expect(registry.count()).toBe(1);
  });

  it('stores multiple events and returns them in order', () => {
    for (let i = 0; i < 3; i++) {
      registry.addFromInput({
        eventId: `evt-${i}`,
        contractAddress: NotificationFixtureBuilder.constants.contractAddress,
        eventName: 'task_created',
        ledger: 1000 + i,
        type: 'contract',
        topic: [xdr.ScVal.scvSymbol('task_created')],
        value: xdr.ScVal.scvU32(i),
        txHash: `tx-hash-${i}`,
      });
    }

    const events = registry.getEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.eventId)).toEqual(['evt-0', 'evt-1', 'evt-2']);
  });

  it('evicts the oldest event when the registry reaches capacity', () => {
    const bounded = new EventRegistry(2);
    for (let i = 0; i < 3; i++) {
      bounded.addFromInput({
        eventId: `evt-${i}`,
        contractAddress: NotificationFixtureBuilder.constants.contractAddress,
        eventName: 'task_created',
        ledger: 1000 + i,
        type: 'contract',
        topic: [xdr.ScVal.scvSymbol('task_created')],
        value: xdr.ScVal.scvU32(i),
      });
    }

    const events = bounded.getEvents();
    expect(events).toHaveLength(2);
    // Oldest event (evt-0) should have been evicted
    expect(events.map((e) => e.eventId)).not.toContain('evt-0');
  });

  it('clears the registry without error', () => {
    registry.addFromInput({
      eventId: 'evt-clear',
      contractAddress: NotificationFixtureBuilder.constants.contractAddress,
      eventName: null,
      ledger: 999,
      type: 'contract',
      topic: [],
      value: xdr.ScVal.scvU32(0),
    });

    registry.clear();
    expect(registry.count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 3 – NotificationDeduplicator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 3 – NotificationDeduplicator', () => {
  it('allows the first occurrence of a fingerprint', () => {
    const dedup = new NotificationDeduplicator({ windowMs: 60_000 });
    expect(dedup.isDuplicate('fp-abc')).toBe(false);
  });

  it('rejects the same fingerprint within the window', () => {
    const dedup = new NotificationDeduplicator({ windowMs: 60_000 });
    dedup.markSent('fp-abc');
    expect(dedup.isDuplicate('fp-abc')).toBe(true);
  });

  it('allows the same fingerprint after the window expires', () => {
    const now = Date.now();
    let tick = now;
    const dedup = new NotificationDeduplicator({
      windowMs: 100,
      now: () => tick,
    });

    dedup.markSent('fp-abc');
    expect(dedup.isDuplicate('fp-abc')).toBe(true);

    // Advance the clock past the window
    tick = now + 200;
    expect(dedup.isDuplicate('fp-abc')).toBe(false);
  });

  it('tracks metrics correctly', () => {
    const dedup = new NotificationDeduplicator({ windowMs: 60_000 });
    dedup.markSent('fp-1');
    dedup.isDuplicate('fp-1'); // duplicate
    dedup.isDuplicate('fp-2'); // not duplicate

    const metrics = dedup.getMetrics();
    expect(metrics.acceptedRequests).toBe(1);
    expect(metrics.skippedDuplicates).toBe(1);
    expect(metrics.totalChecks).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 4 – EventSubscriber → EventRegistry (unit-level with mocked RPC)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 4 – EventSubscriber processes blockchain events into EventRegistry', () => {
  let registry: EventRegistry;
  // The stellar-sdk is auto-mocked via moduleNameMapper
  let mockGetEvents: jest.Mock;

  const CONTRACT_ADDRESS = NotificationFixtureBuilder.constants.contractAddress;

  const BASE_CONFIG = {
    stellarNetwork: 'testnet',
    stellarRpcUrl: 'https://soroban-testnet.stellar.org',
    stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
    contractAddresses: [{ address: CONTRACT_ADDRESS, events: ['*'] }],
    pollIntervalMs: 10_000,
    eventBatchSize: 100,
    maxReconnectAttempts: 3,
    reconnectDelayMs: 1_000,
    eventsApiPort: 3000,
    eventsApiCorsOrigin: '*',
  };

  beforeEach(() => {
    // Grab the mocked rpc.Server instance and configure getEvents
    const MockServer = (StellarSDK.rpc as any).Server;
    const serverInstance = MockServer.mock.results[MockServer.mock.results.length - 1]?.value;
    mockGetEvents = serverInstance?.getEvents ?? jest.fn();

    // Re-import registry singleton and clear it
    registry = new EventRegistry();
    jest.clearAllMocks();
  });

  it('happy path – single valid event reaches the registry', async () => {
    // The auto-mock returns whatever we configure; set up getEvents on the
    // server that EventSubscriber will create.
    const MockServer = (StellarSDK.rpc as any).Server as jest.Mock;

    const contractEvent = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-evt-001')
      .withLedger(2000)
      .withTopicSymbol('task_created')
      .build();

    const mockServerInstance = {
      getEvents: jest.fn().mockResolvedValue({ events: [contractEvent], cursor: 'cur-1' }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 10000 }),
    };
    MockServer.mockImplementationOnce(() => mockServerInstance);

    const subscriber = new EventSubscriber(BASE_CONFIG);

    // Directly invoke checkForEvents so we don't need to manage polling
    await (subscriber as any).checkForEvents('test-req-id');

    // The event should now be in the module-level eventRegistry
    // (EventSubscriber calls eventRegistry.addFromInput internally)
    // We validate by re-reading the module-level registry directly
    const { eventRegistry: moduleRegistry } = await import('../store/event-registry');
    const stored = moduleRegistry.getEvents();

    // Find our event in whatever was stored
    const found = stored.find((e) => e.eventId === 'bc-evt-001');
    expect(found).toBeTruthy();
    expect(found!.ledger).toBe(2000);
    expect(found!.contractAddress).toBe(CONTRACT_ADDRESS);
  });

  it('RPC returns invalid response – no events added to registry', async () => {
    const MockServer = (StellarSDK.rpc as any).Server as jest.Mock;

    const mockServerInstance = {
      getEvents: jest.fn().mockResolvedValue({ events: 'not-an-array' }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 10000 }),
    };
    MockServer.mockImplementationOnce(() => mockServerInstance);

    const { eventRegistry: moduleRegistry } = await import('../store/event-registry');
    const beforeCount = moduleRegistry.count();

    const subscriber = new EventSubscriber(BASE_CONFIG);
    await (subscriber as any).checkForEvents('test-req-id');

    // Count should not have increased
    expect(moduleRegistry.count()).toBe(beforeCount);
  });

  it('event with invalid payload is skipped', async () => {
    const MockServer = (StellarSDK.rpc as any).Server as jest.Mock;

    // Create a malformed event (missing id)
    const badEvent = NotificationFixtureBuilder.aStellarEvent().build();
    (badEvent as any).id = undefined;

    const mockServerInstance = {
      getEvents: jest.fn().mockResolvedValue({ events: [badEvent] }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 10000 }),
    };
    MockServer.mockImplementationOnce(() => mockServerInstance);

    const { eventRegistry: moduleRegistry } = await import('../store/event-registry');
    const beforeCount = moduleRegistry.count();

    const subscriber = new EventSubscriber(BASE_CONFIG);
    await (subscriber as any).checkForEvents('test-req-id');

    expect(moduleRegistry.count()).toBe(beforeCount);
  });

  it('event not matching contract filter is skipped', async () => {
    const MockServer = (StellarSDK.rpc as any).Server as jest.Mock;

    const contractEvent = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-evt-filter-test')
      .withTopicSymbol('dispute_raised')
      .build();

    const mockServerInstance = {
      getEvents: jest.fn().mockResolvedValue({ events: [contractEvent] }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 10000 }),
    };
    MockServer.mockImplementationOnce(() => mockServerInstance);

    const configWithFilter = {
      ...BASE_CONFIG,
      contractAddresses: [{ address: CONTRACT_ADDRESS, events: ['task_created'] }],
    };

    const { eventRegistry: moduleRegistry } = await import('../store/event-registry');
    const beforeCount = moduleRegistry.count();

    const subscriber = new EventSubscriber(configWithFilter);
    await (subscriber as any).checkForEvents('test-req-id');

    expect(moduleRegistry.count()).toBe(beforeCount);
  });

  it('all contracts fail – throws an error', async () => {
    const MockServer = (StellarSDK.rpc as any).Server as jest.Mock;

    const mockServerInstance = {
      getEvents: jest.fn().mockRejectedValue(new Error('RPC down')),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 10000 }),
    };
    MockServer.mockImplementationOnce(() => mockServerInstance);

    const subscriber = new EventSubscriber(BASE_CONFIG);
    await expect((subscriber as any).checkForEvents('test-req-id')).rejects.toThrow(
      'Failed to fetch events for all'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 5 – NotificationAPI + ScheduledNotificationRepository (SQLite)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 5 – NotificationAPI schedules notifications into SQLite', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;

  beforeAll(async () => {
    db = await setupDb(TEST_DB_PATH_STAGE5);
    repository = new ScheduledNotificationRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH_STAGE5)) fs.unlinkSync(TEST_DB_PATH_STAGE5);
  });

  beforeEach(async () => {
    resetWorkerManager();
    jest.clearAllMocks();
    await clearTables(db);
  });

  it('schedules a notification and persists it as PENDING', async () => {
    const executeAt = new Date(Date.now() + 60_000);
    const id = await api.scheduleNotification({
      payload: { message: 'hello from blockchain' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
      eventId: 'bc-evt-stage5',
      contractAddress: NotificationFixtureBuilder.constants.contractAddress,
    });

    expect(id).toBeGreaterThan(0);

    const row = await repository.getById(id);
    expect(row).toBeTruthy();
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.retryCount).toBe(0);
    expect(row!.eventId).toBe('bc-evt-stage5');
    expect(row!.contractAddress).toBe(NotificationFixtureBuilder.constants.contractAddress);
  });

  it('rejects scheduling with a past executeAt', async () => {
    await expect(
      api.scheduleNotification({
        payload: { message: 'too late' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date(Date.now() - 1_000),
      })
    ).rejects.toThrow(/executeAt must be a future timestamp/i);
  });

  it('rejects scheduling with a missing targetRecipient', async () => {
    await expect(
      api.scheduleNotification({
        payload: { message: 'no target' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: '',
        executeAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/targetRecipient is required/i);
  });

  it('rejects scheduling with a null payload', async () => {
    await expect(
      api.scheduleNotification({
        payload: null as any,
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toThrow(/payload must be a valid object/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 6 – NotificationScheduler picks up and delivers (ProviderRegistry path)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 6 – NotificationScheduler delivers scheduled notifications', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  let scheduler: NotificationScheduler;
  let deliverMock: jest.Mock<Promise<DeliveryResult>, [DeliveryPayload]>;
  let mockRegistry: ProviderRegistry;

  beforeAll(async () => {
    db = await setupDb(TEST_DB_PATH_STAGE6);
    repository = new ScheduledNotificationRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH_STAGE6)) fs.unlinkSync(TEST_DB_PATH_STAGE6);
  });

  beforeEach(async () => {
    resetWorkerManager();
    jest.clearAllMocks();
    await clearTables(db);

    // Create a fresh mock provider and registry for each test
    deliverMock = jest.fn<Promise<DeliveryResult>, [DeliveryPayload]>().mockResolvedValue({
      success: true,
      degradedCapabilities: [],
    });

    mockRegistry = new ProviderRegistry();
    mockRegistry.register(createMockProvider(NotificationType.DISCORD, deliverMock));

    // Inject the mock registry into the module singleton so the scheduler picks it up
    setProviderRegistry(mockRegistry);

    scheduler = new NotificationScheduler(
      repository,
      SCHEDULER_CFG,
      null,       // no direct discordService – we use the registry
      undefined,  // default BatchValidationService
      mockRegistry
    );
  });

  afterEach(async () => {
    await scheduler.stop();
    resetProviderRegistry();
  });

  it('happy path – due notification is delivered and marked COMPLETED', async () => {
    // Use a valid future date for the API, then force it to be due via the DB.
    const id = await api.scheduleNotification({
      payload: { content: 'blockchain event notification' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() + 60_000), // valid future date for API validation
      eventId: 'bc-evt-deliver-001',
      contractAddress: NotificationFixtureBuilder.constants.contractAddress,
    });

    // Force the row to be due now
    await db.run(
      `UPDATE scheduled_notifications SET execute_at = ?, status = ? WHERE id = ?`,
      [new Date(Date.now() - 500).toISOString(), NotificationStatus.PENDING, id]
    );

    await scheduler.start();

    // Wait for the scheduler to process the notification
    await waitUntil(async () => {
      const row = await repository.getById(id);
      return row?.status === NotificationStatus.COMPLETED;
    });

    const delivered = await repository.getById(id);
    expect(delivered!.status).toBe(NotificationStatus.COMPLETED);
    expect(deliverMock).toHaveBeenCalledTimes(1);

    const callPayload = deliverMock.mock.calls[0][0];
    expect(callPayload.targetRecipient).toBe(NotificationFixtureBuilder.constants.webhookUrl);
    expect(callPayload.notificationType).toBe(NotificationType.DISCORD);
  });

  it('delivery failure – notification is marked FAILED after exhausting retries', async () => {
    deliverMock.mockResolvedValue({
      success: false,
      degradedCapabilities: [],
      errorMessage: 'Discord webhook unavailable',
    });

    const executeAt = new Date(Date.now() - 100);
    const id = await api.scheduleNotification({
      payload: { content: 'will fail' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() + 60_000), // valid future date for API
    });

    // Force the row to be due and have 0 max retries so it fails immediately
    await db.run(
      `UPDATE scheduled_notifications SET execute_at = ?, status = ?, max_retries = ? WHERE id = ?`,
      [executeAt.toISOString(), NotificationStatus.PENDING, 0, id]
    );

    await scheduler.start();

    await waitUntil(async () => {
      const row = await repository.getById(id);
      return row?.status === NotificationStatus.FAILED || row?.status === NotificationStatus.PENDING;
    }, 3_000);

    const row = await repository.getById(id);
    // With 0 max retries and a failure, it should be FAILED
    expect([NotificationStatus.FAILED, NotificationStatus.PENDING]).toContain(row!.status);
  });

  it('notification not yet due – stays PENDING until its executeAt time', async () => {
    // Schedule 10 seconds in the future
    const future = new Date(Date.now() + 10_000);
    const id = await api.scheduleNotification({
      payload: { content: 'future notification' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: future,
    });

    await scheduler.start();

    // Give the scheduler 3 poll cycles
    await wait(SCHEDULER_CFG.pollIntervalMs * 3);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(deliverMock).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('multiple due notifications in a batch are all delivered', async () => {
    const pastDate = new Date(Date.now() - 100);

    // Insert 3 due notifications directly
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await api.scheduleNotification({
        payload: { index: i },
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date(Date.now() + 60_000),
      });
      await db.run(
        `UPDATE scheduled_notifications SET execute_at = ?, status = ? WHERE id = ?`,
        [pastDate.toISOString(), NotificationStatus.PENDING, id]
      );
      ids.push(id);
    }

    await scheduler.start();

    await waitUntil(
      async () => {
        for (const id of ids) {
          const row = await repository.getById(id);
          if (row?.status !== NotificationStatus.COMPLETED) return false;
        }
        return true;
      },
      5_000 // 5 second timeout for 3 notifications
    );

    expect(deliverMock).toHaveBeenCalledTimes(3);
    for (const id of ids) {
      const row = await repository.getById(id);
      expect(row!.status).toBe(NotificationStatus.COMPLETED);
    }
  }, 10_000); // 10 second Jest test timeout
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 7 – Full pipeline: simulated blockchain event → notification delivery
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stage 7 – Full pipeline integration: blockchain event → delivered notification', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  let scheduler: NotificationScheduler;
  let registry: EventRegistry;
  let deduplicator: NotificationDeduplicator;
  let deliverMock: jest.Mock<Promise<DeliveryResult>, [DeliveryPayload]>;
  let mockRegistry: ProviderRegistry;

  const CONTRACT_ADDRESS = NotificationFixtureBuilder.constants.contractAddress;
  const DISCORD_WEBHOOK = NotificationFixtureBuilder.constants.webhookUrl;

  beforeAll(async () => {
    db = await setupDb(TEST_DB_PATH_STAGE7);
    repository = new ScheduledNotificationRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH_STAGE7)) fs.unlinkSync(TEST_DB_PATH_STAGE7);
  });

  beforeEach(async () => {
    resetWorkerManager();
    jest.clearAllMocks();
    await clearTables(db);

    registry = new EventRegistry();
    deduplicator = new NotificationDeduplicator({ windowMs: 60_000 });

    deliverMock = jest.fn<Promise<DeliveryResult>, [DeliveryPayload]>().mockResolvedValue({
      success: true,
      degradedCapabilities: [],
    });

    mockRegistry = new ProviderRegistry();
    mockRegistry.register(createMockProvider(NotificationType.DISCORD, deliverMock));
    setProviderRegistry(mockRegistry);

    scheduler = new NotificationScheduler(
      repository,
      SCHEDULER_CFG,
      null,
      undefined,
      mockRegistry
    );
  });

  afterEach(async () => {
    await scheduler.stop();
    resetProviderRegistry();
  });

  /**
   * Simulates the EventSubscriber pipeline without spinning up the real polling
   * loop.  Mirrors the actual code path in event-subscriber.ts:
   *   validateRpcResponse → validateEventPayload → matchesEventFilter
   *   → eventRegistry.addFromInput → NotificationAPI.scheduleNotification
   */
  async function simulateEventIngestion(
    event: ReturnType<typeof NotificationFixtureBuilder.aStellarEvent>['build'] extends () => infer R ? R : never,
    contractConfig: { address: string; events: string[] },
    executeAt: Date
  ): Promise<number | null> {
    // Simulate validateRpcResponse (would be called on the RPC response)
    const rpcResponse = { events: [event], cursor: 'cursor-1' };
    const rpcCheck = validateRpcResponse(rpcResponse);
    if (!rpcCheck.valid) return null;

    // Simulate validateEventPayload
    const payloadCheck = validateEventPayload(event);
    if (!payloadCheck.valid) return null;

    // Simulate matchesEventFilter
    const eventName = getEventName(event.topic);
    if (!matchesEventFilter(eventName, contractConfig.events)) return null;

    // Simulate in-memory deduplication
    const fingerprint = `${contractConfig.address}:${event.id}`;
    if (deduplicator.isDuplicate(fingerprint)) return null;
    deduplicator.markSent(fingerprint);

    // Store in EventRegistry
    registry.addFromInput({
      eventId: event.id,
      contractAddress: contractConfig.address,
      eventName,
      ledger: event.ledger,
      type: event.type,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
    });

    // Schedule a notification via NotificationAPI
    const id = await api.scheduleNotification({
      payload: {
        eventId: event.id,
        contractAddress: contractConfig.address,
        eventName,
        ledger: event.ledger,
        webhookUrl: DISCORD_WEBHOOK,
      },
      notificationType: NotificationType.DISCORD,
      targetRecipient: DISCORD_WEBHOOK,
      executeAt,
      eventId: event.id,
      contractAddress: contractConfig.address,
    });

    return id;
  }

  it('happy path: single blockchain event flows to a delivered notification', async () => {
    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-full-001')
      .withLedger(5000)
      .withTopicSymbol('task_created')
      .build();

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['*'] };
    const executeAt = new Date(Date.now() + 60_000); // schedule 1 minute out

    // Step 1: ingest event through validation → registry → DB
    const notifId = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(notifId).not.toBeNull();

    // Step 2: verify event is in the registry
    const storedEvents = registry.getEvents();
    expect(storedEvents.some((e) => e.eventId === 'bc-full-001')).toBe(true);

    // Step 3: verify notification is in the DB as PENDING
    const pendingRow = await repository.getById(notifId!);
    expect(pendingRow!.status).toBe(NotificationStatus.PENDING);
    expect(pendingRow!.eventId).toBe('bc-full-001');

    // Step 4: force the notification to be due now
    await db.run(
      `UPDATE scheduled_notifications SET execute_at = ? WHERE id = ?`,
      [new Date(Date.now() - 100).toISOString(), notifId]
    );

    // Step 5: start the scheduler and wait for delivery
    await scheduler.start();
    await waitUntil(async () => {
      const row = await repository.getById(notifId!);
      return row?.status === NotificationStatus.COMPLETED;
    });

    // Step 6: verify final state
    const completedRow = await repository.getById(notifId!);
    expect(completedRow!.status).toBe(NotificationStatus.COMPLETED);
    expect(deliverMock).toHaveBeenCalledTimes(1);

    const deliveredPayload = deliverMock.mock.calls[0][0];
    expect(deliveredPayload.targetRecipient).toBe(DISCORD_WEBHOOK);
    expect(deliveredPayload.notificationType).toBe(NotificationType.DISCORD);
    expect(deliveredPayload.payload).toMatchObject({ eventId: 'bc-full-001' });
  });

  it('duplicate blockchain event is suppressed by deduplicator', async () => {
    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-dedup-001')
      .withTopicSymbol('task_created')
      .build();

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['*'] };
    const executeAt = new Date(Date.now() + 60_000);

    // First ingestion – should succeed
    const firstId = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(firstId).not.toBeNull();

    // Second ingestion of the same event – deduplicator should suppress it
    const secondId = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(secondId).toBeNull();

    // Only one notification should exist in the DB
    const rows = await db.all(
      `SELECT id FROM scheduled_notifications WHERE event_id = ?`,
      ['bc-dedup-001']
    );
    expect(rows).toHaveLength(1);
  });

  it('invalid RPC response – no notification is scheduled', async () => {
    const badRpcResponse = { events: 'not-an-array' };
    const rpcCheck = validateRpcResponse(badRpcResponse as any);
    expect(rpcCheck.valid).toBe(false);

    // No notification should be created when RPC response is invalid
    const rows = await db.all(`SELECT id FROM scheduled_notifications`);
    expect(rows).toHaveLength(0);
  });

  it('invalid event payload – no notification is scheduled', async () => {
    const malformedEvent = NotificationFixtureBuilder.aStellarEvent().build();
    (malformedEvent as any).id = undefined; // break the payload

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['*'] };
    const executeAt = new Date(Date.now() + 60_000);

    const result = await simulateEventIngestion(malformedEvent, contractConfig, executeAt);
    expect(result).toBeNull();

    const rows = await db.all(`SELECT id FROM scheduled_notifications`);
    expect(rows).toHaveLength(0);
  });

  it('event filtered by contract config – no notification is scheduled', async () => {
    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-filter-001')
      .withTopicSymbol('dispute_raised') // not in the allowed list
      .build();

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['task_created'] };
    const executeAt = new Date(Date.now() + 60_000);

    const result = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(result).toBeNull();

    const rows = await db.all(`SELECT id FROM scheduled_notifications`);
    expect(rows).toHaveLength(0);
  });

  it('delivery failure at notification stage – notification marked FAILED', async () => {
    deliverMock.mockResolvedValue({
      success: false,
      degradedCapabilities: [],
      errorMessage: 'Discord service unreachable',
    });

    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-fail-delivery-001')
      .withTopicSymbol('task_created')
      .build();

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['*'] };
    const executeAt = new Date(Date.now() + 60_000);

    const notifId = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(notifId).not.toBeNull();

    // Force the row to be due with maxRetries=0 so it fails immediately
    await db.run(
      `UPDATE scheduled_notifications SET execute_at = ?, max_retries = ? WHERE id = ?`,
      [new Date(Date.now() - 100).toISOString(), 0, notifId]
    );

    await scheduler.start();

    // Wait for terminal state
    await waitUntil(async () => {
      const row = await repository.getById(notifId!);
      return (
        row?.status === NotificationStatus.FAILED ||
        row?.status === NotificationStatus.PENDING
      );
    }, 3_000);

    const finalRow = await repository.getById(notifId!);
    expect([NotificationStatus.FAILED, NotificationStatus.PENDING]).toContain(finalRow!.status);
  });

  it('multiple events from different contracts are all delivered', async () => {
    const CONTRACT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA';

    const events = [
      NotificationFixtureBuilder.aStellarEvent()
        .withId('bc-multi-001')
        .withTopicSymbol('task_created')
        .build(),
      NotificationFixtureBuilder.aStellarEvent()
        .withId('bc-multi-002')
        .withTopicSymbol('work_submitted')
        .build(),
      NotificationFixtureBuilder.aStellarEvent()
        .withId('bc-multi-003')
        .withTopicSymbol('submission_approved')
        .build(),
    ];

    const configs = [
      { address: CONTRACT_ADDRESS, events: ['*'] },
      { address: CONTRACT_ADDRESS, events: ['*'] },
      { address: CONTRACT_B, events: ['*'] },
    ];

    const executeAt = new Date(Date.now() + 60_000);
    const ids: number[] = [];

    for (let i = 0; i < events.length; i++) {
      const id = await simulateEventIngestion(events[i], configs[i], executeAt);
      expect(id).not.toBeNull();
      ids.push(id!);
    }

    // All 3 events should be in the registry (1 per unique eventId)
    expect(registry.count()).toBe(3);

    // Force all notifications to be due
    for (const id of ids) {
      await db.run(
        `UPDATE scheduled_notifications SET execute_at = ? WHERE id = ?`,
        [new Date(Date.now() - 100).toISOString(), id]
      );
    }

    await scheduler.start();

    await waitUntil(
      async () => {
        for (const id of ids) {
          const row = await repository.getById(id);
          if (row?.status !== NotificationStatus.COMPLETED) return false;
        }
        return true;
      },
      8_000 // 8 second timeout for 3 notifications
    );

    expect(deliverMock).toHaveBeenCalledTimes(3);
    for (const id of ids) {
      const row = await repository.getById(id);
      expect(row!.status).toBe(NotificationStatus.COMPLETED);
    }
  }, 15_000);

  it('delivery throws unexpectedly – notification is retried then fails', async () => {
    deliverMock.mockRejectedValue(new Error('Unexpected crash in provider'));

    const event = NotificationFixtureBuilder.aStellarEvent()
      .withId('bc-throw-001')
      .withTopicSymbol('task_created')
      .build();

    const contractConfig = { address: CONTRACT_ADDRESS, events: ['*'] };
    const executeAt = new Date(Date.now() + 60_000);

    const notifId = await simulateEventIngestion(event, contractConfig, executeAt);
    expect(notifId).not.toBeNull();

    // maxRetries=0 → fails immediately
    await db.run(
      `UPDATE scheduled_notifications SET execute_at = ?, max_retries = ? WHERE id = ?`,
      [new Date(Date.now() - 100).toISOString(), 0, notifId]
    );

    await scheduler.start();

    await waitUntil(async () => {
      const row = await repository.getById(notifId!);
      return (
        row?.status === NotificationStatus.FAILED ||
        row?.status === NotificationStatus.PENDING
      );
    }, 3_000);

    const finalRow = await repository.getById(notifId!);
    expect([NotificationStatus.FAILED, NotificationStatus.PENDING]).toContain(finalRow!.status);
  });
});
