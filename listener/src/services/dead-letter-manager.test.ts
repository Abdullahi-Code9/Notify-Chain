import { DeadLetterManager } from './dead-letter-manager';

describe('Dead-Letter Isolation & Operator Diagnostics (Issue #706)', () => {
  let manager: DeadLetterManager;

  beforeEach(() => {
    manager = new DeadLetterManager();
  });

  test('isolates failed notifications with redacted secret information', () => {
    const entry = manager.isolateNotification({
      originalNotificationId: 'notif-12345',
      provider: 'Discord',
      targetRecipient: 'https://discord.com/api/webhooks/999/SecretTokenABC',
      error: new Error('Discord rate limited (429) on secret-endpoint'),
      retryAttempts: 5,
      payload: { eventId: 'evt-001', amount: '100' },
    });

    expect(entry.dlqId).toMatch(/^dlq-/);
    expect(entry.originalNotificationId).toBe('notif-12345');
    expect(entry.status).toBe('isolated');
    expect(entry.targetRecipientSanitized).not.toContain('SecretTokenABC');
    expect(entry.retryAttempts).toBe(5);
  });

  test('allows operator inspection and listing with status filters', () => {
    manager.isolateNotification({
      originalNotificationId: 'n1',
      provider: 'Discord',
      targetRecipient: 'hook1',
      error: 'timeout',
      retryAttempts: 3,
      payload: {},
    });

    manager.isolateNotification({
      originalNotificationId: 'n2',
      provider: 'Webhook',
      targetRecipient: 'hook2',
      error: '500 Internal Server Error',
      retryAttempts: 5,
      payload: {},
    });

    const list = manager.listDeadLetters({ provider: 'Discord' });
    expect(list.total).toBe(1);
    expect(list.entries[0].provider).toBe('Discord');
  });

  test('supports requeuing and metrics tracking', () => {
    const entry = manager.isolateNotification({
      originalNotificationId: 'n-requeue',
      provider: 'Webhook',
      targetRecipient: 'hook',
      error: 'temp network failure',
      retryAttempts: 3,
      payload: {},
    });

    expect(manager.getMetrics().activeDepth).toBe(1);

    const requeued = manager.requeue(entry.dlqId);
    expect(requeued.status).toBe('requeued');
    expect(manager.getMetrics().activeDepth).toBe(0);
    expect(manager.getMetrics().requeuedCount).toBe(1);
  });
});
