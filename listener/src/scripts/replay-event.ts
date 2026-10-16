#!/usr/bin/env ts-node
/**
 * Event Replay Command
 * 
 * Replays a previously processed event through the normal processing pipeline.
 * 
 * Usage:
 *   npm run replay-event -- <event_id>
 *   or
 *   ts-node src/scripts/replay-event.ts <event_id>
 * 
 * Acceptance Criteria:
 * - An event can be selected by identifier (event_id)
 * - Replay uses the normal processing path
 * - Replay does not create unintended duplicates (handled by deduplication service)
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { Database } from '../database/database';
import { EventDeduplicationService } from '../services/event-deduplication-service';
import { DiscordNotificationService } from '../services/discord-notification';
import { EventSubscriber } from '../services/event-subscriber';
import { loadConfig, validateConfig } from '../config';
import logger from '../utils/logger';
import { generateCorrelationId } from '../utils/request-id';
import * as dotenv from 'dotenv';
import { ContractConfig } from '../types';

dotenv.config();

interface EventRecord {
  event_id: string;
  contract_address: string;
  ledger_number: number;
  tx_hash: string | null;
  event_type: string;
  status: string;
}

async function main() {
  const eventId = process.argv[2];

  if (!eventId) {
    console.error('Error: Event ID is required');
    console.error('Usage: ts-node src/scripts/replay-event.ts <event_id>');
    process.exit(1);
  }

  try {
    logger.info('Starting event replay', { eventId });

    // Load configuration
    const config = loadConfig();
    validateConfig(config);

    // Initialize database
    const db = new Database(config.databasePath || './data/notifications.db');
    await db.initialize();

    // Find the event in the database
    const eventRecord = await db.get<EventRecord>(
      `
      SELECT event_id, contract_address, ledger_number, tx_hash, event_type, status
      FROM processed_events
      WHERE event_id = ?
      LIMIT 1
      `,
      [eventId]
    );

    if (!eventRecord) {
      logger.error('Event not found in processed_events table', { eventId });
      console.error(`Error: Event with ID "${eventId}" not found in database`);
      await db.close();
      process.exit(1);
    }

    logger.info('Found event record', {
      eventId: eventRecord.event_id,
      contractAddress: eventRecord.contract_address,
      ledger: eventRecord.ledger_number,
      eventType: eventRecord.event_type,
      status: eventRecord.status,
    });

    // Initialize Stellar RPC server
    const server = new StellarSDK.rpc.Server(config.stellarRpcUrl);

    // Fetch the event from Stellar RPC
    // We need to get events from the ledger where this event occurred
    logger.info('Fetching event from Stellar RPC', {
      ledger: eventRecord.ledger_number,
      contractAddress: eventRecord.contract_address,
    });

    const eventsResponse = await server.getEvents({
      filters: [
        {
          contractIds: [eventRecord.contract_address],
          type: 'contract',
        },
      ],
      startLedger: eventRecord.ledger_number,
      limit: 100,
    });

    // Find the specific event by ID
    const eventToReplay = eventsResponse.events?.find((e: StellarSDK.rpc.Api.EventResponse) => e.id === eventId);

    if (!eventToReplay) {
      logger.error('Event not found in Stellar RPC response', {
        eventId,
        ledger: eventRecord.ledger_number,
      });
      console.error(`Error: Event with ID "${eventId}" not found on Stellar RPC`);
      await db.close();
      process.exit(1);
    }

    logger.info('Found event on Stellar RPC', {
      eventId: eventToReplay.id,
      type: eventToReplay.type,
    });

    // Find the contract config for this event
    const contractConfig = config.contractAddresses.find(
      (c) => c.address === eventRecord.contract_address
    );

    if (!contractConfig) {
      logger.error('Contract configuration not found', {
        contractAddress: eventRecord.contract_address,
      });
      console.error(`Error: Contract configuration for "${eventRecord.contract_address}" not found`);
      await db.close();
      process.exit(1);
    }

    // Initialize deduplication service
    const deduplicationService = new EventDeduplicationService(db);

    // Initialize Discord service if configured
    let discordService: DiscordNotificationService | null = null;
    if (config.discord) {
      discordService = new DiscordNotificationService(config.discord);
    }

    // Create a minimal EventSubscriber instance to access processEvent
    // We use a minimal approach to avoid starting the full polling loop
    const subscriber = new EventSubscriber(config, deduplicationService);

    // Generate correlation ID for this replay
    const correlationId = generateCorrelationId();

    logger.info('Replaying event through processing pipeline', {
      eventId,
      correlationId,
      contractAddress: contractConfig.address,
    });

    // Process the event using the normal pipeline
    // We access the private processEvent method via the subscriber instance
    const success = await (subscriber as any).processEvent(
      eventToReplay,
      contractConfig,
      correlationId,
      correlationId
    );

    if (success) {
      logger.info('Event replay completed successfully', {
        eventId,
        correlationId,
      });
      console.log(`✓ Event "${eventId}" replayed successfully`);
    } else {
      logger.warn('Event replay completed with warnings', {
        eventId,
        correlationId,
      });
      console.log(`⚠ Event "${eventId}" replayed with warnings (check logs for details)`);
    }

    await db.close();
    process.exit(0);
  } catch (error) {
    logger.error('Event replay failed', { eventId, error });
    console.error(`Error: Failed to replay event "${eventId}"`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
