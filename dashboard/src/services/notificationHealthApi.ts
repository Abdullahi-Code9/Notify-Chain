import type {
  ScheduleStatsResponse,
  HealthResponse,
  NotificationAnalyticsSnapshot,
} from '../types/notificationHealth';

export type NotificationHealthDependency = 'rpc' | 'database' | 'scheduler' | 'notificationProvider';

export interface NotificationHealthFailureConfig {
  dependency: NotificationHealthDependency;
  failures: number;
  message?: string;
}

export interface NotificationHealthClientOptions {
  fetchImpl?: typeof fetch;
  failures?: NotificationHealthFailureConfig[];
}

export class NotificationHealthError extends Error {
  readonly dependency: NotificationHealthDependency;
  readonly status?: number;

  constructor(dependency: NotificationHealthDependency, message: string, status?: number) {
    super(message);
    this.name = 'NotificationHealthError';
    this.dependency = dependency;
    this.status = status;
  }
}

export interface NotificationHealthClient {
  readonly failures: NotificationHealthFailureConfig[];
  fetchScheduleStats(apiUrl: string): Promise<ScheduleStatsResponse>;
  fetchHealth(apiUrl: string): Promise<HealthResponse>;
  fetchAnalytics(apiUrl: string): Promise<NotificationAnalyticsSnapshot>;
  reset(): void;
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function normalizeFailures(
  failures: NotificationHealthFailureConfig[],
): NotificationHealthFailureConfig[] {
  return failures.map((config) => ({
    dependency: config.dependency,
    failures: Math.max(0, Math.floor(config.failures)),
    message: config.message,
  }));
}

function dependencyForPath(path: string): NotificationHealthDependency {
  if (path.includes('/schedule/')) {
    return 'scheduler';
  }
  if (path.includes('/analytics')) {
    return 'database';
  }
  if (path.includes('/health')) {
    return 'rpc';
  }
  return 'notificationProvider';
}

function defaultFailureMessage(dependency: NotificationHealthDependency): string {
  switch (dependency) {
    case 'rpc':
      return 'RPC dependency unavailable';
    case 'database':
      return 'Database dependency unavailable';
    case 'scheduler':
      return 'Scheduler dependency unavailable';
    case 'notificationProvider':
      return 'Notification provider unavailable';
  }
}

export function createNotificationHealthClient(
  options: NotificationHealthClientOptions = {},
): NotificationHealthClient {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const failures = normalizeFailures(options.failures ?? []);

  const consumeFailure = (dependency: NotificationHealthDependency): NotificationHealthError | null => {
    const entry = failures.find((candidate) => candidate.dependency === dependency);
    if (!entry || entry.failures <= 0) {
      return null;
    }
    entry.failures -= 1;
    const message = entry.message ?? defaultFailureMessage(dependency);
    return new NotificationHealthError(dependency, message);
  };

  const request = async <T>(
    apiUrl: string,
    path: string,
    dependency: NotificationHealthDependency,
  ): Promise<T> => {
    const injected = consumeFailure(dependency);
    if (injected) {
      throw injected;
    }

    const response = await fetchImpl(`${apiUrl}${path}`);
    if (!response.ok) {
      throw new NotificationHealthError(
        dependency,
        `Failed to fetch ${path}: ${response.status}`,
        response.status,
      );
    }
    return response.json() as Promise<T>;
  };

  return {
    failures,
    fetchScheduleStats(apiUrl) {
      return request<ScheduleStatsResponse>(apiUrl, '/api/schedule/stats', 'scheduler');
    },
    fetchHealth(apiUrl) {
      return request<HealthResponse>(apiUrl, '/health', 'rpc');
    },
    fetchAnalytics(apiUrl) {
      return request<NotificationAnalyticsSnapshot>(apiUrl, '/api/analytics', 'database');
    },
    reset() {
      for (const entry of failures) {
        entry.failures = 0;
      }
    },
  };
}

const defaultClient = createNotificationHealthClient();

export async function fetchScheduleStats(apiUrl: string): Promise<ScheduleStatsResponse> {
  return defaultClient.fetchScheduleStats(apiUrl);
}

export async function fetchHealth(apiUrl: string): Promise<HealthResponse> {
  return defaultClient.fetchHealth(apiUrl);
}

export async function fetchAnalytics(apiUrl: string): Promise<NotificationAnalyticsSnapshot> {
  return defaultClient.fetchAnalytics(apiUrl);
}

export function resolveNotificationHealthUrl(eventsApiUrl: string): string {
  try {
    const url = new URL(eventsApiUrl);
    url.pathname = '';
    url.search = '';
    return url.toString();
  } catch {
    return 'http://localhost:8787';
  }
}
