import * as StellarSDK from '@stellar/stellar-sdk';
import { BackfillConfig, ContractConfig } from '../types';
import { EventDeduplicationService } from './event-deduplication-service';
import { DiscordNotificationService } from './discord-notification';
import { eventRegistry } from '../store/event-registry';
import { preferenceStore } from '../store/preference-store';
import {
  getEventName,
  matchesEventFilter,
  validateEventPayload,
} from '../utils/event-utils';
import { generateRequestId } from '../utils/request-id';
import logger from '../utils/logger';

export interface BackfillProgress {
  contractAddress: string;
  startLedger: number;
  endLedger: number;
  eventsScanned: number;
  eventsRecovered: number;
  eventsSkipped: number;
  eventsErrored: number;
  pagesProcessed: number;
  completed: boolean;
}

export interface BackfillResult {
  totalEventsScanned: number;
  totalEventsRecovered: number;
  totalEventsSkipped: number;
  totalEventsErrored: number;
  contractResults: BackfillProgress[];
  durationMs: number;
}

/**
 * Options for dependency injection (primarily used in tests).
 */
export interface HistoricalBackfillServiceOptions {
  /** Override the default Stellar RPC getEvents call. */
  fetchPage?: (
    server: StellarSDK.rpc.Server,
    contractAddress: string,
    startLedger: number,
    cursor: string | undefined,
    pageSize: number
  ) => Promise<StellarSDK.rpc.Api.GetEventsResponse>;
  /** Override the network tip fetch (for tests that don't want a live RPC call). */
  getNetworkTipLedger?: (server: StellarSDK.rpc.Server) => Promise<number | null>;
}

const DEFAULT_PAGE_SIZE = 200;

/**
 * HistoricalBackfillService
 *
 * Recovers blockchain events that were missed while NotifyChain was offline.
 * For each configured contract it pages through on-chain events from
 * `startLedger` (inclusive) up to `endLedger` (defaults to the network tip)
 * and routes each event through the normal processing pipeline.
 *
 * Key guarantees:
 * - Already-processed events are skipped via the persistent deduplication
 *   layer (EventDeduplicationService / processed_events table). No duplicate
 *   notifications are sent.
 * - Progress is logged after every RPC page and on completion so operators
 *   can monitor a long-running backfill.
 * - The service is a one-shot run; it does not start a polling loop.
 */
export class HistoricalBackfillService {
  private readonly rpcUrl: string;
  private readonly contractConfigs: ContractConfig[];
  private readonly backfillConfig: BackfillConfig;
  private readonly deduplicationService: EventDeduplicationService;
  private readonly discordService: DiscordNotificationService | null;
  private readonly server: StellarSDK.rpc.Server;

  // Injectable collaborators (default to real implementations)
  private readonly _fetchPage: (
    server: StellarSDK.rpc.Server,
    contractAddress: string,
    startLedger: number,
    cursor: string | undefined,
    pageSize: number
  ) => Promise<StellarSDK.rpc.Api.GetEventsResponse>;

  private readonly _getNetworkTipLedger: (
    server: StellarSDK.rpc.Server
  ) => Promise<number | null>;

  constructor(
    rpcUrl: string,
    contractConfigs: ContractConfig[],
    backfillConfig: BackfillConfig,
    deduplicationService: EventDeduplicationService,
    discordService: DiscordNotificationService | null = null,
    options: HistoricalBackfillServiceOptions = {}
  ) {
    this.rpcUrl = rpcUrl;
    this.contractConfigs = contractConfigs;
    this.backfillConfig = backfillConfig;
    this.deduplicationService = deduplicationService;
    this.discordService = discordService;
    this.server = new StellarSDK.rpc.Server(rpcUrl);

    this._fetchPage = options.fetchPage ?? defaultFetchPage;
    this._getNetworkTipLedger = options.getNetworkTipLedger ?? defaultGetNetworkTipLedger;
  }

