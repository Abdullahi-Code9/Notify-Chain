#!/usr/bin/env ts-node
/**
 * Checkpoint Gap Diagnostic
 *
 * Compares stored ingestion checkpoints (polling_cursors + processed_events)
 * against live ledger information from the Stellar RPC to surface potential
 * ingestion gaps for maintainer investigation.
 *
 * READ-ONLY — this command never modifies stored checkpoints or any other
 * database state.
 *
 * Usage:
 *   npm run diagnose:checkpoints
 *   ts-node src/scripts/diagnose-checkpoints.ts
 *
 * Optional env overrides (on top of the normal .env):
 *   STELLAR_RPC_URL      Override the RPC endpoint used for ledger queries
 *   DATABASE_PATH        Override the database file path
 *   GAP_THRESHOLD        Minimum ledger-range size to report as a suspected gap
 *                        (default: 100)
 */

import * as dotenv from 'dotenv';
import { Database } from '../database/database';

dotenv.config();

// ─── Types ────────────────────────────────────────────────────────────────────

interface CursorRow {
  contract_address: string;
  cursor: string;
  ledger_number: number;
  reorg_detected: number;
  reorg_detection_count: number;
  updated_at: string;
}

interface LedgerSpan {
  minLedger: number;
  maxLedger: number;
  eventCount: number;
}

interface SuspectedGap {
  contractAddress: string;
  fromLedger: number;
  toLedger: number;
  spanSize: number;
  description: string;
}

interface ContractReport {
  contractAddress: string;
  checkpointLedger: number | null;
  checkpointCursor: string | null;
  checkpointUpdatedAt: string | null;
  reorgDetected: boolean;
  reorgDetectionCount: number;
  processedEventSpan: LedgerSpan | null;
  suspectedGaps: SuspectedGap[];
  warnings: string[];
}

