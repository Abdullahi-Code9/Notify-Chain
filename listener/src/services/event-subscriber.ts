import * as StellarSDK from '@stellar/stellar-sdk';
import { Config, ContractConfig } from '../types';
import { eventRegistry } from '../store/event-registry';
import { preferenceStore } from '../store/preference-store';
import logger from '../utils/logger';
import { generateCorrelationId, generateRequestId } from '../utils/request-id';
import {
  getEventName,
  matchesEventFilter,
  validateEventPayload,
  validateRpcResponse,
} from '../utils/event-utils';
import { DiscordNotificationService } from './discord-notification';
import { NotificationRetryQueue } from './notification-retry-queue';
import { EventDeduplicationService } from './event-deduplication-service';
import { EventProcessingQueue } from './event-processing-queue';
import { NotificationExpirationService } from './notification-expiration';
import { pollingMetrics } from './polling-metrics';
import { RpcRateLimiter } from './rpc-rate-limiter';
import { normalizeSorobanEvent } from './event-normalization';
import { provenanceDiagnostic, validateEventProvenance } from './event-provenance';
import { EventQuarantineController } from './event-quarantine';
import { StellarRpcManager } from './stellar-rpc-manager';
import {
  TransactionMetadataResolver,
  TransactionMetadataSource,
  extractTransactionContext,
} from './transaction-metadata-resolver';
import { safeLedgerRangeValidation } from '../utils/ledger-range-validator';
import { eventLatencyStore, StageTimer, type EventLatencyRecord } from './event-latency-tracker';
import { isSupportedEventSchemaVersion } from '../utils/event-schema-version';

type RpcEvent = StellarSDK.rpc.Api.EventResponse;

/** Optional collaborators for {@link EventSubscriber}; primarily used in tests. */
export interface EventSubscriberOptions {
  /**
   * Resolver used to enrich processed events with blockchain transaction
   * metadata. Defaults to an RPC-backed resolver.
   */
  transactionMetadataResolver?: TransactionMetadataResolver;
}

export class EventSubscriber {
  private config: Config;
  private rpcManager: StellarRpcManager;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private lastCursors: Map<string, string> = new Map();
  private discordService: DiscordNotificationService | null = null;
  private retryQueue: NotificationRetryQueue | null = null;
  private deduplicationService: EventDeduplicationService | null = null;
  private eventQueue: EventProcessingQueue | null = null;
  private expirationService: NotificationExpirationService | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private rpcRateLimiter: RpcRateLimiter | null = null;
  private backfillStartLedger: number | null = null;
  private readonly quarantine = new EventQuarantineController();
  /**
   * Stage timings measured before `processEvent` runs (batch retrieval and
   * pre-filter validation), keyed by the RPC event object so they survive
   * the hop through the processing queue (issue #1120). WeakMap entries are
   * released with the event, so missing timings are simply reported absent.
   */
  private readonly preProcessTimings = new WeakMap<
    object,
    { retrievalMs?: number; validationMs?: number }
  >();
  private readonly transactionMetadataResolver: TransactionMetadataResolver;

  constructor(
    config: Config,
    deduplicationService?: EventDeduplicationService,
    options: EventSubscriberOptions = {},
  ) {
    this.config = config;
    this.rpcManager = new StellarRpcManager({
      primaryUrl: config.stellarRpcUrl,
      fallbackUrls: config.stellarRpcFallbackUrls,
      failureThreshold: config.rpcFallback?.failureThreshold,
      cooldownMs: config.rpcFallback?.cooldownMs,
      requestTimeoutMs: config.rpcFallback?.requestTimeoutMs,
      maxRetries: config.rpcFallback?.maxRetries,
      failbackToPrimary: config.rpcFallback?.failbackToPrimary,
    });
    this.deduplicationService = deduplicationService ?? null;

    // Initialize RPC rate limiter if configured
    if (config.rpcRateLimit) {
      this.rpcRateLimiter = new RpcRateLimiter(config.rpcRateLimit);
    }

    // Initialize expiration service if configured
    if (config.expiration) {
      this.expirationService = new NotificationExpirationService(config.expiration);
    }

    if (config.discord) {
      this.discordService = new DiscordNotificationService(config.discord);
      this.retryQueue = new NotificationRetryQueue(
        (event, contractConfig, requestId) =>
          this.discordService!.sendEventNotification(event, contractConfig, requestId),
        { ...config.retryQueue, retryPolicy: config.retryPolicy },
      );
    }
    if (config.eventQueue) {
      this.eventQueue = new EventProcessingQueue(
        (event, contractConfig, requestId) => this.processEvent(event, contractConfig, requestId),
        { ...config.eventQueue, retryPolicy: config.retryPolicy },
      );
    }

    this.transactionMetadataResolver =
      options.transactionMetadataResolver ??
      new TransactionMetadataResolver({ source: this.createDefaultMetadataSource() });
  }

