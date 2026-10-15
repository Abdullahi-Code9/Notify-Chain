/**
 * Read-only consistency report for stored events and the processing records
 * that point at them (issue #951).
 *
 * `generate` runs SELECT queries only. It does not insert, update, or delete.
 */

import { Database } from '../database/database';
import { generateFingerprint } from './notification-deduplicator';

export interface AffectedRecord {
  table: 'processed_events' | 'scheduled_notifications' | 'notification_execution_log';
  id: number;
  eventId: string | null;
  contractAddress: string | null;
  txHash: string | null;
}

export interface ConsistencyCheck {
  id: string;
  explanation: string;
  findingCount: number;
}

export interface ConsistencyFinding {
  check: string;
  explanation: string;
  record: AffectedRecord;
}

export interface ConsistencyReport {
  generatedAt: string;
  readOnly: true;
  checks: ConsistencyCheck[];
  findings: ConsistencyFinding[];
}

interface CheckDefinition {
  id: string;
  explanation: string;
}

const CHECKS: CheckDefinition[] = [
  {
    id: 'fingerprint_mismatch',
    explanation:
      'Each processed event fingerprint must be the SHA-256 of contract_address and event_id. A mismatch means the stored event cannot be correlated with its contract.',
  },
  {
    id: 'error_missing_reason',
    explanation:
      'A processed event marked ERROR must keep a non-empty error_reason so operators can tell why processing stopped.',
  },
  {
    id: 'delivery_conflicts_with_status',
    explanation:
      'notification_sent can be true only when status is PROCESSED. ERROR or SKIPPED together with a sent notification is a contradictory processing record.',
  },
  {
    id: 'processing_record_missing_event',
    explanation:
      'A scheduled notification that names an event id and contract must have a matching processed_events row.',
  },
  {
    id: 'success_without_transaction',
    explanation:
      'A successful execution log for an event must line up with a processed event that still has its transaction hash.',
  },
  {
    id: 'execution_conflicts_with_event_status',
    explanation:
      'A successful execution log cannot belong to an event whose processed status is ERROR.',
  },
];

function record(
  table: AffectedRecord['table'],
  row: {
    id: number;
    event_id?: string | null;
    contract_address?: string | null;
    tx_hash?: string | null;
  },
): AffectedRecord {
  return {
    table,
    id: row.id,
    eventId: row.event_id ?? null,
    contractAddress: row.contract_address ?? null,
    txHash: row.tx_hash ?? null,
  };
}

export class EventStoreConsistencyReport {
  constructor(private readonly db: Database) {}

  async generate(): Promise<ConsistencyReport> {
    const findings: ConsistencyFinding[] = [];

    const events = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
      fingerprint: string;
      tx_hash: string | null;
    }>('SELECT id, event_id, contract_address, fingerprint, tx_hash FROM processed_events');

    const fingerprintCheck = CHECKS[0];
    for (const event of events) {
      if (generateFingerprint(event.event_id, event.contract_address) !== event.fingerprint) {
        findings.push({
          check: fingerprintCheck.id,
          explanation: fingerprintCheck.explanation,
          record: record('processed_events', event),
        });
      }
    }

    const errorRows = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
      tx_hash: string | null;
    }>(
      `
      SELECT id, event_id, contract_address, tx_hash
      FROM processed_events
      WHERE status = 'ERROR' AND (error_reason IS NULL OR TRIM(error_reason) = '')
      `,
    );
    for (const event of errorRows) {
      findings.push({
        check: CHECKS[1].id,
        explanation: CHECKS[1].explanation,
        record: record('processed_events', event),
      });
    }

    const deliveryRows = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
      tx_hash: string | null;
    }>(
      `
      SELECT id, event_id, contract_address, tx_hash
      FROM processed_events
      WHERE notification_sent = 1 AND status IN ('ERROR', 'SKIPPED')
      `,
    );
    for (const event of deliveryRows) {
      findings.push({
        check: CHECKS[2].id,
        explanation: CHECKS[2].explanation,
        record: record('processed_events', event),
      });
    }

    const orphanRows = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
    }>(
      `
      SELECT sn.id, sn.event_id, sn.contract_address
      FROM scheduled_notifications sn
      WHERE sn.event_id IS NOT NULL AND TRIM(sn.event_id) != ''
        AND sn.contract_address IS NOT NULL AND TRIM(sn.contract_address) != ''
        AND NOT EXISTS (
          SELECT 1 FROM processed_events pe
          WHERE pe.event_id = sn.event_id AND pe.contract_address = sn.contract_address
        )
      `,
    );
    for (const notification of orphanRows) {
      findings.push({
        check: CHECKS[3].id,
        explanation: CHECKS[3].explanation,
        record: record('scheduled_notifications', notification),
      });
    }

    const missingTxRows = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
      tx_hash: string | null;
    }>(
      `
      SELECT DISTINCT pe.id, pe.event_id, pe.contract_address, pe.tx_hash
      FROM processed_events pe
      JOIN scheduled_notifications sn
        ON sn.event_id = pe.event_id AND sn.contract_address = pe.contract_address
      JOIN notification_execution_log el
        ON el.scheduled_notification_id = sn.id AND el.status = 'SUCCESS'
      WHERE pe.tx_hash IS NULL OR TRIM(pe.tx_hash) = ''
      `,
    );
    for (const event of missingTxRows) {
      findings.push({
        check: CHECKS[4].id,
        explanation: CHECKS[4].explanation,
        record: record('processed_events', event),
      });
    }

    const conflictRows = await this.db.all<{
      id: number;
      event_id: string;
      contract_address: string;
      tx_hash: string | null;
    }>(
      `
      SELECT DISTINCT el.id, pe.event_id, pe.contract_address, pe.tx_hash
      FROM notification_execution_log el
      JOIN scheduled_notifications sn ON sn.id = el.scheduled_notification_id
      JOIN processed_events pe
        ON pe.event_id = sn.event_id AND pe.contract_address = sn.contract_address
      WHERE el.status = 'SUCCESS' AND pe.status = 'ERROR'
      `,
    );
    for (const entry of conflictRows) {
      findings.push({
        check: CHECKS[5].id,
        explanation: CHECKS[5].explanation,
        record: record('notification_execution_log', entry),
      });
    }

    const checks = CHECKS.map((check) => ({
      ...check,
      findingCount: findings.filter((finding) => finding.check === check.id).length,
    }));

    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      checks,
      findings,
    };
  }
}
