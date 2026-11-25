import { NotificationAPI } from './notification-api';
import { ScheduleValidationError, toScheduleValidationResponse } from './schedule-validator';
import { NotificationType } from '../types/scheduled-notification';

const now = new Date('2026-01-01T00:00:00.000Z');
const horizonMs = 60_000;

function createApi() {
  const repository = { create: jest.fn().mockResolvedValue(42) };
  const api = new NotificationAPI(
    repository as any,
    undefined,
    undefined,
    horizonMs,
    () => new Date(now),
  );
  return { api, repository };
}

function input(
  executeAt: Date,
  recurrence?: { frequency: 'daily'; count?: number; until?: Date | string },
) {
  return {
    payload: { message: 'scheduled' },
    notificationType: NotificationType.WEBHOOK,
    targetRecipient: 'https://example.test/hook',
    executeAt,
    recurrence,
  };
}

describe('NotificationAPI schedule horizon validation', () => {
  it('accepts the exact configured horizon', async () => {
    const { api, repository } = createApi();
    await expect(
      api.scheduleNotification(input(new Date(now.getTime() + horizonMs))),
    ).resolves.toBe(42);
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a far-future request before persistence with a clear 400 response shape', async () => {
    const { api, repository } = createApi();
    const offending = new Date(now.getTime() + horizonMs + 1);
    let error: ScheduleValidationError | undefined;

    try {
      await api.scheduleNotification(input(offending));
    } catch (caught) {
      error = caught as ScheduleValidationError;
    }

    expect(error).toBeInstanceOf(ScheduleValidationError);
    expect(toScheduleValidationResponse(error!)).toEqual({
      statusCode: 400,
      body: {
        error: `executeAt ${offending.toISOString()} exceeds the maximum scheduling horizon of ${horizonMs} ms (limit: ${new Date(now.getTime() + horizonMs).toISOString()})`,
        code: 'INVALID_SCHEDULE',
      },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('allows recurrence occurrences beyond the horizon but rejects a first run beyond it', async () => {
    const { api, repository } = createApi();
    await expect(
      api.scheduleNotification(
        input(new Date(now.getTime() + horizonMs), { frequency: 'daily', count: 10 }),
      ),
    ).resolves.toBe(42);

    await expect(
      api.scheduleNotification(
        input(new Date(now.getTime() + horizonMs + 1), { frequency: 'daily', count: 10 }),
      ),
    ).rejects.toThrow(ScheduleValidationError);
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('rejects recurrence until beyond the horizon', async () => {
    const { api, repository } = createApi();
    await expect(
      api.scheduleNotification(
        input(new Date(now.getTime() + 1_000), {
          frequency: 'daily',
          until: new Date(now.getTime() + horizonMs + 1),
        }),
      ),
    ).rejects.toThrow('recurrence.until');
    expect(repository.create).not.toHaveBeenCalled();
  });
});
