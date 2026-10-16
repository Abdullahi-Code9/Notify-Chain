import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkEventCompatibility,
  checkSchemaCompatibility,
  ContractEventSchema,
  extractContractEvents,
  loadConsumerSchema,
  OffConsumerEventSchema,
} from './compatibility-check';

const contractEventsPath = path.resolve(
  __dirname,
  '../../../contract/contracts/hello-world/src/base/events.rs'
);
const consumerSchemaPath = path.resolve(__dirname, 'consumer-event-schema.json');

function writeTempSchema(value: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'event-schema-'));
  const filePath = path.join(directory, 'consumer.json');
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function makeEvent(
  overrides: Partial<ContractEventSchema> = {}
): ContractEventSchema {
  return {
    name: 'TaskCreated',
    topics: [{ name: 'creator', type: 'Address' }],
    dataFields: [{ name: 'id', type: 'BytesN<32>' }],
    ...overrides,
  };
}

function makeConsumer(
  overrides: Partial<OffConsumerEventSchema> = {}
): OffConsumerEventSchema {
  return {
    eventName: 'TaskCreated',
    expectedTopics: [{ name: 'creator', type: 'Address' }],
    expectedFields: [{ name: 'id', type: 'BytesN<32>' }],
    ...overrides,
  };
}

describe('event schema compatibility check', () => {
  it('extracts typed event topics and data fields from the contract source', () => {
    const events = extractContractEvents(contractEventsPath);
    const created = events.get('AutoshareCreated');

    expect(events).toHaveProperty('size', 34);
    expect(created).toEqual({
      name: 'AutoshareCreated',
      topics: [
        { name: 'creator', type: 'Address' },
        { name: 'category', type: 'NotificationCategory' },
        { name: 'priority', type: 'NotificationPriority' },
      ],
      dataFields: [{ name: 'id', type: 'BytesN<32>' }],
    });
  });

  it('accepts the checked-in schema when it matches the contract', () => {
    const result = checkSchemaCompatibility(
      extractContractEvents(contractEventsPath),
      loadConsumerSchema(consumerSchemaPath)
    );

    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toEqual([]);
    expect(result.safeAdditions).toEqual([]);
  });

  it.each([
    ['removed field', makeEvent({ dataFields: [] }), makeConsumer()],
    [
      'reordered field',
      makeEvent({ dataFields: [{ name: 'new_id', type: 'BytesN<32>' }] }),
      makeConsumer(),
    ],
    [
      'incompatible field type',
      makeEvent({ dataFields: [{ name: 'id', type: 'String' }] }),
      makeConsumer(),
    ],
    [
      'incompatible topic type',
      makeEvent({ topics: [{ name: 'creator', type: 'String' }] }),
      makeConsumer(),
    ],
  ])('rejects a %s', (_description, contractEvent, consumerEvent) => {
    const result = checkEventCompatibility(
      contractEvent as ContractEventSchema,
      consumerEvent as OffConsumerEventSchema
    );

    expect(result.compatible).toBe(false);
    expect(result.breakingChanges.length).toBeGreaterThan(0);
  });

  it('accepts and reports trailing topics and data fields', () => {
    const result = checkEventCompatibility(
      makeEvent({
        topics: [
          { name: 'creator', type: 'Address' },
          { name: 'category', type: 'NotificationCategory' },
        ],
        dataFields: [
          { name: 'id', type: 'BytesN<32>' },
          { name: 'created_at', type: 'u64' },
        ],
      }),
      makeConsumer()
    );

    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toEqual([]);
    expect(result.safeAdditions).toEqual([
      "Safe addition: Trailing topic 'category' added to 'TaskCreated'",
      "Safe addition: Trailing data field 'created_at' added to 'TaskCreated'",
    ]);
  });

  it('accepts new contract events and rejects removed expected events', () => {
    const contractEvents = new Map([
      ['TaskCreated', makeEvent()],
      ['TaskUpdated', makeEvent({ name: 'TaskUpdated' })],
    ]);
    const compatible = checkSchemaCompatibility(contractEvents, {
      events: [makeConsumer()],
    });
    const missing = checkSchemaCompatibility(new Map(), { events: [makeConsumer()] });

    expect(compatible.compatible).toBe(true);
    expect(compatible.safeAdditions).toEqual([
      "Safe addition: New event 'TaskUpdated' is ignored by existing consumers",
    ]);
    expect(missing.compatible).toBe(false);
    expect(missing.breakingChanges[0]).toContain("event 'TaskCreated'");
  });

  it('rejects empty or malformed consumer schemas', () => {
    const emptyPath = writeTempSchema({ events: [] });
    const malformedPath = writeTempSchema({ events: [{ eventName: 'TaskCreated' }] });
    const duplicatePath = writeTempSchema({ events: [makeConsumer(), makeConsumer()] });

    expect(() => loadConsumerSchema(emptyPath)).toThrow('valid event names');
    expect(() => loadConsumerSchema(malformedPath)).toThrow('valid event names');
    expect(() => loadConsumerSchema(duplicatePath)).toThrow('duplicate event names');

    fs.rmSync(path.dirname(emptyPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(malformedPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(duplicatePath), { recursive: true, force: true });
  });

  it('rejects an empty contract schema', () => {
    expect(checkSchemaCompatibility(new Map(), { events: [makeConsumer()] }).compatible).toBe(false);
  });
});
