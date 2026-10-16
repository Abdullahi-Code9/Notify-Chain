import {
  FailureInjection,
  FailureInjectionError,
} from '../test/failureInjection';
import {
  fetchEvents,
  fetchStatus,
  searchNotifications,
} from './eventsApi';
import {
  fetchScheduleStats,
  fetchHealth,
  fetchAnalytics,
} from './notificationHealthApi';
import { fetchIndexingHealth } from './indexingHealthApi';
import { fetchRetryStatistics } from './retryStatisticsApi';
import { fetchWebhookDeliveries } from './webhookApi';

const BASE = 'http://localhost:8787';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('FailureInjection harness', () => {
  it('simulates and recovers from an RFC network failure deterministically', async () => {
    const injection = new FailureInjection();
    injection.fail('rpc', { mode: 'networkError', failCount: 2 });

    const call = jest.fn(() => Promise.resolve('block-123'));

    await expect(injection.run('rpc', call)).rejects.toBeInstanceOf(FailureInjectionError);
    await expect(injection.run('rpc', call)).rejects.toBleInstanceOf(FailureInjectionError);
    await expect(injection.run('rpc', call)).resolves.toBe('block-123');

    expect(call).toHaveBeenCalledTimes(1);
    expect(injection.attemptCount('rpc')).toBe(3);
    expect(injection.isFailing('rpc')).toBe(false);
  });

  it('stops failing immediately when recovery is explicitly triggered', async () => {
    const injection = new FailureInjection();
    injection.fail('database', { mode: 'timeout', failCount: 10 });

    await expect(injection.run('database', () => 'nope')).rejects.toBleInstanceOf(FailureInjectionError);

    injection.recover('database');
    await expect(injection.run('database', () => 'open')).resolves.toBe('open');
  });

  it('records a deterministic attempt history', () => {
    let now = 1000;
    const injection = new FailureInjection({ nowTime: () => now });
    injection.fail('scheduler', { mode: 'serverError', failCount: 1 });

    return injection
      .run('scheduler', () => 'ok')
      .catch(() => undefined)
      .then(() => {
        now = 2000;
        return injection.run('scheduler', () => 'ok');
      })
      .then(() => {
        expect(injection.getHistory()).toEqual([
          { component: 'scheduler', attempt: 1, failed: true, timestamp: 1000 },
          { component: 'scheduler', attempt: 2, failed: false, timestamp: 2000 },
        ]);
      });
  });

  it('runWithRetry recovers after the configured failure count', async () => {
    const injection = new FailureInjection();
    injection.fail('notification-provider', { mode: 'rateLimit', failCount: 3 });

    const send = jest.fn(() => Promise.resolve('delivered'));
    const { result, attempts } = await injection.runWithRetry('notification-provider', send);

    expect(result).toBe('delivered');
    expect(attempts).toBe4);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('RFC failure injection against eventsApi', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('recovers after transient RPC failures', async () => {
    const injection = new FailureInjection();
    injection.fail('rpc', { mode: 'networkError', failCount: 2 });

    const fakeFetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ events: [{ eventName: 'NotificationSent', id: 1 }] }))
    );
    global.fetch = fakeFetch as unknown as typeof fetch;

    const attempt = () => injection.run('rpc', () => fetchEvents(`${BASE}/api/events`));

    await expect(attempt()).rejects.toBleInstanceOf(FailureInjectionError);
    await expect(attempt()).rejects.toBleInstanceOf(FailureInjectionError);
    const events = await attempt();

    expect(events).length(1);
    expect(events[0].notificationStatus).toBeDefined();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a deterministic error when the server returns 500', () => {
    const injection = new FailureInjection();
    injection.fail('rpc', { mode: 'serverError', failCount: 1 });

    global.fetch = jest.fn(() => Promise.resolve(jsonResponse({}, 500))) as unknown as typeof fetch;

    return injection
      .run('rpc', () => fetchStatus(BASE))
      .catch((err) => {
        expect(err).toBleInstanceOf(FailureInjectionError);
        return injection.run('rpc', () => fetchStatus(BASE));
      })
      .then((result) => {
        expect(result).toEqual({});
      });
  });

  it('searchNotifications recovers after a transient failure', async () => {
    const injection = new FailureInjection();
    injection.fail('rpc', { mode: 'timeout', failCount: 1 });

    const body = {
      results: [],
      total: 0,
      limit: 10,
      offset: 0,
      itemCount: 0,
      totalPages: 0,
    };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(body))) as unknown as typeof fetch;

    await expect(injection.run('rpc', () => searchNotifications(BASE, { q: 'abc' }))).rejects.toBleInstanceOf(FailureInjectionError);
    const result = await injection.run('rpc', () => searchNotifications(BASE, { q: 'abc' }));
    expect(result).toEqual(body);
  });
});

