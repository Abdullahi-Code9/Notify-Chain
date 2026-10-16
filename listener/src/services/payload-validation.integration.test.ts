/**
 * Integration tests for POST /api/schedule — payload size validation.
 *
 * Covers:
 *   - Normal payload (under limit) → 201 Created
 *   - Edge case payload (exactly at limit) → 201 Created
 *   - Oversized payload (exceeds limit) → 413 Payload Too Large
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import { createEventsServer } from '../api/events-server';
import { NotificationAPI } from './notification-api';
import { NotificationType } from '../types/scheduled-notification';
import { DEFAULT_MAX_PAYLOAD_SIZE_BYTES } from '../utils/payload-size-validator';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../store/event-registry', () => ({
  eventRegistry: { getEvents: jest.fn(() => []), count: jest.fn(() => 0) },
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: { get: jest.fn(), update: jest.fn(), isCategoryEnabled: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a payload whose JSON representation is exactly `targetBytes` bytes
 * *after* scheduleNotification() stamps it with the protocol version (see
 * ensureNotificationVersion) — the fixture already carries `version` so the
 * stamping step is a no-op and doesn't grow the payload past the boundary.
 */
function payloadOfExactBytes(targetBytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(JSON.stringify({ data: '', version: 1 }), 'utf8');
  const fillLength = targetBytes - overhead;
  if (fillLength < 0) throw new Error(`targetBytes ${targetBytes} too small`);
  return { data: 'x'.repeat(fillLength), version: 1 };
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function postSchedule(
  server: http.Server,
  body: object
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/api/schedule',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: { raw: data } });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function startServer(notificationAPI: NotificationAPI): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = createEventsServer({
      port: 0,
      stellarRpcUrl: 'https://test',
      notificationAPI,
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Mock repository — always resolves create() with id 1
// ---------------------------------------------------------------------------

const mockCreate = jest.fn<() => Promise<number>>().mockResolvedValue(1);
const mockRepository = {
  create: mockCreate,
  cancel: jest.fn(),
  getById: jest.fn(),
  getStats: jest.fn(),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/schedule – payload size validation (integration)', () => {
  let server: http.Server;
  let notificationAPI: NotificationAPI;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Use a small, known limit so tests complete quickly.
    const limit = 500; // 500 bytes
    notificationAPI = new NotificationAPI(mockRepository, limit);
    server = await startServer(notificationAPI);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('returns 201 for a normal payload that is well under the limit', async () => {
    const { status, body } = await postSchedule(server, {
      payload: { message: 'hello', recipient: 'alice' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });

    expect(status).toBe(201);
    expect(body).toHaveProperty('id', 1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns 201 for a payload at exactly the limit', async () => {
    const limit = notificationAPI.maxPayloadSizeBytes;
    const payload = payloadOfExactBytes(limit);
    const byteLength = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    expect(byteLength).toBe(limit);

    const { status, body } = await postSchedule(server, {
      payload,
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });

    expect(status).toBe(201);
    expect(body).toHaveProperty('id');
  });

  it('returns 413 for a payload that exceeds the limit', async () => {
    const oversized = { data: 'x'.repeat(1000) }; // well over 500 bytes

    const { status, body } = await postSchedule(server, {
      payload: oversized,
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });

    expect(status).toBe(413);
    expect(typeof body.error).toBe('string');
    expect((body.error as string).toLowerCase()).toContain('too large');
    // Repository must NOT be called when the payload is oversized.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 413 for a drastically oversized payload', async () => {
    const oversized = { data: 'a'.repeat(100_000) };

    const { status } = await postSchedule(server, {
      payload: oversized,
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });

    expect(status).toBe(413);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still returns 400 for missing required fields (existing validation)', async () => {
    const { status } = await postSchedule(server, {
      // missing executeAt, targetRecipient
      payload: { msg: 'incomplete' },
    });

    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Integration against the real default 64 KB limit
// ---------------------------------------------------------------------------
describe('POST /api/schedule – default 64 KB limit (integration)', () => {
  let server: http.Server;

  beforeEach(async () => {
    jest.clearAllMocks();
    const api = new NotificationAPI(mockRepository); // default 64 KB
    server = await startServer(api);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('accepts a payload well under 64 KB', async () => {
    const { status } = await postSchedule(server, {
      payload: { message: 'small payload' },
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });
    expect(status).toBe(201);
  });

  it('rejects a payload over 64 KB with 413', async () => {
    const oversized = { data: 'z'.repeat(70_000) };
    const { status, body } = await postSchedule(server, {
      payload: oversized,
      targetRecipient: 'https://discord.com/webhook',
      executeAt: futureIso(),
    });

    expect(status).toBe(413);
    expect(body.error).toContain(`${DEFAULT_MAX_PAYLOAD_SIZE_BYTES}`);
  });
});
