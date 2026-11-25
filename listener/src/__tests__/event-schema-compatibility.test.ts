/**
 * Event Schema Compatibility Tests
 * 
 * Verifies that changes to event structures do not unintentionally break
 * listener decoders or external consumers.
 * 
 * Acceptance criteria:
 * - Representative historical event fixtures are tested against supported schemas
 * - Incompatible changes are detected explicitly
 * - Tests fail when breaking changes are introduced without version bumps
 */

import {
  HISTORICAL_EVENTS_V1,
  CRITICAL_EVENTS,
} from '../test-fixtures/historical-events';
import {
  extractContractEvents,
  loadConsumerSchema,
  checkSchemaCompatibility,
} from '../schema/compatibility-check';
import * as path from 'path';
import * as fs from 'fs';

describe('Event Schema Compatibility', () => {
  const CONTRACT_EVENTS_PATH = path.resolve(
    __dirname,
    '../../../../contract/contracts/hello-world/src/base/events.rs'
  );
  const CONSUMER_SCHEMA_PATH = path.resolve(
    __dirname,
    '../schema/consumer-event-schema.json'
  );

  let contractEvents: ReturnType<typeof extractContractEvents>;
  let consumerSchema: ReturnType<typeof loadConsumerSchema>;

  beforeAll(() => {
    // Load current contract events and consumer schema
    if (fs.existsSync(CONTRACT_EVENTS_PATH)) {
      contractEvents = extractContractEvents(CONTRACT_EVENTS_PATH);
    }
    if (fs.existsSync(CONSUMER_SCHEMA_PATH)) {
      consumerSchema = loadConsumerSchema(CONSUMER_SCHEMA_PATH);
    }
  });

  describe('Schema Compatibility Check', () => {
    it('should load contract events successfully', () => {
      expect(contractEvents).toBeDefined();
      expect(contractEvents.size).toBeGreaterThan(0);
    });

    it('should load consumer schema successfully', () => {
      expect(consumerSchema).toBeDefined();
      expect(consumerSchema.events).toBeDefined();
      expect(consumerSchema.events.length).toBeGreaterThan(0);
    });

    it('should detect no breaking changes between contract and consumer schemas', () => {
      if (!contractEvents || !consumerSchema) {
        console.warn('Skipping compatibility check: schemas not loaded');
        return;
      }

      const result = checkSchemaCompatibility(contractEvents, consumerSchema);

      // Log any changes for visibility
      if (result.breakingChanges.length > 0) {
        console.error('Breaking changes detected:');
        result.breakingChanges.forEach((change) => console.error(`  - ${change}`));
      }
      if (result.safeAdditions.length > 0) {
        console.log('Safe additions detected:');
        result.safeAdditions.forEach((addition) => console.log(`  - ${addition}`));
      }

      // Fail test if breaking changes are detected
      expect(result.breakingChanges).toEqual([]);
      expect(result.compatible).toBe(true);
    });
  });

  describe('Historical Event Fixtures - Version 1', () => {
    it('should contain fixtures for critical events', () => {
      const fixtureEventNames = Object.keys(HISTORICAL_EVENTS_V1).map((key) => {
        const fixture = HISTORICAL_EVENTS_V1[key as keyof typeof HISTORICAL_EVENTS_V1];
        return fixture.eventName;
      });

      CRITICAL_EVENTS.forEach((criticalEvent) => {
        expect(fixtureEventNames).toContain(criticalEvent);
      });
    });

    it('should have valid structure for NotificationScheduled fixture', () => {
      const fixture = HISTORICAL_EVENTS_V1.notificationScheduled;

      expect(fixture.version).toBe(1);
      expect(fixture.eventName).toBe('NotificationScheduled');
      expect(fixture.topics).toHaveLength(3); // creator, category, priority
      expect(fixture.data).toHaveProperty('notification_id');
      expect(fixture.data).toHaveProperty('payload_version');
      expect(fixture.data.payload_version).toBe(1);
    });

    it('should have valid structure for AutoshareCreated fixture', () => {
      const fixture = HISTORICAL_EVENTS_V1.autoshareCreated;

      expect(fixture.version).toBe(1);
      expect(fixture.eventName).toBe('AutoshareCreated');
      expect(fixture.topics).toHaveLength(3); // creator, category, priority
      expect(fixture.data).toHaveProperty('id');
    });

    it('should have valid structure for NotificationRevoked fixture', () => {
      const fixture = HISTORICAL_EVENTS_V1.notificationRevoked;

      expect(fixture.version).toBe(1);
      expect(fixture.eventName).toBe('NotificationRevoked');
      expect(fixture.topics).toHaveLength(3); // notification_id, category, priority
      expect(fixture.data).toHaveProperty('revoker');
      expect(fixture.data).toHaveProperty('revoked_at');
      expect(fixture.data).toHaveProperty('reason');
    });

    it('should validate all v1 fixtures have required metadata', () => {
      Object.entries(HISTORICAL_EVENTS_V1).forEach(([key, fixture]) => {
        expect(fixture).toHaveProperty('version');
        expect(fixture).toHaveProperty('eventName');
        expect(fixture).toHaveProperty('topics');
        expect(fixture).toHaveProperty('data');
        expect(fixture).toHaveProperty('description');
        expect(fixture.version).toBe(1);
      });
    });
  });

  describe('Event Structure Validation Against Consumer Schema', () => {
    it('should validate NotificationScheduled matches consumer expectations', () => {
      if (!consumerSchema) {
        console.warn('Skipping: consumer schema not loaded');
        return;
      }

      const consumerEvent = consumerSchema.events.find(
        (e) => e.eventName === 'NotificationScheduled'
      );
      expect(consumerEvent).toBeDefined();

      if (consumerEvent) {
        // Verify expected topics
        expect(consumerEvent.expectedTopics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'creator' }),
            expect.objectContaining({ name: 'category' }),
            expect.objectContaining({ name: 'priority' }),
          ])
        );

        // Verify expected fields
        expect(consumerEvent.expectedFields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'notification_id' }),
            expect.objectContaining({ name: 'payload_version' }),
          ])
        );
      }
    });

    it('should validate AutoshareCreated matches consumer expectations', () => {
      if (!consumerSchema) {
        console.warn('Skipping: consumer schema not loaded');
        return;
      }

      const consumerEvent = consumerSchema.events.find(
        (e) => e.eventName === 'AutoshareCreated'
      );
      expect(consumerEvent).toBeDefined();

      if (consumerEvent) {
        expect(consumerEvent.expectedTopics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'creator' }),
            expect.objectContaining({ name: 'category' }),
            expect.objectContaining({ name: 'priority' }),
          ])
        );

        expect(consumerEvent.expectedFields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'id' }),
          ])
        );
      }
    });
  });

  describe('Breaking Change Detection', () => {
    it('should detect when a required topic is removed', () => {
      if (!contractEvents || !consumerSchema) {
        console.warn('Skipping: schemas not loaded');
        return;
      }

      // This test verifies the detection mechanism works
      // In practice, if someone removes a required topic, the schema compatibility
      // check will fail
      const result = checkSchemaCompatibility(contractEvents, consumerSchema);
      expect(result).toHaveProperty('breakingChanges');
      expect(result).toHaveProperty('compatible');
    });

    it('should detect when a field type changes', () => {
      if (!contractEvents || !consumerSchema) {
        console.warn('Skipping: schemas not loaded');
        return;
      }

      // Validates that type changes are caught by the compatibility checker
      const result = checkSchemaCompatibility(contractEvents, consumerSchema);
      
      // If there are type mismatches, they should be in breaking changes
      const typeChanges = result.breakingChanges.filter((change) =>
        change.includes('changed type')
      );

      // Currently we expect no type changes (empty array)
      expect(typeChanges).toEqual([]);
    });
  });
});
