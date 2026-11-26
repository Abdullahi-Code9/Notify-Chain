import { Database } from '../database/database';
import {
  DestinationConflictError,
  DestinationNotFoundError,
  DestinationOwnershipError,
  DestinationService,
  DestinationValidationError,
} from './destination-service';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { NotificationAPI } from './notification-api';
import { NotificationImportService } from './notification-import-service';
import { NotificationType } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  sanitizeUrl: (u: string) => u,
}));

jest.mock('./scheduled-notification-repository', () => ({
  ScheduledNotificationRepository: jest.fn(),
}));

describe('DestinationService ownership & cross-account protection', () => {
  let db: Database;
  let service: DestinationService;

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
    service = new DestinationService({
      db,
      testSender: async () => ({ success: true, message: 'Delivered', latencyMs: 12 }),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('associates created destinations with their owner and masks secrets', async () => {
    const created = await service.create('user-a', {
      provider: 'webhook',
      displayName: 'User A Webhook',
      enabled: true,
      settings: { url: 'https://example.com/hooks/a' },
      secrets: { signingSecret: 'super-secret-value-1234' },
    });

    expect(created.ownerId).toBe('user-a');
    expect(created.status).toBe('connected');
    expect(created.secrets.signingSecret).toEqual({ isSet: true, last4: '1234' });
    expect(JSON.stringify(created)).not.toContain('super-secret-value-1234');
  });

  it('rejects cross-account ownerId spoofing on create and update', async () => {
    await expect(
      service.create('user-a', {
        provider: 'webhook',
        ownerId: 'user-b',
        settings: { url: 'https://example.com/hooks/a' },
        secrets: { signingSecret: 'super-secret-value-1234' },
      }),
    ).rejects.toThrow(DestinationOwnershipError);

    const created = await service.create('user-a', {
      provider: 'webhook',
      settings: { url: 'https://example.com/hooks/a' },
      secrets: { signingSecret: 'super-secret-value-1234' },
    });

    await expect(
      service.updateForOwner(created.id, 'user-a', {
        ownerId: 'user-b',
        enabled: true,
        settings: { url: 'https://example.com/hooks/a' },
      }),
    ).rejects.toThrow(DestinationOwnershipError);
  });

  it('enforces strict ownership on list, get, update, test, and delete', async () => {
    const destA = await service.create('user-a', {
      provider: 'webhook',
      displayName: 'A Hook',
      settings: { url: 'https://example.com/a' },
      secrets: { signingSecret: 'secret-aaaa-9999' },
    });
    const destB = await service.create('user-b', {
      provider: 'discord',
      displayName: 'B Discord',
      secrets: { webhookUrl: 'https://discord.com/api/webhooks/123/token-bbbb' },
    });

    const listA = await service.listForOwner('user-a');
    expect(listA.map((d) => d.id)).toEqual([destA.id]);

    const listB = await service.listForOwner('user-b');
    expect(listB.map((d) => d.id)).toEqual([destB.id]);

    // Cross-account lookup, update, test, delete are rejected
    await expect(service.getForOwner(destA.id, 'user-b')).rejects.toThrow(
      DestinationOwnershipError,
    );
    await expect(
      service.updateForOwner(destA.id, 'user-b', {
        enabled: false,
        settings: { url: 'https://attacker.example/hook' },
      }),
    ).rejects.toThrow(DestinationOwnershipError);
    await expect(service.sendTestForOwner(destA.id, 'user-b')).rejects.toThrow(
      DestinationOwnershipError,
    );
    await expect(service.deleteForOwner(destA.id, 'user-b')).rejects.toThrow(
      DestinationOwnershipError,
    );

    // Non-existent destination returns DestinationNotFoundError
    await expect(service.getForOwner('does-not-exist', 'user-a')).rejects.toThrow(
      DestinationNotFoundError,
    );

    // Rightful owner can read, update, test, and delete
    const fetched = await service.getForOwner(destA.id, 'user-a');
    expect(fetched.id).toBe(destA.id);

    const updated = await service.updateForOwner(destA.id, 'user-a', {
      enabled: true,
      settings: { url: 'https://example.com/a-v2' },
    });
    expect(updated.settings.url).toBe('https://example.com/a-v2');
    expect(updated.secrets.signingSecret).toEqual({ isSet: true, last4: '9999' });

    const testResult = await service.sendTestForOwner(destA.id, 'user-a');
    expect(testResult.success).toBe(true);

    const delResult = await service.deleteForOwner(destA.id, 'user-a');
    expect(delResult).toEqual({ deleted: true, id: destA.id });
    await expect(service.getForOwner(destA.id, 'user-a')).rejects.toThrow(DestinationNotFoundError);
  });

  it('prevents claiming an existing destination id belonging to another owner', async () => {
    await service.create('user-a', {
      id: 'shared-slug',
      provider: 'webhook',
      settings: { url: 'https://example.com/a' },
      secrets: { signingSecret: 'secret-aaaa-1111' },
    });

    await expect(
      service.create('user-b', {
        id: 'shared-slug',
        provider: 'webhook',
        settings: { url: 'https://example.com/b' },
        secrets: { signingSecret: 'secret-bbbb-2222' },
      }),
    ).rejects.toThrow(DestinationOwnershipError);

    await expect(
      service.create('user-a', {
        id: 'shared-slug',
        provider: 'webhook',
        settings: { url: 'https://example.com/a2' },
        secrets: { signingSecret: 'secret-aaaa-2222' },
      }),
    ).rejects.toThrow(DestinationConflictError);
  });

  it('validates destination fields server-side', async () => {
    await expect(
      service.create('user-a', {
        provider: 'webhook',
        enabled: true,
        settings: { url: 'http://insecure.example.com' },
        secrets: { signingSecret: 'short' },
      }),
    ).rejects.toThrow(DestinationValidationError);
  });

  it('blocks cross-account destination references during scheduling and bulk import', async () => {
    const destA = await service.create('user-a', {
      provider: 'webhook',
      displayName: 'A Hook',
      settings: { url: 'https://example.com/hooks/a' },
      secrets: { signingSecret: 'secret-aaaa-1234' },
    });

    const bindings = new Map<number, { destinationId: string | null; ownerId: string }>();
    let nextId = 1;
    const repo = {
      create: jest.fn(async () => nextId++),
      bindDestinationOwnership: jest.fn(
        async (scheduledNotificationId: number, destinationId: string, ownerId: string) => {
          bindings.set(scheduledNotificationId, { destinationId, ownerId });
        },
      ),
      getDestinationBinding: jest.fn(async (id: number) => bindings.get(id) ?? null),
    } as unknown as ScheduledNotificationRepository;

    const api = new NotificationAPI(repo);
    api.setDestinationService(service);

    const future = new Date(Date.now() + 60_000);

    // Owner A can schedule using Destination A
    const scheduledId = await api.scheduleNotification({
      ownerId: 'user-a',
      destinationId: destA.id,
      notificationType: NotificationType.WEBHOOK,
      targetRecipient: '',
      payload: { event: 'transfer' },
      executeAt: future,
    });
    expect(await repo.getDestinationBinding(scheduledId)).toEqual({
      destinationId: destA.id,
      ownerId: 'user-a',
    });

    // Owner B CANNOT schedule referencing Destination A
    await expect(
      api.scheduleNotification({
        ownerId: 'user-b',
        destinationId: destA.id,
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: '',
        payload: { event: 'hijack' },
        executeAt: future,
      }),
    ).rejects.toThrow(DestinationOwnershipError);
    expect(repo.create).toHaveBeenCalledTimes(1);

    // Bulk import skips cross-account destination references
    const importer = new NotificationImportService(api);
    const summary = await importer.importRecords(
      [
        {
          id: 'imp-1',
          destinationId: destA.id,
          channel: 'webhook',
          message: 'allowed',
          executeAt: future.toISOString(),
        },
      ],
      'json',
      { ownerId: 'user-b' },
    );
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.skippedRecords[0].reason).toMatch(/permission/i);
  });
});