interface DiagnosticReport {
  generatedAt: string;
  databasePath: string;
  rpcUrl: string;
  networkTipLedger: number | null;
  networkTipFetchError: string | null;
  comparisonRangeLow: number;
  comparisonRangeHigh: number | null;
  gapThreshold: number;
  contracts: ContractReport[];
  globalSuspectedGaps: SuspectedGap[];
  limitations: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveNetworkTip(latest: unknown): number | null {
  if (latest === null || typeof latest !== 'object') return null;
  const l = latest as Record<string, unknown>;
  if (typeof l['sequence'] === 'number') return l['sequence'];
  if (typeof l['ledger'] === 'number') return l['ledger'];
  if (typeof l['latestLedger'] === 'number') return l['latestLedger'];
  return null;
}

function formatLedger(n: number | null): string {
  return n === null ? 'unknown' : n.toLocaleString();
}

// ─── Per-contract analysis ────────────────────────────────────────────────────

async function analyseContract(
  db: Database,
  contractAddress: string,
  networkTip: number | null,
  gapThreshold: number,
): Promise<ContractReport> {
  const report: ContractReport = {
    contractAddress,
    checkpointLedger: null,
    checkpointCursor: null,
    checkpointUpdatedAt: null,
    reorgDetected: false,
    reorgDetectionCount: 0,
    processedEventSpan: null,
    suspectedGaps: [],
    warnings: [],
  };

  // 1. Load polling cursor (ingestion checkpoint)
  const cursorRows = await db.all<CursorRow>(
    `SELECT contract_address, cursor, ledger_number,
            reorg_detected, reorg_detection_count, updated_at
     FROM polling_cursors
     WHERE contract_address = ?
     LIMIT 1`,
    [contractAddress],
  );

  if (cursorRows.length === 0) {
    report.warnings.push(
      'No polling cursor found — ingestion has never completed a successful poll for this contract.',
    );
  } else {
    const row = cursorRows[0];
    report.checkpointLedger = row.ledger_number;
    report.checkpointCursor = row.cursor;
    report.checkpointUpdatedAt = row.updated_at;
    report.reorgDetected = row.reorg_detected === 1;
    report.reorgDetectionCount = row.reorg_detection_count ?? 0;

    if (row.reorg_detected === 1) {
      report.warnings.push(
        `Reorg flag is SET (reorg_detection_count=${row.reorg_detection_count}). ` +
          'The checkpoint may point to a superseded chain tip — verify against node history.',
      );
    }
  }

  // 2. Load processed-event ledger span for this contract
  const spanRow = await db.get<{ min_ledger: number | null; max_ledger: number | null; event_count: number }>(
    `SELECT MIN(ledger_number) AS min_ledger,
            MAX(ledger_number) AS max_ledger,
            COUNT(*)           AS event_count
     FROM processed_events
     WHERE contract_address = ?`,
    [contractAddress],
  );

  if (spanRow && spanRow.min_ledger !== null && spanRow.max_ledger !== null) {
    report.processedEventSpan = {
      minLedger: spanRow.min_ledger,
      maxLedger: spanRow.max_ledger,
      eventCount: spanRow.event_count,
    };
  } else {
    report.warnings.push(
      'No processed events found for this contract — either ingestion has not started or all records have been pruned by the cleanup service.',
    );
  }

  // 3. Gap analysis

  // Gap A — Checkpoint is behind the network tip
  if (networkTip !== null && report.checkpointLedger !== null) {
    const lag = networkTip - report.checkpointLedger;
    if (lag > gapThreshold) {
      report.suspectedGaps.push({
        contractAddress,
        fromLedger: report.checkpointLedger + 1,
        toLedger: networkTip,
        spanSize: lag,
        description:
          `Checkpoint ledger (${formatLedger(report.checkpointLedger)}) is ` +
          `${lag.toLocaleString()} ledger(s) behind the network tip ` +
          `(${formatLedger(networkTip)}). ` +
          'This may indicate the listener is lagging or has stopped.',
      });
    }
  }

  // Gap B — Processed-event max ledger is behind the checkpoint
  if (
    report.processedEventSpan !== null &&
    report.checkpointLedger !== null
  ) {
    const lag = report.checkpointLedger - report.processedEventSpan.maxLedger;
    if (lag > gapThreshold) {
      report.suspectedGaps.push({
        contractAddress,
        fromLedger: report.processedEventSpan.maxLedger + 1,
        toLedger: report.checkpointLedger,
        spanSize: lag,
        description:
          `The highest ledger in processed_events ` +
          `(${formatLedger(report.processedEventSpan.maxLedger)}) is ` +
          `${lag.toLocaleString()} ledger(s) behind the stored checkpoint ` +
          `(${formatLedger(report.checkpointLedger)}). ` +
          'Possible cause: events were polled but deduplication skipped recording them, or records were pruned.',
      });
    }
  }

  // Gap C — No events exist even though a checkpoint is stored
  if (report.processedEventSpan === null && report.checkpointLedger !== null) {
    report.warnings.push(
      'A checkpoint exists but no processed events are recorded. ' +
        'This is normal when the contract emits no events in its history, ' +
        'or all records were pruned beyond the retention window.',
    );
  }

  // Gap D — Sparse-event internal gap detection (checks for ledger-range holes)
  if (report.processedEventSpan !== null && report.processedEventSpan.eventCount > 1) {
    // Approximate: if the event count is much lower than the ledger span, flag it
    const ledgerSpan = report.processedEventSpan.maxLedger - report.processedEventSpan.minLedger;
    if (ledgerSpan > gapThreshold && report.processedEventSpan.eventCount < ledgerSpan * 0.001) {
      report.warnings.push(
        `Low event density: ${report.processedEventSpan.eventCount} events across ` +
          `${ledgerSpan.toLocaleString()} ledgers. This may be expected for a low-activity ` +
          'contract, but could also indicate missed events.',
      );
    }
  }

  return report;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function diagnose(): Promise<void> {
  const dbPath = process.env.DATABASE_PATH ?? './data/notifications.db';
  const rpcUrl =
    process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org:443';
  const gapThreshold = parseInt(process.env.GAP_THRESHOLD ?? '100', 10);

  // ── Connect to the database (read-only intent, but SQLite doesn't have a
  //    read-only open mode in this driver, so we simply make no write calls).
  const db = new Database(dbPath);
  await db.initialize();

  // ── Fetch live ledger tip from the Stellar RPC
  let networkTip: number | null = null;
  let networkTipFetchError: string | null = null;
  try {
    // Dynamic import so the script degrades gracefully if the SDK is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const StellarSDK = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
    const server = new StellarSDK.rpc.Server(rpcUrl);
    const latest = await (server as any).getLatestLedger();
    networkTip = resolveNetworkTip(latest);
    if (networkTip === null) {
      networkTipFetchError =
        'RPC responded but the ledger sequence field was not recognised. ' +
        `Response keys: ${Object.keys(latest ?? {}).join(', ')}`;
    }
  } catch (err) {
    networkTipFetchError =
      `Failed to reach RPC endpoint (${rpcUrl}): ` +
      (err instanceof Error ? err.message : String(err));
  }

  // ── Discover all contracts tracked in polling_cursors
  const allCursorRows = await db.all<{ contract_address: string }>(
    `SELECT DISTINCT contract_address FROM polling_cursors ORDER BY contract_address`,
  );

  // Also include contracts that have processed events but no cursor (partial state)
  const allEventRows = await db.all<{ contract_address: string }>(
    `SELECT DISTINCT contract_address FROM processed_events ORDER BY contract_address`,
  );

  const contractSet = new Set<string>([
    ...allCursorRows.map((r) => r.contract_address),
    ...allEventRows.map((r) => r.contract_address),
  ]);

  const contractAddresses = Array.from(contractSet);

  // ── Per-contract analysis
  const contractReports: ContractReport[] = [];
  for (const addr of contractAddresses) {
    const report = await analyseContract(db, addr, networkTip, gapThreshold);
    contractReports.push(report);
  }

  await db.close();

  // ── Determine comparison range
  const allCheckpoints = contractReports
    .map((r) => r.checkpointLedger)
    .filter((n): n is number => n !== null);

  const comparisonRangeLow =
    allCheckpoints.length > 0 ? Math.min(...allCheckpoints) : 0;

  const comparisonRangeHigh = networkTip;

  // ── Collect all suspected gaps
  const globalSuspectedGaps: SuspectedGap[] = contractReports.flatMap(
    (r) => r.suspectedGaps,
  );

  // ── Limitations
  const limitations: string[] = [
    'This command queries a SQLite snapshot; it does not replay ledger history from the Stellar RPC.',
    'Gaps are inferred from stored ledger numbers — they do not prove that specific events were missed.',
    'The processed_events table may have been partially pruned by the cleanup service; older records may not be present.',
    'Ledger density analysis uses an approximate heuristic and is not a substitute for a full event replay.',
    'Reorg detection is based on the flag stored at last-poll time; a reorg that resolved before the next poll will not appear here.',
    networkTip === null
      ? `Network tip could not be fetched (${networkTipFetchError ?? 'unknown error'}) — gap-vs-tip analysis is unavailable.`
      : `Network tip was fetched at report generation time (ledger ${formatLedger(networkTip)}) and may advance before any remediation is applied.`,
  ];

  // ── Build final report object
  const diagnosticReport: DiagnosticReport = {
    generatedAt: new Date().toISOString(),
    databasePath: dbPath,
    rpcUrl,
    networkTipLedger: networkTip,
    networkTipFetchError,
    comparisonRangeLow,
    comparisonRangeHigh,
    gapThreshold,
    contracts: contractReports,
    globalSuspectedGaps,
    limitations,
  };

  // ── Render report to stdout
  printReport(diagnosticReport);
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function printReport(r: DiagnosticReport): void {
  const HR = '─'.repeat(72);
  const THICK = '═'.repeat(72);

  console.log('');
  console.log(THICK);
  console.log('  NotifyChain — Checkpoint Gap Diagnostic');
  console.log(THICK);
  console.log(`  Generated : ${r.generatedAt}`);
  console.log(`  Database  : ${r.databasePath}`);
  console.log(`  RPC URL   : ${r.rpcUrl}`);
  console.log('');

  // ── Comparison range
  console.log('── Comparison Range ' + '─'.repeat(52));
  if (r.networkTipFetchError) {
    console.log(`  Network tip   : UNAVAILABLE`);
    console.log(`  Reason        : ${r.networkTipFetchError}`);
  } else {
    console.log(`  Network tip   : ledger ${formatLedger(r.networkTipLedger)}`);
  }
  const lowestLabel =
    r.comparisonRangeLow > 0
      ? `ledger ${formatLedger(r.comparisonRangeLow)} (lowest stored checkpoint)`
      : 'none (no checkpoints found)';
  console.log(`  Stored range  : ${lowestLabel} → ${formatLedger(r.comparisonRangeHigh)}`);
  console.log(`  Gap threshold : ${r.gapThreshold.toLocaleString()} ledgers`);
  console.log('');

  if (r.contracts.length === 0) {
    console.log('  No contracts found in polling_cursors or processed_events.');
    console.log('  The listener may never have successfully polled.');
    console.log('');
  }

  // ── Per-contract detail
  for (const c of r.contracts) {
    console.log(HR);
    console.log(`  Contract : ${c.contractAddress}`);
    console.log(HR);

    console.log(
      `  Checkpoint ledger : ${formatLedger(c.checkpointLedger)}` +
        (c.checkpointUpdatedAt ? `  (last updated ${c.checkpointUpdatedAt})` : ''),
    );
    console.log(`  Cursor            : ${c.checkpointCursor ?? 'none'}`);
    console.log(
      `  Reorg flag        : ${c.reorgDetected ? `YES (count: ${c.reorgDetectionCount})` : 'no'}`,
    );

    if (c.processedEventSpan) {
      const span = c.processedEventSpan;
      console.log(
        `  Processed events  : ${span.eventCount.toLocaleString()} events` +
          ` from ledger ${formatLedger(span.minLedger)} to ${formatLedger(span.maxLedger)}`,
      );
    } else {
      console.log('  Processed events  : none recorded');
    }

    if (c.warnings.length > 0) {
      console.log('');
      console.log('  Warnings:');
      for (const w of c.warnings) {
        console.log(`    ⚠  ${w}`);
      }
    }

    if (c.suspectedGaps.length > 0) {
      console.log('');
      console.log('  Suspected gaps:');
      for (const g of c.suspectedGaps) {
        console.log(`    ✗  Ledgers ${formatLedger(g.fromLedger)} – ${formatLedger(g.toLedger)}`);
        console.log(`       Span   : ${g.spanSize.toLocaleString()} ledgers`);
        console.log(`       Detail : ${g.description}`);
      }
    } else {
      console.log('');
      console.log('  No suspected gaps detected for this contract.');
    }

    console.log('');
  }

  // ── Global summary
  console.log(THICK);
  console.log('  Summary');
  console.log(THICK);
  console.log(`  Contracts analysed : ${r.contracts.length}`);
  console.log(`  Total suspected gaps : ${r.globalSuspectedGaps.length}`);

  if (r.globalSuspectedGaps.length > 0) {
    console.log('');
    console.log('  ⚠  Suspected gaps detected — see per-contract detail above.');
    console.log(
      '     These are indicators, not confirmed losses. Investigate by:',
    );
    console.log(
      '       1. Reviewing listener logs around the ledger range in question.',
    );
    console.log(
      '       2. Querying the Stellar RPC for events in that range manually.',
    );
    console.log(
      '       3. Checking if the cleanup service pruned processed_events.',
    );
  } else {
    console.log('');
    console.log('  ✓  No suspected gaps detected within the current retention window.');
  }

  console.log('');
  console.log('── Limitations ' + '─'.repeat(56));
  for (const l of r.limitations) {
    console.log(`  •  ${l}`);
  }
  console.log('');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

diagnose().catch((err) => {
  console.error('');
  console.error('✗  diagnose-checkpoints failed with an unexpected error:');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
