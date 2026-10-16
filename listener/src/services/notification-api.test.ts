import { jest } from '@jest/globals';
import { NotificationAPI } from './notification-api';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { NotificationType } from '../types/scheduled-notification';
import { ValidationError } from '../utils/validation';

function makeRepository(): jest.Mocked<Pick<ScheduledNotificationRepository, 'create'>> {
  return {
    create: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  };
}

function futureDate(msFromNow = 60_000): Date {
  return new Date(Date.now() + msFromNow);
}

function baseInput() {
  return {
    payload: { message: 'hello' },
    notificationType: NotificationType.DISCORD,
    targetRecipient: 'https://discord.com/webhook/abc',
    executeAt: futureDate(),
  };
}

describe('NotificationAPI.scheduleNotification', () => {
  let repository: jest.Mocked<Pick<ScheduledNotificationRepository, 'create'>>;
  let api: NotificationAPI;

  beforeEach(() => {
    repository = makeRepository();
    api = new NotificationAPI(repository as unknown as ScheduledNotificationRepository);
  });

  it('accepts a valid notification and forwards it to the repository', async () => {
    const input = baseInput();
    const id = await api.scheduleNotification(input);
    expect(id).toBe(1);
    // scheduleNotification() stamps the payload with the current protocol
    // version (ensureNotificationVersion) before handing it to the repository.
    expect(repository.create).toHaveBeenCalledWith(
      { ...input, payload: { ...input.payload, version: 1 } },
      undefined,
    );
  });

  it('rejects a missing executeAt', async () => {
    const input = { ...baseInput(), executeAt: undefined as any };
    await expect(api.scheduleNotification(input)).rejects.toThrow('executeAt must be a valid date');
  });

  it('rejects an executeAt in the past', async () => {
    const input = { ...baseInput(), executeAt: new Date(Date.now() - 60_000) };
    await expect(api.scheduleNotification(input)).rejects.toThrow(
      'executeAt must be a future timestamp',
    );
  });

  it('rejects a non-object payload', async () => {
    const input = { ...baseInput(), payload: 'not-an-object' as any };
    await expect(api.scheduleNotification(input)).rejects.toThrow('payload must be a valid object');
  });

  it('rejects an array payload', async () => {
    const input = { ...baseInput(), payload: ['a', 'b'] as any };
    await expect(api.scheduleNotification(input)).rejects.toThrow('payload must be a valid object');
  });

  it('rejects an empty targetRecipient', async () => {
    const input = { ...baseInput(), targetRecipient: '   ' };
    await expect(api.scheduleNotification(input)).rejects.toThrow('targetRecipient is required');
  });

  it('rejects an unknown notificationType', async () => {
    const input = { ...baseInput(), notificationType: 'carrier-pigeon' as any };
    await expect(api.scheduleNotification(input)).rejects.toThrow(ValidationError);
    await expect(api.scheduleNotification(input)).rejects.toThrow(/notificationType/);
  });

  it('rejects a negative maxRetries', async () => {
    const input = { ...baseInput(), maxRetries: -1 };
    await expect(api.scheduleNotification(input)).rejects.toThrow(/maxRetries/);
  });

  it('rejects a non-integer maxRetries', async () => {
    const input = { ...baseInput(), maxRetries: 2.5 };
    await expect(api.scheduleNotification(input)).rejects.toThrow(/maxRetries/);
  });

  it('rejects a priority outside the documented 1-10 range', async () => {
    const tooLow = { ...baseInput(), priority: 0 };
    const tooHigh = { ...baseInput(), priority: 11 };
    await expect(api.scheduleNotification(tooLow)).rejects.toThrow(/priority/);
    await expect(api.scheduleNotification(tooHigh)).rejects.toThrow(/priority/);
  });

  it('accepts priority at the documented boundaries', async () => {
    await expect(api.scheduleNotification({ ...baseInput(), priority: 1 })).resolves.toBe(1);
    await expect(api.scheduleNotification({ ...baseInput(), priority: 10 })).resolves.toBe(1);
  });

  it('rejects a non-object metadata', async () => {
    const input = { ...baseInput(), metadata: 'oops' as any };
    await expect(api.scheduleNotification(input)).rejects.toThrow(/metadata/);
  });

  it('rejects an empty eventId when provided', async () => {
    const input = { ...baseInput(), eventId: '' };
    await expect(api.scheduleNotification(input)).rejects.toThrow(/eventId/);
  });

  it('reports every invalid field in a single error', async () => {
    const input = {
      ...baseInput(),
      notificationType: 'bogus' as any,
      maxRetries: -5,
      priority: 999,
    };
    try {
      await api.scheduleNotification(input);
      throw new Error('expected scheduleNotification to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const fields = (err as ValidationError).issues.map((i) => i.field);
      expect(fields).toEqual(expect.arrayContaining(['notificationType', 'maxRetries', 'priority']));
    }
  });

  it('does not call the repository when validation fails', async () => {
    const input = { ...baseInput(), priority: 999 };
    await expect(api.scheduleNotification(input)).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });
});

import { PayloadTooLargeError, DEFAULT_MAX_PAYLOAD_SIZE_BYTES } from '../utils/payload-size-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a payload whose JSON representation is exactly `targetBytes` bytes
 * *after* scheduleNotification() stamps it with the protocol version (#see
 * ensureNotificationVersion) — the fixture already carries `version` so the
 * stamping step is a no-op and doesn't grow the payload past the boundary.
 */
function payloadOfExactBytes(targetBytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(JSON.stringify({ data: '', version: 1 }), 'utf8');
  const fillLength = targetBytes - overhead;
  if (fillLength < 0) throw new Error(`targetBytes ${targetBytes} too small for wrapper`);
  return { data: 'x'.repeat(fillLength), version: 1 };
}

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

const mockCreate = jest.fn<() => Promise<number>>().mockResolvedValue(1);
const mockCancel = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockGetById = jest.fn<() => Promise<null>>().mockResolvedValue(null);
const mockGetStats = jest.fn<() => Promise<object>>().mockResolvedValue({});

const mockRepository = {
  create: mockCreate,
  cancel: mockCancel,
  getById: mockGetById,
  getStats: mockGetStats,
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationAPI – payload size validation', () => {
  let api: NotificationAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    api = new NotificationAPI(mockRepository);
  });

  describe('default limit (64 KB)', () => {
    it('exposes the default max payload size', () => {
      expect(api.maxPayloadSizeBytes).toBe(DEFAULT_MAX_PAYLOAD_SIZE_BYTES);
    });

    it('schedules a notification with a small payload (under limit)', async () => {
      const id = await api.scheduleNotification({
        payload: { message: 'hello world', recipient: 'alice' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://discord.com/webhook',
        executeAt: futureDate(),
      });

      expect(id).toBe(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('schedules a notification whose payload is exactly at the limit', async () => {
      const payload = payloadOfExactBytes(DEFAULT_MAX_PAYLOAD_SIZE_BYTES);
      const byteLength = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      expect(byteLength).toBe(DEFAULT_MAX_PAYLOAD_SIZE_BYTES);

      await expect(
        api.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        })
      ).resolves.toBe(1);

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('rejects a payload that is 1 byte over the limit', async () => {
      const payload = payloadOfExactBytes(DEFAULT_MAX_PAYLOAD_SIZE_BYTES + 1);

      await expect(
        api.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        })
      ).rejects.toThrow(PayloadTooLargeError);

      // Storage must NOT be called when the payload is oversized.
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects a clearly oversized payload', async () => {
      const payload = { data: 'a'.repeat(200_000) };

      await expect(
        api.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        })
      ).rejects.toThrow(PayloadTooLargeError);

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('includes a descriptive message in the thrown error', async () => {
      const payload = { data: 'a'.repeat(200_000) };
      let thrown: Error | undefined;

      try {
        await api.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        });
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeInstanceOf(PayloadTooLargeError);
      expect(thrown!.message).toContain('too large');
    });
  });

  describe('custom limit', () => {
    it('accepts a payload within a custom limit', async () => {
      const customLimit = 200;
      const customApi = new NotificationAPI(mockRepository, customLimit);
      const payload = { msg: 'small' };

      await expect(
        customApi.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        })
      ).resolves.toBe(1);
    });

    it('rejects a payload that exceeds the custom limit', async () => {
      const customLimit = 50;
      const customApi = new NotificationAPI(mockRepository, customLimit);
      const payload = { data: 'x'.repeat(100) };

      await expect(
        customApi.scheduleNotification({
          payload,
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: futureDate(),
        })
      ).rejects.toThrow(PayloadTooLargeError);

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('existing validation still works', () => {
    it('rejects a missing executeAt', async () => {
      await expect(
        api.scheduleNotification({
          payload: { msg: 'hi' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: null as any,
        })
      ).rejects.toThrow('executeAt must be a valid date');
    });

    it('rejects a past executeAt', async () => {
      await expect(
        api.scheduleNotification({
          payload: { msg: 'hi' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://discord.com/webhook',
          executeAt: new Date(Date.now() - 1000),
        })
      ).rejects.toThrow('executeAt must be a future timestamp');
    });

    it('rejects a missing targetRecipient', async () => {
      await expect(
        api.scheduleNotification({
          payload: { msg: 'hi' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: '',
          executeAt: futureDate(),
        })
      ).rejects.toThrow('targetRecipient is required');
    });
  });
});
