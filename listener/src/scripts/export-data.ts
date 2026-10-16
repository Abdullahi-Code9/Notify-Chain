#!/usr/bin/env ts-node
/**
 * Data Export CLI Utility (#850)
 *
 * Administrative utility for exporting selected notification and event records
 * for debugging, migration, or analysis.
 *
 * Usage:
 *   ts-node src/scripts/export-data.ts [options]
 *   npm run export:data -- [options]
 *
 * Examples:
 *   # Export all failed notifications as JSON
 *   ts-node src/scripts/export-data.ts --type notifications --status FAILED --output failed-notifications.json
 *
 *   # Export discord notifications as CSV
 *   ts-node src/scripts/export-data.ts --type notifications --channel discord --format csv --output discord.csv
 *
 *   # Export processed events for a contract
 *   ts-node src/scripts/export-data.ts --type events --contract CDNJ... --limit 500
 *
 *   # Export all records with sensitive data unmasked (requires explicit flag)
 *   ts-node src/scripts/export-data.ts --type all --include-sensitive --output full-export.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Database } from '../database/database';
import { DataExportService, DataExportOptions } from '../services/data-export-service';
import logger from '../utils/logger';

dotenv.config();

function printHelp(): void {
  console.log(`
Notify-Chain Data Export Utility (#850)
=======================================

Usage:
  ts-node src/scripts/export-data.ts [options]

Options:
  --type <type>           Export type: 'notifications', 'events', or 'all' (default: 'all')
  --format <format>       Output format: 'json' or 'csv' (default: 'json')
  --status <status>       Filter by status (e.g. 'PENDING', 'COMPLETED', 'FAILED', 'PROCESSED')
  --channel <type>        Filter notifications by channel (e.g. 'discord', 'webhook', 'email')
  --recipient <pattern>   Filter notifications by recipient substring
  --contract <address>    Filter by Stellar contract address
  --event-type <type>     Filter events by event type
  --from <isoDate>        Filter records created/processed at or after this date (ISO format)
  --to <isoDate>          Filter records created/processed at or before this date (ISO format)
  --limit <number>        Maximum number of records to export per category (1-10000, default: 1000)
  --offset <number>       Pagination offset (default: 0)
  --output <path>         Write export output to specified file path instead of stdout
  --db-path <path>        Custom SQLite database path (default: process.env.DATABASE_PATH or './data/notifications.db')
  --include-sensitive     Include unredacted credentials and tokens (WARNING: handles sensitive data)
  --help, -h              Show this help message
`);
}

function parseArgs(): {
  options: DataExportOptions;
  outputPath?: string;
  dbPath?: string;
  showHelp: boolean;
} {
  const args = process.argv.slice(2);
  let showHelp = false;
  let outputPath: string | undefined;
  let dbPath: string | undefined;

  const exportOptions: DataExportOptions = {
    type: 'all',
    format: 'json',
    includeSensitive: false,
    notificationFilters: {},
    eventFilters: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      showHelp = true;
      break;
    } else if (arg === '--type' && i + 1 < args.length) {
      const val = args[++i].toLowerCase();
      if (val === 'notifications' || val === 'events' || val === 'all') {
        exportOptions.type = val;
      }
    } else if (arg === '--format' && i + 1 < args.length) {
      const val = args[++i].toLowerCase();
      if (val === 'json' || val === 'csv') {
        exportOptions.format = val;
      }
    } else if (arg === '--status' && i + 1 < args.length) {
      const val = args[++i];
      exportOptions.notificationFilters!.status = val;
      exportOptions.eventFilters!.status = val;
    } else if ((arg === '--channel' || arg === '--notification-type') && i + 1 < args.length) {
      exportOptions.notificationFilters!.notificationType = args[++i];
    } else if (arg === '--recipient' && i + 1 < args.length) {
      exportOptions.notificationFilters!.targetRecipient = args[++i];
    } else if (arg === '--contract' && i + 1 < args.length) {
      const val = args[++i];
      exportOptions.notificationFilters!.contractAddress = val;
      exportOptions.eventFilters!.contractAddress = val;
    } else if (arg === '--event-type' && i + 1 < args.length) {
      exportOptions.eventFilters!.eventType = args[++i];
    } else if (arg === '--from' && i + 1 < args.length) {
      const val = args[++i];
      exportOptions.notificationFilters!.fromDate = val;
      exportOptions.eventFilters!.fromDate = val;
    } else if (arg === '--to' && i + 1 < args.length) {
      const val = args[++i];
      exportOptions.notificationFilters!.toDate = val;
      exportOptions.eventFilters!.toDate = val;
    } else if (arg === '--limit' && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) {
        exportOptions.notificationFilters!.limit = val;
        exportOptions.eventFilters!.limit = val;
      }
    } else if (arg === '--offset' && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) {
        exportOptions.notificationFilters!.offset = val;
        exportOptions.eventFilters!.offset = val;
      }
    } else if (arg === '--output' && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (arg === '--db-path' && i + 1 < args.length) {
      dbPath = args[++i];
    } else if (arg === '--include-sensitive') {
      exportOptions.includeSensitive = true;
    }
  }

  return { options: exportOptions, outputPath, dbPath, showHelp };
}

async function run(): Promise<void> {
  const { options, outputPath, dbPath, showHelp } = parseArgs();

  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  const databasePath =
    dbPath || process.env.DATABASE_PATH || './data/notifications.db';

  if (!fs.existsSync(databasePath)) {
    console.error(`Error: Database file does not exist at path: ${databasePath}`);
    process.exit(1);
  }

  const db = new Database(databasePath);
  await db.initialize();

  try {
    const service = new DataExportService(db);
    const result = await service.exportData(options);

    let outputContent: string;
    if (options.format === 'csv') {
      outputContent = result.csvContent || '';
    } else {
      outputContent = JSON.stringify(result, null, 2);
    }

    if (outputPath) {
      const resolvedPath = path.resolve(outputPath);
      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(resolvedPath, outputContent, 'utf-8');
      console.error(
        `[SUCCESS] Exported data written to ${resolvedPath} (format: ${options.format}, records: N=${result.metadata.totalNotifications ?? 0}, E=${result.metadata.totalEvents ?? 0}, duration: ${result.durationMs}ms)`
      );
    } else {
      process.stdout.write(outputContent + '\n');
    }

    await db.close();
    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Data export failed:', error);
    await db.close().catch(() => {});
    process.exit(1);
  }
}

void run();