  /**
   * Best-effort RPC-backed source for the transaction context that is not
   * carried on the event response. Failures are handled by the resolver and
   * never prevent the event from being processed.
   */
  private createDefaultMetadataSource(): TransactionMetadataSource {
    return {
      fetchTransactionContext: async (txHash: string) => {
        const server = this.rpcManager.getActiveServer();
        const response = await server.getTransaction(txHash);
        return extractTransactionContext(response);
      },
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Event subscriber already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting event subscriber service');
    await this.restoreCheckpoints();
    this.eventQueue?.start();
    this.retryQueue?.start();
    this.poll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.eventQueue?.stop();
    this.retryQueue?.stop();
    logger.info('Stopping event subscriber service');
  }

  /**
   * Restore the in-memory cursor map from persisted checkpoints.
   *
   * Called once at the start of `start()` before the poll loop begins.
   * For each configured contract address, if a row exists in
   * `polling_cursors`, the stored cursor string is loaded into
   * `this.lastCursors` so the first poll resumes from the last known
   * position rather than replaying from the beginning.
   *
   * Failures are logged and swallowed per-contract so a single bad DB
   * row never prevents the subscriber from starting.
   */
  private async restoreCheckpoints(): Promise<void> {
    if (!this.deduplicationService) {
      return;
    }

    let restored = 0;

    for (const contractConfig of this.config.contractAddresses) {
      try {
        const record = await this.deduplicationService.getLastCursor(contractConfig.address);
        if (record) {
          this.lastCursors.set(contractConfig.address, record.cursor);
          restored++;
          logger.info('Checkpoint restored', {
            contractAddress: contractConfig.address,
            cursor: record.cursor,
            ledgerNumber: record.ledgerNumber,
          });
        }
      } catch (error) {
        logger.warn('Failed to restore checkpoint for contract; starting from beginning', {
          contractAddress: contractConfig.address,
          error,
        });
      }
    }

    logger.info('Checkpoint restore complete', {
      contractsConfigured: this.config.contractAddresses.length,
      contractsRestored: restored,
    });
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      const requestId = generateRequestId();
      const pollStart = Date.now();

      try {
        await this.checkForEvents(requestId);
        this.reconnectAttempts = 0;
        this.lastSuccessfulPollAt = Date.now();

        const durationMs = Date.now() - pollStart;
        pollingMetrics.record(durationMs, true);

        logger.info('Poll cycle complete', {
          requestId,
          durationMs,
        });

        await this.delay(this.config.pollIntervalMs);
      } catch (error) {
        const durationMs = Date.now() - pollStart;
        pollingMetrics.record(durationMs, false);

        logger.error('Error polling for events', {
          requestId,
          error,
          durationMs,
        });
        await this.handleReconnection(requestId);
      }
    }
  }

