/**
 * Notification destination API client (issue #1107).
 *
 * Endpoints (served by the listener's events API):
 *   GET  /api/destinations                 → { destinations: NotificationDestination[] }
 *   PUT  /api/destinations/:id             → NotificationDestination
 *   POST /api/destinations/:id/test        → TestNotificationResult
 *
 * Errors are normalized into {@link DestinationApiError} so the page can
 * surface field-level validation messages returned by the server.
 */
import type {
  DestinationUpdate,
  DestinationValidationErrors,
  NotificationDestination,
  TestNotificationResult,
} from '../types/destination';

const BASE_URL =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_EVENTS_API_URL) ||
  'http://localhost:8787';

export class DestinationApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly fieldErrors: DestinationValidationErrors = {},
  ) {
    super(message);
    this.name = 'DestinationApiError';
  }
}

export interface DestinationsClient {
  list(): Promise<NotificationDestination[]>;
  update(id: string, update: DestinationUpdate): Promise<NotificationDestination>;
  sendTest(id: string): Promise<TestNotificationResult>;
}

async function parseError(response: Response): Promise<DestinationApiError> {
  let message = `Request failed with HTTP ${response.status}`;
  let fieldErrors: DestinationValidationErrors = {};
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string };
      message?: string;
      fieldErrors?: DestinationValidationErrors;
    };
    const bodyMessage =
      typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    if (bodyMessage) message = bodyMessage;
    if (body.fieldErrors && typeof body.fieldErrors === 'object') fieldErrors = body.fieldErrors;
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  if (response.status === 404) {
    message = 'Destination configuration API is not available on the listener (HTTP 404).';
  }
  return new DestinationApiError(message, response.status, fieldErrors);
}

export function createHttpDestinationsClient(
  baseUrl: string = BASE_URL,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): DestinationsClient {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
    } catch {
      throw new DestinationApiError('Unable to reach the listener API. Check that it is running.');
    }
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  };

  return {
    async list() {
      const body = await request<{ destinations: NotificationDestination[] }>('/api/destinations');
      return Array.isArray(body.destinations) ? body.destinations : [];
    },
    update(id, update) {
      return request<NotificationDestination>(`/api/destinations/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(update),
      });
    },
    sendTest(id) {
      return request<TestNotificationResult>(
        `/api/destinations/${encodeURIComponent(id)}/test`,
        { method: 'POST', body: JSON.stringify({ test: true }) },
      );
    },
  };
}

export const defaultDestinationsClient = createHttpDestinationsClient();
