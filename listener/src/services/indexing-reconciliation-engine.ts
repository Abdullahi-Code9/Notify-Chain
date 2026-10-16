import * as StellarSDK from '@stellar/stellar-sdk';
import type { Database } from '../database/database';
import logger from '../utils/logger';
import {
  detectIndexingGaps,
  type ChainEventRef,
  type IndexedEventRef,
  type GapDetectionResult,
} from './indexing-gap-detector';
import { sanitizeForDiscord } from './discord-notification';

export interface GapAlertSink {
  notify(result: {
    contractAddress: string;
    window: { startLedger: number; endLedger: number };
    gaps: GapDetectionResult;
  }): Promise<void>;
}

export class LoggerAlertSink implements GapAlertSink {
  async notify(result: {
    contractAddress: string;
    window: { startLedger: number; endLedger: number };
    gaps: GapDetectionResult;
  }): Promise<void> {
    logger.error('Indexing gap alert triggered', {
      contractAddress: result.contractAddress,
      window: result.window,
      missingEvents: result.gaps.missingEvents.length,
      missingLedgers: result.gaps.missingLedgers.length,
    });
  }
}

export class DiscordWebhookAlertSink implements GapAlertSink {
  constructor(private webhookUrl: string) {}

  async notify(result: {
    contractAddress: string;
    window: { startLedger: number; endLedger: number };
    gaps: GapDetectionResult;
  }): Promise<void> {
    const missingCount = result.gaps.missingEvents.length;
    const sample = result.gaps.missingEvents.slice(0, 3);
    const sampleLines = sample
      .map((e) => {
        const evId = sanitizeForDiscord(e.eventId);
        const tx = e.txHash ? ` tx ${sanitizeForDiscord(e.txHash)}` : '';
        return `• ledger ${e.ledger} event ${evId}${tx}`;
      })
      .join('\n');

    const content =
      `🚨 Indexing gap detected\n` +
      `Contract: ${sanitizeForDiscord(result.contractAddress)}\n` +
      `Window: ${result.window.startLedger}..${result.window.endLedger}\n` +
      `Missing events: ${missingCount}\n` +
      (sampleLines ? `Sample:\n${sampleLines}` : '');

    // Keep it lightweight: a single webhook POST, no embeds required.
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  }
}

export interface IndexingReconciliationEngineOptions {
  db: Database;
  rpcUrl: string;
  contractAddresses: string[];
  /**
   * How far back from the network tip to validate.
   * Kept small to avoid stressing the RPC + DB.
   */
  lookbackLedgers?: number;
  /** Maximum RPC pages per contract per run. */
  maxPages?: number;
  /** Maximum on-chain events to process per contract per run. */
  maxOnChainEvents?: number;
  /** How often to run the reconciliation loop (ms). */
  intervalMs?: number;
  alertSink?: GapAlertSink;
  /**
   * Dependency injection for tests / alternate runtimes.
   * When omitted, the engine will use RPC + SQLite directly.
   */
  getNetworkTipLedger?: (rpcUrl: string) => Promise<number | null>;
  fetchOnChainEvents?: (args: {
    rpcUrl: string;
    contractAddress: string;
    startLedger: number;
    maxPages: number;
    maxEvents: number;
  }) => Promise<ChainEventRef[]>;
  fetchIndexedEvents?: (args: {
    db: Database;
    contractAddress: string;
    startLedger: number;
    endLedger: number;
  }) => Promise<IndexedEventRef[]>;
}

async function getNetworkTipLedger(rpcUrl: string): Promise<number | null> {
  try {
    const server = new StellarSDK.rpc.Server(rpcUrl);
    const latest: any = await (server as any).getLatestLedger();
    const ledger =
      typeof latest?.sequence === 'number'
        ? latest.sequence
        : typeof latest?.ledger === 'number'
          ? latest.ledger
          : typeof latest?.latestLedger === 'number'
            ? latest.latestLedger
            : null;
    return ledger;
  } catch (error) {
    logger.warn('Failed to fetch network tip ledger for reconciliation', {
      rpcUrl,
      error,
    });
    return null;
  }
}

async function fetchOnChainEvents(args: {
  rpcUrl: string;
  contractAddress: string;
  startLedger: number;
  maxPages: number;
  maxEvents: number;
}): Promise<ChainEventRef[]> {
  const server = new StellarSDK.rpc.Server(args.rpcUrl);
  const events: ChainEventRef[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < args.maxPages; page++) {
    const request: StellarSDK.rpc.Api.GetEventsRequest = cursor
      ? {
          filters: [{ contractIds: [args.contractAddress], type: 'contract' }],
          cursor,
          limit: 200,
        }
      : {
          filters: [{ contractIds: [args.contractAddress], type: 'contract' }],
          startLedger: args.startLedger,
          limit: 200,
        };

    const response = await server.getEvents(request);
    const batch = response.events ?? [];

    for (const ev of batch) {
      events.push({
        contractAddress: args.contractAddress,
        eventId: ev.id,
        ledger: ev.ledger,
        txHash: ev.txHash,
      });
      if (events.length >= args.maxEvents) {
        return events;
      }
    }

    if (!response.cursor || batch.length === 0) {
      return events;
    }

    cursor = response.cursor;
  }

  return events;
}