  private async checkForEvents(requestId: string = generateRequestId()): Promise<void> {
    const totalContracts = this.config.contractAddresses.length;
    let failureCount = 0;

    for (const contractConfig of this.config.contractAddresses) {
      try {
        const retrievalTimer = new StageTimer();
        retrievalTimer.start('retrieval');
        const response = await this.getContractEvents(contractConfig);
        retrievalTimer.end('retrieval');
        const retrievalMs = retrievalTimer.snapshot().retrieval;

        const responseValidation = validateRpcResponse(response);
        if (!responseValidation.valid) {
          logger.error('Rejecting invalid RPC response, skipping contract', {
            requestId,
            contractAddress: contractConfig.address,
            reason: responseValidation.reason,
          });
          continue;
        }

        const events = response.events || [];

        // Detect potential reorg if events exist and we have previous state
        if (this.deduplicationService && events.length > 0) {
          const firstEventLedger = events[0]?.ledger;
          if (firstEventLedger) {
            const reorgDetected = await this.deduplicationService.detectReorg(
              contractConfig.address,
              firstEventLedger,
            );
            if (reorgDetected) {
              logger.warn('Potential blockchain reorg detected', {
                requestId,
                contractAddress: contractConfig.address,
                eventLedger: firstEventLedger,
              });
            }
          }
        }

        const processableEvents: Array<{
          event: StellarSDK.rpc.Api.EventResponse;
          correlationId: string;
        }> = [];
        for (const [eventIndex, event] of events.entries()) {
          const correlationId = generateCorrelationId();
          if (this.quarantine.isBlocked(event?.id, contractConfig.address)) {
            logger.warn('Skipping quarantined event', {
              requestId,
              correlationId,
              contractAddress: contractConfig.address,
              eventId: event?.id,
            });
            continue;
          }
          try {
            const validationTimer = new StageTimer();
            validationTimer.start('decodeValidation');
            const shouldProcess = this.shouldProcessEvent(
              event,
              contractConfig,
              requestId,
              correlationId,
            );
            validationTimer.end('decodeValidation');
            if (shouldProcess) {
              if (event && typeof event === 'object') {
                this.preProcessTimings.set(event, {
                  retrievalMs,
                  validationMs: validationTimer.snapshot().decodeValidation,
                });
              }
              processableEvents.push({ event, correlationId });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.quarantine.recordMalformed({
              eventId: typeof event?.id === 'string' ? event.id : '',
              contractAddress: contractConfig.address,
              ledger: typeof event?.ledger === 'number' ? event.ledger : null,
              reason: message,
              category: 'malformed_payload',
            });
            logger.warn('Skipping malformed event', {
              requestId,
              correlationId,
              contractAddress: contractConfig.address,
              eventIndex,
              eventId: event?.id,
              eventType: event?.type,
              error: message,
            });
          }
        }

        if (events.length > 0) {
          logger.info('Received events', {
            requestId,
            contractAddress: contractConfig.address,
            count: events.length,
            processed: processableEvents.length,
          });
        }

        for (const [eventIndex, processableEvent] of processableEvents.entries()) {
          const { event, correlationId } = processableEvent;
          try {
            if (this.eventQueue) {
              this.eventQueue.enqueue(event, contractConfig, correlationId);
            } else {
              await this.processEvent(event, contractConfig, correlationId);
            }
          } catch (error) {
            logger.warn('Event processing failed; continuing batch', {
              requestId,
              correlationId,
              contractAddress: contractConfig.address,
              eventIndex,
              eventId: event?.id,
              eventType: event?.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (response.cursor) {
          this.lastCursors.set(contractConfig.address, response.cursor);

          // Update cursor in deduplication service if available
          if (this.deduplicationService) {
            const lastEventLedger = events.length > 0 ? events[events.length - 1].ledger : 0;
            await this.deduplicationService.updatePollingCursor(
              contractConfig.address,
              response.cursor,
              lastEventLedger || 0,
            );
          }
        }
      } catch (error) {
        failureCount++;
        logger.error('Error fetching events for contract', {
          requestId,
          contractAddress: contractConfig.address,
          error,
        });
      }
    }

    if (totalContracts > 0 && failureCount === totalContracts) {
      throw new Error(`Failed to fetch events for all ${totalContracts} configured contract(s)`);
    }
  }

  private shouldProcessEvent(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId: string = '',
    correlationId: string = requestId,
  ): boolean {
    // Check if event has expired
    const eventName = getEventName(event.topic);
    if (
      this.expirationService &&
      !this.expirationService.shouldProcess(event, eventName || undefined)
    ) {
      logger.warn('Skipping expired notification', {
        requestId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        eventName,
        currentTime: Date.now(),
        reason: 'expired',
      });
      return false;
    }

    const validation = validateEventPayload(event);
    if (!validation.valid) {
      this.quarantine.recordMalformed({
        eventId: typeof event.id === 'string' ? event.id : '',
        contractAddress: contractConfig.address,
        ledger: typeof event.ledger === 'number' ? event.ledger : null,
        reason: validation.reason ?? 'invalid event payload',
        category: validation.error?.category ?? 'malformed_payload',
      });
      logger.warn('Skipping invalid event payload', {
        requestId,
        correlationId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        reason: validation.reason,
      });
      return false;
    }

    if (!matchesEventFilter(eventName, contractConfig.events)) {
      return false;
    }

    return true;
  }

  /**
   * Resolve the ledger to start from on a cold start (no stored cursor).
   *
   * When `backfill.maxLedgers` is 0 the limit is disabled and we start from
   * ledger 1 (original behaviour).  Otherwise we fetch the current network
   * tip and compute `max(1, tip - maxLedgers)`.  The result is cached for
   * the lifetime of this subscriber instance so all contracts share a
   * consistent baseline and the RPC is only called once.
   *
   * If the tip cannot be fetched (RPC error) we fall back to ledger 1 and
   * log a warning so real-time processing is never blocked.
   */
  private async resolveBackfillStartLedger(): Promise<number> {
    const maxLedgers = this.config.backfill?.maxLedgers ?? 10_000;

    // 0 means unlimited — behave exactly as before.
    if (maxLedgers === 0) {
      return 1;
    }

    // Return the cached value if already resolved for this session.
    if (this.backfillStartLedger !== null) {
      return this.backfillStartLedger;
    }

    try {
      const latest: any = await this.rpcManager.executeWithFallback(
        (server) => (server as any).getLatestLedger(),
        { operationName: 'getLatestLedger' },
      );
      const tip: number | null =
        typeof latest?.sequence === 'number'
          ? latest.sequence
          : typeof latest?.ledger === 'number'
            ? latest.ledger
            : typeof latest?.latestLedger === 'number'
              ? latest.latestLedger
              : null;

      if (tip !== null) {
        const startLedger = Math.max(1, tip - maxLedgers);

        // Validate that the computed start ledger is a positive integer within
        // the valid ledger range before caching.  The range-width cap that
        // applies to external HTTP callers is NOT enforced here because the
        // internal backfill limit is already governed by `maxLedgers`.
        const rangeCheck = safeLedgerRangeValidation(startLedger, tip);
        if (!rangeCheck.valid && startLedger > 1) {
          // Only fall back when the start ledger itself is invalid (e.g. it
          // somehow ended up <= 0 or > MAX_LEDGER_VALUE).  A range-too-large
          // result is expected for long bacfills and is intentionally ignored.
          const isRangeSizeError = rangeCheck.issues?.every((i) => i.field === 'endLedger');
          if (!isRangeSizeError) {
            logger.warn('Backfill start ledger failed range validation; falling back to ledger 1', {
              startLedger,
              networkTipLedger: tip,
              reason: rangeCheck.reason,
            });
            this.backfillStartLedger = 1;
            return 1;
          }
        }

        this.backfillStartLedger = startLedger;

        logger.warn('Backfill safety limit applied: starting historical replay from ledger', {
          networkTipLedger: tip,
          backfillMaxLedgers: maxLedgers,
          startLedger,
          skippedLedgers: Math.max(0, startLedger - 1),
        });

        return startLedger;
      }
    } catch (err) {
      logger.warn('Failed to fetch network tip for backfill limit; falling back to ledger 1', {
        error: err instanceof Error ? err.message : String(err),
        backfillMaxLedgers: maxLedgers,
      });
    }

    // Fallback: start from genesis so no events are silently skipped.
    return 1;
  }

  private async getContractEvents(
    contractConfig: ContractConfig,
  ): Promise<StellarSDK.rpc.Api.GetEventsResponse> {
    if (this.rpcRateLimiter) {
      await this.rpcRateLimiter.acquire();
    }

    const lastCursor = this.lastCursors.get(contractConfig.address);
    let request: StellarSDK.rpc.Api.GetEventsRequest;

    if (lastCursor) {
      request = {
        filters: [{ contractIds: [contractConfig.address], type: 'contract' }],
        cursor: lastCursor,
        limit: this.config.eventBatchSize,
      };
    } else {
      const startLedger = await this.resolveBackfillStartLedger();
      request = {
        filters: [{ contractIds: [contractConfig.address], type: 'contract' }],
        startLedger,
        limit: this.config.eventBatchSize,
      };
    }

    return this.rpcManager.executeWithFallback((server) => server.getEvents(request), {
      operationName: 'getEvents',
    });
  }

  /**
   * Processes one event and records its per-stage latency breakdown
   * (issue #1120). The record is written in `finally`, so it is produced for
   * every outcome; recording itself can never fail the event.
   */
  private async processEvent(
    event: RpcEvent,
    contractConfig: ContractConfig,
    requestId: string = '',
    correlationId: string = '',
  ): Promise<boolean> {
    const timer = new StageTimer();
    const pre = event && typeof event === 'object' ? this.preProcessTimings.get(event) : undefined;
    timer.add('retrieval', pre?.retrievalMs);
    timer.add('decodeValidation', pre?.validationMs);
    const outcome: { value: EventLatencyRecord['outcome'] } = { value: 'error' };

    try {
      return await this.runEventStages(
        event,
        contractConfig,
        requestId,
        correlationId,
        timer,
        outcome,
      );
    } finally {
      try {
        const record = eventLatencyStore.record({
          eventId: event?.id,
          contractAddress: contractConfig?.address,
          outcome: outcome.value,
          stages: timer.snapshot(),
        });
        // Associate the breakdown with the persisted processed_events row.
        // recordStageTimings never rejects and is a no-op without a row.
        if (this.deduplicationService && this.config.dryRun !== true && record.eventId) {
          void this.deduplicationService.recordStageTimings(record.eventId, record.contractAddress, {
            retrievalMs: record.stages.retrieval,
            decodeValidationMs: record.stages.decodeValidation,
            persistenceMs: record.stages.persistence,
            notificationPrepMs: record.stages.notificationPrep,
            totalMs: record.totalMs,
            outcome: record.outcome,
          });
        }
      } catch {
        // Diagnostics are best-effort and must never interrupt processing.
      }
      if (event && typeof event === 'object') this.preProcessTimings.delete(event);
    }
  }

  private async runEventStages(
    event: RpcEvent,
    contractConfig: ContractConfig,
    requestId: string,
    correlationId: string,
    timer: StageTimer,
    outcome: { value: EventLatencyRecord['outcome'] },
  ): Promise<boolean> {
    correlationId = correlationId || requestId || generateCorrelationId();
    const eventStart = Date.now();
    timer.start('decodeValidation');
    const normalized = normalizeSorobanEvent(event, {
      contractAddress: contractConfig.address,
    });
    if (!normalized.ok) {
      timer.end('decodeValidation');
      outcome.value = 'skipped';
      logger.warn('Skipping event that failed normalization', {
        requestId: correlationId,
        correlationId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        errors: normalized.errors.map((error) => error.detail),
      });
      return false;
    }
    const eventName = normalized.event.eventName;

    // Event schema versioning (issue #1122): a version this listener does not
    // understand is skipped rather than mis-decoded. It is not claimed in the
    // deduplication store, so a re-scan after upgrading the listener still
    // processes it. Returning true stops pointless retries of the same event.
    if (!isSupportedEventSchemaVersion(normalized.event.eventSchemaVersion)) {
      timer.end('decodeValidation');
      outcome.value = 'skipped';
      logger.warn('Skipping event with unsupported event schema version', {
        requestId: correlationId,
        correlationId,
        contractAddress: contractConfig.address,
        eventId: event.id,
        eventName,
        baseEventName: normalized.event.baseEventName,
        eventSchemaVersion: normalized.event.eventSchemaVersion,
      });
      return true;
    }

    const provenance = validateEventProvenance({
      network: this.config.stellarNetwork,
      contract: normalized.event.contractAddress,
      ledger: normalized.event.ledger,
      ingestionPath: this.lastCursors.has(contractConfig.address) ? 'rpc-poll' : 'backfill',
    });
    if (provenance.ok) {
      logger.info('Event provenance', {
        requestId: correlationId,
        correlationId,
        eventId: normalized.event.eventId,
        ...provenanceDiagnostic(provenance.provenance),
      });
    }
    timer.end('decodeValidation');
    const isDryRun = this.config.dryRun === true;

    // Persistence stage, part 1: deduplication lookup + registry write.
    timer.start('persistence');

    // Check persistent deduplication first (to catch reorg duplicates)
    if (this.deduplicationService && !isDryRun) {
      const duplicate = await this.deduplicationService.isDuplicate(
        event.id,
        contractConfig.address,
      );
      if (duplicate.isDuplicate) {
        logger.warn('Skipping event: already processed (persistent deduplication)', {
          requestId: correlationId,
          correlationId,
          eventId: event.id,
          contractAddress: contractConfig.address,
        });

        // Count the redetection without overwriting the original outcome.
        await this.deduplicationService.recordRedetection(
          event.id,
          contractConfig.address,
          event.ledger,
        );

        timer.end('persistence');
        outcome.value = 'duplicate';
        return true;
      }
    }

    // Enrich the event with blockchain transaction metadata. The resolver is
    // best-effort: a failed/timed-out lookup degrades the metadata status but
    // never blocks processing of the (still valid) event.
    const txMetadata = await this.transactionMetadataResolver.resolve(event);
    if (txMetadata.metadataStatus !== 'complete') {
      logger.warn('Processed event carries incomplete transaction metadata', {
        requestId: correlationId,
        correlationId,
        eventId: event.id,
        contractAddress: contractConfig.address,
        metadataStatus: txMetadata.metadataStatus,
        missingFields: txMetadata.missingFields,
        reason: txMetadata.reason,
      });
    }

    const displayEvent = eventRegistry.addFromInput({
      eventId: event.id,
      contractAddress: contractConfig.address,
      eventName,
      ledger: event.ledger,
      type: event.type,
      topic: event.topic,
      value: event.value,
      txHash: event.txHash,
      txMetadata,
    });
    timer.end('persistence');

    logger.info('Processing event', {
      requestId: correlationId,
      correlationId,
      contractAddress: displayEvent.contractAddress,
      eventId: displayEvent.eventId,
      eventName: displayEvent.eventName,
      ledger: displayEvent.ledger,
      type: displayEvent.type,
      topic: displayEvent.topic,
      value: displayEvent.value,
      dryRun: isDryRun,
    });

    let notificationSent = false;
    let processingError: string | undefined;

    // Notification preparation: preference checks, building/sending the
    // notification and the retry-queue hand-off.
    timer.start('notificationPrep');
    if (this.discordService && !isDryRun) {
      const userId = contractConfig.userId ?? 'global';
      if (!preferenceStore.isCategoryEnabled(userId, 'discord')) {
        logger.info('Skipping Discord notification: category disabled by user preferences', {
          eventId: event.id,
          userId,
          correlationId,
        });
      } else {
        try {
          const success = await this.discordService.sendEventNotification(
            event,
            contractConfig,
            requestId,
          );
          notificationSent = success;

          if (!success && this.retryQueue) {
            logger.warn('Discord notification failed, adding to retry queue', {
              requestId: correlationId,
              correlationId,
              eventId: event.id,
            });
            this.retryQueue.enqueue(event, contractConfig, requestId);
            processingError = 'Initial notification send failed, queued for retry';
          }
        } catch (error) {
          processingError = error instanceof Error ? error.message : String(error);
          logger.error('Error sending Discord notification', {
            requestId: correlationId,
            correlationId,
            eventId: event.id,
            error: processingError,
          });
        }
      }
    }

    timer.end('notificationPrep');
    outcome.value = processingError ? 'error' : 'processed';

    // Persistence stage, part 2: finalise the claim with the outcome.
    if (this.deduplicationService) {
      timer.start('persistence');
      await this.deduplicationService.completeEvent(
        event.id,
        contractConfig.address,
        event.ledger,
        event.txHash,
        event.type,
        notificationSent,
        processingError ? 'ERROR' : 'PROCESSED',
        processingError,
        txMetadata,
      );
      timer.end('persistence');
    }

    logger.info('Event processing complete', {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      notificationSent,
      outcome: isDryRun
        ? 'dry_run'
        : !this.discordService || notificationSent
          ? 'success'
          : 'failure',
      durationMs: Date.now() - eventStart,
    });

    if (isDryRun) {
      logger.info('Dry-run: event validated successfully (no persistence or delivery)', {
        requestId: correlationId,
        correlationId,
        eventId: event.id,
        eventName,
        contractAddress: contractConfig.address,
      });
      return true;
    }

    if (!this.discordService) return true;
    if (notificationSent) return true;
    if (processingError && this.retryQueue) return true;
    return false;
  }

  private async handleReconnection(requestId?: string): Promise<void> {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('Max reconnection attempts exceeded, stopping service');
      this.stop();
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * this.reconnectAttempts;
    logger.warn('Attempting to reconnect', {
      requestId,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    await this.delay(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getQueueMetrics() {
    return {
      eventQueue: this.eventQueue?.getMetrics() || null,
      retryQueue: this.retryQueue?.getMetrics() || null,
    };
  }

  getLastSuccessfulPoll(): number | null {
    return this.lastSuccessfulPollAt;
  }

  getCircuitBreakerMetrics() {
    return null;
  }
}
