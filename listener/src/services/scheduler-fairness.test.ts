import { Database, initializeDatabase } from '../database/database';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

describe('scheduler fairness across schedule groups (#970)', () => {
  let db: Database;
  let repo: ScheduledNotificationRepository;

  beforeEach(async () => {
    db = await initializeDatabase(':memory:');
    repo = new ScheduledNotificationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertDue(opts: {
    contractAddress: string;
    executeAtOffsetMs?: number;
    priority?: number;
  }): Promise<number> {
    const executeAt = new Date(Date.now() - (opts.executeAtOffsetMs ?? 1_000)).toISOString();
    const result = await db.run(
      `INSERT INTO scheduled_notifications (
        payload, notification_type, target_recipient, execute_at,
        status, priority, contract_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        JSON.stringify({ message: 'due' }),
        NotificationType.WEBHOOK,
        'https://example.com/h',
        executeAt,
        NotificationStatus.PENDING,
        opts.priority ?? 5,
        opts.contractAddress,
      ],
    );
    return result.lastID;
  }

  it('bounds batch size to MAX_SCHEDULER_BATCH_SIZE', async () => {
    expect(ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE).toBe(100);
    for (let i = 0; i < 5; i++) {
      await insertDue({ contractAddress: `G${i}` });
    }
    const locked = await repo.fetchAndLockPendingNotifications('proc-1', 30_000, 10_000);
    expect(locked.length).toBeLessThanOrEqual(
      ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE,
    );
    expect(locked.length).toBe(5);
  });

  it('makes progress across multiple schedule groups in one bounded batch', async () => {
    // Group A has a large backlog; groups B and C each have one due job.
    const groupA: number[] = [];
    for (let i = 0; i < 20; i++) {
      groupA.push(await insertDue({ contractAddress: 'group-A', executeAtOffsetMs: 20_000 - i }));
    }
    const idB = await insertDue({ contractAddress: 'group-B', executeAtOffsetMs: 500 });
    const idC = await insertDue({ contractAddress: 'group-C', executeAtOffsetMs: 400 });

    // Without fairness, earliest-first + LIMIT 6 would claim only group-A.
    // Round-robin guarantees B and C progress in the same bounded batch.
    const locked = await repo.fetchAndLockPendingNotifications('proc-fair', 30_000, 6);
    expect(locked.length).toBe(6);

    const groups = new Set(locked.map((n) => n.contractAddress ?? 'default'));
    expect(groups.has('group-A')).toBe(true);
    expect(groups.has('group-B')).toBe(true);
    expect(groups.has('group-C')).toBe(true);

    const lockedIds = new Set(locked.map((n) => n.id));
    expect(lockedIds.has(idB)).toBe(true);
    expect(lockedIds.has(idC)).toBe(true);

    const counts: Record<string, number> = {};
    for (const n of locked) {
      const g = n.contractAddress!;
      counts[g] = (counts[g] ?? 0) + 1;
    }
    // Rank-1 from each group first → B and C included; remaining slots from A.
    expect(counts['group-B']).toBe(1);
    expect(counts['group-C']).toBe(1);
    expect(counts['group-A']).toBe(4);
    expect(groupA.some((id) => lockedIds.has(id))).toBe(true);
  });
});