  /**
   * Run the backfill to completion and return an aggregate result summary.
   *
   * The method is safe to await at startup; it resolves only once every
   * contract has been fully backfilled (or has hit its configured limits).
   */
  async run(): Promise<BackfillResult> {
    const startedAt = Date.now();
    const requestId = generateRequestId();

    // Resolve end ledger: use configured value or fall back to network tip.
    const endLedger = await this.resolveEndLedger(requestId);
    if (endLedger === null) {
      logger.error('Backfill aborted: could not determine end ledger', { requestId });
      return {
        totalEventsScanned: 0,
        totalEventsRecovered: 0,
        totalEventsSkipped: 0,
        totalEventsErrored: 0,
        contractResults: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const { startLedger } = this.backfillConfig;

    logger.info('Historical backfill starting', {
      requestId,
      startLedger,
      endLedger,
      contracts: this.contractConfigs.length,
      maxPages: this.backfillConfig.maxPages,
      maxEventsPerContract: this.backfillConfig.maxEventsPerContract,
    });

    const contractResults: BackfillProgress[] = [];

    for (const contractConfig of this.contractConfigs) {
      const progress = await this.backfillContract(
        contractConfig,
        startLedger,
        endLedger,
        requestId
      );
      contractResults.push(progress);
    }

    const result: BackfillResult = {
      totalEventsScanned: contractResults.reduce((s, r) => s + r.eventsScanned, 0),
      totalEventsRecovered: contractResults.reduce((s, r) => s + r.eventsRecovered, 0),
      totalEventsSkipped: contractResults.reduce((s, r) => s + r.eventsSkipped, 0),
      totalEventsErrored: contractResults.reduce((s, r) => s + r.eventsErrored, 0),
      contractResults,
      durationMs: Date.now() - startedAt,
    };

    logger.info('Historical backfill complete', {
      requestId,
      startLedger,
      endLedger,
      totalEventsScanned: result.totalEventsScanned,
      totalEventsRecovered: result.totalEventsRecovered,
      totalEventsSkipped: result.totalEventsSkipped,
      totalEventsErrored: result.totalEventsErrored,
      durationMs: result.durationMs,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveEndLedger(requestId: string): Promise<number | null> {
    if (this.backfillConfig.endLedger !== undefined) {
      return this.backfillConfig.endLedger;
    }

    const tip = await this._getNetworkTipLedger(this.server);
    if (tip === null) {
      logger.warn('Could not fetch network tip ledger; backfill cannot determine end ledger', {
        requestId,
        rpcUrl: this.rpcUrl,
      });
    }
    return tip;
  }

  private async backfillContract(
    contractConfig: ContractConfig,
    startLedger: number,
    endLedger: number,
    requestId: string
  ): Promise<BackfillProgress> {
    const { address: contractAddress } = contractConfig;
    const maxPages = this.backfillConfig.maxPages ?? 50;
    const maxEvents = this.backfillConfig.maxEventsPerContract ?? 10_000;

    const progress: BackfillProgress = {
      contractAddress,
      startLedger,
      endLedger,
      eventsScanned: 0,
      eventsRecovered: 0,
      eventsSkipped: 0,
      eventsErrored: 0,
      pagesProcessed: 0,
      completed: false,
    };

    logger.info('Backfill: starting contract', {
      requestId,
      contractAddress,
      startLedger,
      endLedger,
      maxPages,
      maxEvents,
    });

    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      let response: StellarSDK.rpc.Api.GetEventsResponse;

      try {
        response = await this._fetchPage(
          this.server,
          contractAddress,
          startLedger,
          cursor,
          DEFAULT_PAGE_SIZE
        );
      } catch (error) {
        logger.error('Backfill: RPC page fetch failed, stopping this contract', {
          requestId,
          contractAddress,
          page,
          cursor,
          error,
        });
        break;
      }

      const batch = response.events ?? [];
      progress.pagesProcessed++;

      // Filter out events beyond the requested end ledger before processing.
      const inWindow = batch.filter((ev) => ev.ledger <= endLedger);

      for (const event of inWindow) {
        progress.eventsScanned++;

        if (progress.eventsScanned > maxEvents) {
          logger.warn('Backfill: maxEventsPerContract reached, stopping this contract', {
            requestId,
            contractAddress,
            maxEvents,
          });
          // Break out of the event loop; outer page loop will also exit via
          // the cap check at the top of each iteration.
          break;
        }

        await this.processOneEvent(event, contractConfig, requestId, progress);
      }

      // Log page-level progress so operators can observe long-running backfills.
      logger.info('Backfill: page processed', {
        requestId,
        contractAddress,
        page: progress.pagesProcessed,
        batchSize: batch.length,
        inWindow: inWindow.length,
        eventsScanned: progress.eventsScanned,
        eventsRecovered: progress.eventsRecovered,
        eventsSkipped: progress.eventsSkipped,
        eventsErrored: progress.eventsErrored,
      });

      // Determine whether to continue paging.
      const capped = progress.eventsScanned > maxEvents;
      const noMoreEvents = !response.cursor || batch.length === 0;
      const pastWindow = batch.length > 0 && batch[batch.length - 1].ledger > endLedger;

      if (capped || noMoreEvents || pastWindow) {
        break;
      }

      cursor = response.cursor;
    }

    progress.completed = true;

    logger.info('Backfill: contract complete', {
      requestId,
      contractAddress,
      eventsScanned: progress.eventsScanned,
      eventsRecovered: progress.eventsRecovered,
      eventsSkipped: progress.eventsSkipped,
      eventsErrored: progress.eventsErrored,
      pagesProcessed: progress.pagesProcessed,
    });

    return progress;
  }

  /**
   * Process a single event through the same pipeline as the live subscriber:
   *
   *  1. Validate payload structure.
   *  2. Check event-name filter.
   *  3. Persistent dedup check — skip if already processed.
   *  4. Register in event-registry (in-memory display store).
   *  5. Send Discord notification (respects user preferences).
   *  6. Record in processed_events.
   */
  private async processOneEvent(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId: string,
    progress: BackfillProgress
  ): Promise<void> {
    const { address: contractAddress } = contractConfig;

    // 1. Payload validation — mirrors shouldProcessEvent in EventSubscriber.
    const validation = validateEventPayload(event);
    if (!validation.valid) {
      logger.warn('Backfill: skipping invalid event payload', {
        requestId,
        contractAddress,
        eventId: event.id,
        reason: validation.reason,
      });
      progress.eventsSkipped++;
      return;
    }

    // 2. Event-name filter.
    const eventName = getEventName(event.topic);
    if (!matchesEventFilter(eventName, contractConfig.events)) {
      progress.eventsSkipped++;
      return;
    }

    // 3. Persistent deduplication — skip events already in processed_events.
    const dupCheck = await this.deduplicationService.isDuplicate(event.id, contractAddress);
    if (dupCheck.isDuplicate) {
      logger.debug('Backfill: event already processed, skipping', {
        requestId,
        eventId: event.id,
        contractAddress,
        isReorgDuplicate: dupCheck.isReorgDuplicate,
      });
      progress.eventsSkipped++;
      return;
    }

    // 4. Register in the in-memory event registry.
    eventRegistry.addFromInput({
      eventId: event.id,
      contractAddress,
      eventName,
      ledger: event.ledger,
      type: event.type,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
    });

    // 5. Discord notification (optional, honour user preferences).
    let notificationSent = false;
    let processingError: string | undefined;

    if (this.discordService) {
      const userId = contractConfig.userId ?? 'global';
      if (!preferenceStore.isCategoryEnabled(userId, 'discord')) {
        logger.debug('Backfill: Discord notification skipped by user preference', {
          requestId,
          eventId: event.id,
          userId,
        });
      } else {
        try {
          notificationSent = await this.discordService.sendEventNotification(
            event,
            contractConfig,
            requestId
          );
        } catch (error) {
          processingError = error instanceof Error ? error.message : String(error);
          logger.error('Backfill: Discord notification failed', {
            requestId,
            eventId: event.id,
            contractAddress,
            error: processingError,
          });
        }
      }
    }

    // 6. Persist the processed-event record so future runs skip this event.
    await this.deduplicationService.recordProcessedEvent(
      event.id,
      contractAddress,
      event.ledger,
      event.txHash,
      event.type,
      notificationSent,
      processingError ? 'ERROR' : 'PROCESSED',
      processingError
    );

    if (processingError) {
      progress.eventsErrored++;
    } else {
      progress.eventsRecovered++;
    }
  }
}

// ---------------------------------------------------------------------------
// Default RPC collaborator implementations
// ---------------------------------------------------------------------------

async function defaultFetchPage(
  server: StellarSDK.rpc.Server,
  contractAddress: string,
  startLedger: number,
  cursor: string | undefined,
  pageSize: number
): Promise<StellarSDK.rpc.Api.GetEventsResponse> {
  const request: StellarSDK.rpc.Api.GetEventsRequest = cursor
    ? {
        filters: [{ contractIds: [contractAddress], type: 'contract' }],
        cursor,
        limit: pageSize,
      }
    : {
        filters: [{ contractIds: [contractAddress], type: 'contract' }],
        startLedger,
        limit: pageSize,
      };

  return server.getEvents(request);
}

async function defaultGetNetworkTipLedger(
  server: StellarSDK.rpc.Server
): Promise<number | null> {
  try {
    const latest: any = await (server as any).getLatestLedger();
    if (typeof latest?.sequence === 'number') return latest.sequence;
    if (typeof latest?.ledger === 'number') return latest.ledger;
    if (typeof latest?.latestLedger === 'number') return latest.latestLedger;
    return null;
  } catch {
    return null;
  }
}