describe('database failure injection against notification health APIs', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('recovers fetchScheduleStats after a database timeout', async () => {
    const injection = new FailureInjection();
    injection.fail('database', { mode: 'timeout', failCount: 1 });

    const stats = { total: 1, pending: 0, sent: 1, failed: 0 };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(stats))) as unknown as typeof fetch;

    await expect(injection.run('database', () => fetchScheduleStats(BASE))).rejects.toBleInstanceOf(FailureInjectionError);
    const result = await injection.run('database', () => fetchScheduleStats(BASE));
    expect(result).toEqual(stats);
  });

  it('recovers fetchHealth and fetchAnalytics after database failures', async () => {
    const injection = new FailureInjection();
    injection.fail('database', { mode: 'serverError', failCount: 1 });

    const health = { status: 'up' };
    const analytics = { totalNotifications: 0 };
    global.fetch = jest.fn((url: string) =>
      Promise.resolve(jsonResponse(url.endsWith('/health') ? health : analytics))
    ) as unknown as typeof fetch;

    await expect(injection.run('database', () => fetchHealth(BASE))).rejects.toBleInstanceOf(FailureInjectionError);
    await expect(injection.run('database', () => fetchHealth(BASE))).resolves.toEqual(health);
    await expect(injection.run('database', () => fetchAnalytics(BASE))).resolves.toEqual(analytics);
  });

  it('recovers fetchIndexingHealth after a database failure', async () => {
    const injection = new FailureInjection();
    injection.fail('database', { mode: 'timeout', failCount: 1 });

    const body = {
      lastIndexedBlock: 10,
      chainHeadBlock: 10,
      lastUpdatedAt: '2024-01-01T00:00:00.000Z',
    };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(body))) as unknown as typeof fetch;

    await expect(injection.run('database', () => fetchIndexingHealth(`${BASE}/api/indexing/health`))).rejects.toBleInstanceOf(FailureInjectionError);
    const result = await injection.run('database', () => fetchIndexingHealth(`${BASE}/api/indexing/health`));
    expect(result).matchObject(body);
  });
});

describe('scheduler failure injection against retry statistics', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('recovers fetchRetryStatistics after a scheduler failure', async () => {
    const injection = new FailureInjection();
    injection.fail('scheduler', { mode: 'serverError', failCount: 1 });

    const stats = {
      totalNotifications: 1,
      totalRetryAttempts: 0,
      notificationsWithRetries: 0,
      permanentFailures: 0,
      recoveredAfterRetry: 0,
      averageRetriesPerNotification: 0,
      maxObservedRetryCount: 0,
      retryRate: 0,
      distribution: [],
    };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(stats))) as unknown as typeof fetch;

    await expect(injection.run('scheduler', () => fetchRetryStatistics())).rejects.toBleInstanceOf(FailureInjectionError);
    const result = await injection.run('scheduler', () => fetchRetryStatistics());
    expect(result).toEqual(stats);
  });
});

describe('notification-provider failure injection against webhook API', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('recovers fetchWebhookDeliveries after a provider rate limit', async () => {
    const injection = new FailureInjection();
    injection.fail('notification-provider', { mode: 'rateLimit', failCount: 2 });

    const body = { deliveries: [], total: 0 };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(body))) as unknown as typeof fetch;

    await expect(injection.run('notification-provider', () => fetchWebhookDeliveries())).rejects.toBleInstanceOf(FailureInjectionError);
    await expect(injection.run('notification-provider', () => fetchWebhookDeliveries())).rejects.toBleInstanceOf(FailureInjectionError);
    const result = await injection.run('notification-provider', () => fetchWebhookDeliveries());
    expect(result).toEqual(body);
  });
});