async function fetchIndexedEvents(args: {
  db: Database;
  contractAddress: string;
  startLedger: number;
  endLedger: number;
}): Promise<IndexedEventRef[]> {
  type Row = { eventId: string; contractAddress: string; ledger: number; txHash: string | null };
  const rows = await args.db.all<Row>(
    `
    SELECT
      event_id as eventId,
      contract_address as contractAddress,
      ledger_number as ledger,
      tx_hash as txHash
    FROM processed_events
    WHERE contract_address = ?
      AND ledger_number >= ?
      AND ledger_number <= ?
    `,
    [args.contractAddress, args.startLedger, args.endLedger]
  );

  return rows.map((row) => ({
    contractAddress: row.contractAddress,
    eventId: row.eventId,
    ledger: row.ledger,
    txHash: row.txHash ?? undefined,
  }));
}

export class IndexingReconciliationEngine {
  private readonly db: Database;
  private readonly rpcUrl: string;
  private readonly contractAddresses: string[];
  private readonly lookbackLedgers: number;
  private readonly maxPages: number;
  private readonly maxOnChainEvents: number;
  private readonly intervalMs: number;
  private readonly alertSink: GapAlertSink;
  private readonly tipSource: (rpcUrl: string) => Promise<number | null>;
  private readonly onChainSource: (args: {
    rpcUrl: string;
    contractAddress: string;
    startLedger: number;
    maxPages: number;
    maxEvents: number;
  }) => Promise<ChainEventRef[]>;
  private readonly indexedSource: (args: {
    db: Database;
    contractAddress: string;
    startLedger: number;
    endLedger: number;
  }) => Promise<IndexedEventRef[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(options: IndexingReconciliationEngineOptions) {
    this.db = options.db;
    this.rpcUrl = options.rpcUrl;
    this.contractAddresses = options.contractAddresses;
    this.lookbackLedgers = options.lookbackLedgers ?? 250;
    this.maxPages = options.maxPages ?? 3;
    this.maxOnChainEvents = options.maxOnChainEvents ?? 1500;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.alertSink = options.alertSink ?? new LoggerAlertSink();
    this.tipSource = options.getNetworkTipLedger ?? getNetworkTipLedger;
    this.onChainSource = options.fetchOnChainEvents ?? fetchOnChainEvents;
    this.indexedSource = options.fetchIndexedEvents ?? fetchIndexedEvents;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    logger.info('Indexing reconciliation engine started', {
      intervalMs: this.intervalMs,
      lookbackLedgers: this.lookbackLedgers,
      contracts: this.contractAddresses.length,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    const startedAt = Date.now();

    try {
      const tip = await this.tipSource(this.rpcUrl);
      if (tip === null) {
        logger.warn('Skipping reconciliation run: network tip unavailable');
        return;
      }

      const startLedger = Math.max(1, tip - this.lookbackLedgers);
      const endLedger = tip;

      logger.info('Indexing reconciliation run started', {
        window: { startLedger, endLedger },
        contracts: this.contractAddresses.length,
      });

      for (const contractAddress of this.contractAddresses) {
        await this.checkContract(contractAddress, startLedger, endLedger);
      }

      logger.info('Indexing reconciliation run complete', {
        durationMs: Date.now() - startedAt,
        contracts: this.contractAddresses.length,
        window: { startLedger, endLedger },
      });
    } catch (error) {
      logger.error('Indexing reconciliation run failed', {
        error,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async checkContract(
    contractAddress: string,
    startLedger: number,
    endLedger: number
  ): Promise<void> {
    const onChain = await this.onChainSource({
      rpcUrl: this.rpcUrl,
      contractAddress,
      startLedger,
      maxPages: this.maxPages,
      maxEvents: this.maxOnChainEvents,
    });
    const indexed = await this.indexedSource({
      db: this.db,
      contractAddress,
      startLedger,
      endLedger,
    });

    const gaps = detectIndexingGaps(onChain, indexed);

    if (onChain.length > 0 || indexed.length > 0) {
      logger.info('Reconciliation contract progress', {
        contractAddress,
        window: { startLedger, endLedger },
        onChainCount: onChain.length,
        indexedCount: indexed.length,
        missingEvents: gaps.missingEvents.length,
      });
    }

    if (gaps.missingEvents.length === 0) {
      return;
    }

    logger.error('Indexing gap detected', {
      contractAddress,
      window: { startLedger, endLedger },
      checkedOnChain: gaps.checkedOnChain,
      checkedIndexed: gaps.checkedIndexed,
      missingEvents: gaps.missingEvents.length,
      missingLedgers: gaps.missingLedgers,
      sampleMissing: gaps.missingEvents.slice(0, 5),
    });

    await this.alertSink.notify({
      contractAddress,
      window: { startLedger, endLedger },
      gaps,
    });
  }
}

export function createDefaultAlertSink(discordWebhookUrl?: string): GapAlertSink {
  if (discordWebhookUrl) {
    return new DiscordWebhookAlertSink(discordWebhookUrl);
  }
  return new LoggerAlertSink();
}
