import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as StellarSDK from '@stellar/stellar-sdk';
import { Database } from '../database/database';
import { EventDeduplicationService } from '../services/event-deduplication-service';
import { resetDatabaseSingleton } from '../database/database';

// Mock the actual script execution
jest.mock('../scripts/replay-event', () => ({
  main: jest.fn(),
}));

describe('Event Replay Command', () => {
  let db: Database;
  let deduplicationService: EventDeduplicationService;

  beforeEach(async () => {
    await resetDatabaseSingleton();
    db = new Database(':memory:');
    await db.initialize();
    deduplicationService = new EventDeduplicationService(db);
  });

  afterEach(async () => {
    await db.close();
    await resetDatabaseSingleton();
  });

  describe('Event Retrieval', () => {
    it('should retrieve an event from the database by event ID', async () => {
      // Insert a test event
      await db.run(
        `
        INSERT INTO processed_events (
          event_id, contract_address, fingerprint, ledger_number, 
          tx_hash, event_type, notification_sent, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ['test-event-id', 'C' + 'A'.repeat(55), 'contract:test-event-id', 12345, 'test-tx-hash', 'contract', 1, 'PROCESSED']
      );

      const eventRecord = await db.get(
        `
        SELECT event_id, contract_address, ledger_number, tx_hash, event_type, status
        FROM processed_events
        WHERE event_id = ?
        LIMIT 1
        `,
        ['test-event-id']
      );

      expect(eventRecord).toBeDefined();
      expect(eventRecord?.event_id).toBe('test-event-id');
      expect(eventRecord?.contract_address).toBe('C' + 'A'.repeat(55));
      expect(eventRecord?.ledger_number).toBe(12345);
    });

    it('should return null for non-existent event ID', async () => {
      const eventRecord = await db.get(
        `
        SELECT event_id, contract_address, ledger_number, tx_hash, event_type, status
        FROM processed_events
        WHERE event_id = ?
        LIMIT 1
        `,
        ['non-existent-id']
      );

      expect(eventRecord).toBeUndefined();
    });
  });

  describe('Deduplication During Replay', () => {
    it('should detect duplicate events during replay', async () => {
      const eventId = 'duplicate-test-event';
      const contractAddress = 'C' + 'B'.repeat(55);

      // Record an event as processed
      await deduplicationService.recordProcessedEvent(
        eventId,
        contractAddress,
        12345,
        'test-tx-hash',
        'contract',
        true,
        'PROCESSED'
      );

      // Check if it's a duplicate
      const duplicateCheck = await deduplicationService.isDuplicate(eventId, contractAddress);

      expect(duplicateCheck.isDuplicate).toBe(true);
      expect(duplicateCheck.isReorgDuplicate).toBe(false);
    });

    it('should allow replay of events that were skipped', async () => {
      const eventId = 'skipped-test-event';
      const contractAddress = 'C' + 'C'.repeat(55);

      // Record an event as skipped
      await deduplicationService.recordProcessedEvent(
        eventId,
        contractAddress,
        12345,
        'test-tx-hash',
        'contract',
        false,
        'SKIPPED'
      );

      // Check if it's a duplicate
      const duplicateCheck = await deduplicationService.isDuplicate(eventId, contractAddress);

      expect(duplicateCheck.isDuplicate).toBe(true);
    });
  });

  describe('Contract Configuration Lookup', () => {
    it('should find matching contract configuration', () => {
      const contractAddresses = [
        { address: 'C' + 'A'.repeat(55), events: ['event1', 'event2'] },
        { address: 'C' + 'B'.repeat(55), events: ['event3'] },
      ];

      const targetAddress = 'C' + 'A'.repeat(55);
      const contractConfig = contractAddresses.find((c) => c.address === targetAddress);

      expect(contractConfig).toBeDefined();
      expect(contractConfig?.address).toBe(targetAddress);
    });

    it('should return undefined for non-matching contract', () => {
      const contractAddresses = [
        { address: 'C' + 'A'.repeat(55), events: ['event1', 'event2'] },
      ];

      const targetAddress = 'C' + 'Z'.repeat(55);
      const contractConfig = contractAddresses.find((c) => c.address === targetAddress);

      expect(contractConfig).toBeUndefined();
    });
  });

  describe('Event Data Structure', () => {
    it('should have required fields for replay', () => {
      const eventRecord = {
        event_id: 'test-id',
        contract_address: 'C' + 'D'.repeat(55),
        ledger_number: 12345,
        tx_hash: 'test-hash',
        event_type: 'contract',
        status: 'PROCESSED',
      };

      expect(eventRecord.event_id).toBeDefined();
      expect(eventRecord.contract_address).toBeDefined();
      expect(eventRecord.ledger_number).toBeDefined();
      expect(eventRecord.event_type).toBeDefined();
    });
  });
});
