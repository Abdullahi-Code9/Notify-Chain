import { Database } from '../database/database';
import { generateFingerprint } from './notification-deduplicator';
import { EventStoreConsistencyReport } from './event-store-consistency';

describe('EventStoreConsistencyReport', () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    await db.initialize();
  });

  beforeEach(async () => {
    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');
    await db.run('DELETE FROM processed_events');
  });

  afterAll(async () => {
    await db.close();
  });

  async function counts(): Promise<Record<string, number>> {
    const tables = ['processed_events', 'scheduled_notifications', 'notification_execution_log'];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
      result[table] = row?.count ?? 0;
    }
    return result;
  }

  it('explains every check and reports no findings for a consistent store', async () => {
    await db.run(
      `
      INSERT INTO processed_events (
        event_id, contract_address, fingerprint, ledger_number, tx_hash, event_type, notification_sent, status
      ) VALUES (?, ?, ?, 10, 'tx-ok', 'contract', 1, 'PROCESSED')
      `,
      ['event-ok', 'CCONTRACT', generateFingerprint('event-ok', 'CCONTRACT')],
    );

    const report = await new EventStoreConsistencyReport(db).generate();

    expect(report.readOnly).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual([
      'fingerprint_mismatch',
      'error_missing_reason',
      'delivery_conflicts_with_status',
      'processing_record_missing_event',
      'success_without_transaction',
      'execution_conflicts_with_event_status',
    ]);
    expect(
      report.checks.every((check) => check.explanation.length > 0 && check.findingCount === 0),
    ).toBe(true);
  });

  it('identifies inconsistent events, transaction references, and processing records without writing', async () => {
    await db.run(
      `
      INSERT INTO processed_events (
        event_id, contract_address, fingerprint, ledger_number, tx_hash, event_type,
        notification_sent, status, error_reason
      ) VALUES (?, ?, 'not-a-real-fingerprint', 11, NULL, 'contract', 1, 'ERROR', NULL)
      `,
      ['event-bad', 'CCONTRACT'],
    );
    const notification = await db.run(
      `
      INSERT INTO scheduled_notifications (
        payload, notification_type, target_recipient, execute_at, event_id, contract_address
      ) VALUES ('{}', 'webhook', 'user-1', '2026-01-01T00:00:00Z', 'event-bad', 'CCONTRACT')
      `,
    );
    await db.run(
      `
      INSERT INTO notification_execution_log (scheduled_notification_id, execution_attempt, status)
      VALUES (?, 1, 'SUCCESS')
      `,
      [notification.lastID],
    );
    await db.run(
      `
      INSERT INTO scheduled_notifications (
        payload, notification_type, target_recipient, execute_at, event_id, contract_address
      ) VALUES ('{}', 'webhook', 'user-2', '2026-01-01T00:00:00Z', 'event-missing', 'COTHER')
      `,
    );

    const before = await counts();
    const run = jest.spyOn(db, 'run');
    const report = await new EventStoreConsistencyReport(db).generate();
    const after = await counts();

    expect(run).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(report.readOnly).toBe(true);

    const byCheck = (id: string) => report.findings.filter((finding) => finding.check === id);
    expect(byCheck('fingerprint_mismatch').map((finding) => finding.record.id)).toEqual([
      expect.any(Number),
    ]);
    expect(byCheck('error_missing_reason')[0].record).toMatchObject({
      table: 'processed_events',
      eventId: 'event-bad',
      contractAddress: 'CCONTRACT',
      txHash: null,
    });
    expect(byCheck('delivery_conflicts_with_status')[0].record.eventId).toBe('event-bad');
    expect(byCheck('processing_record_missing_event')[0].record).toMatchObject({
      table: 'scheduled_notifications',
      eventId: 'event-missing',
      contractAddress: 'COTHER',
    });
    expect(byCheck('success_without_transaction')[0].record.eventId).toBe('event-bad');
    expect(byCheck('execution_conflicts_with_event_status')[0].record.table).toBe(
      'notification_execution_log',
    );

    for (const check of report.checks) {
      expect(check.explanation.length).toBeGreaterThan(0);
      expect(check.findingCount).toBe(byCheck(check.id).length);
    }
  });
});
