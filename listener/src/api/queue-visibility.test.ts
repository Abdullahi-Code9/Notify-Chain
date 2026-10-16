/**
 * Integration tests for queue visibility API endpoints (GitHub issue #490).
 *
 * Covers three acceptance criteria:
 *   1. Queue statistics  — GET /api/schedule/stats (already existed; verified here)
 *   2. Pending jobs list — GET /api/schedule/queue  (new)
 *   3. Queue health      — GET /api/notifications/health (already existed; verified here)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationAPI } from '../services/notification-api';
import { NotificationHealthMonitor } from '../services/notification-health-monitor';
import { createEventsServer, EventsServerOptions } from './events-server';
import { NotificationType, NotificationStatus } from '../types/scheduled-notification';
import path from 'path';
import fs from 'fs/promises';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PORT = 38090;
const TEST_DB_PATH = path.join(__dirname, '../../test-data/test-queue-visibility.db');

async function makeRequest(
  server: http.Server,
  method: string,
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const body =
              parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
            resolve({ status: res.statusCode!, body });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Queue Visibility API (issue #490)', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let notificationAPI: NotificationAPI;
  let server: http.Server;

  beforeEach(async () => {
    // Clean up any leftover test database from a previous run.
    try {
      await fs.unlink(TEST_DB_PATH);
    } catch {
      /* ignore */
    }

    db = new Database(TEST_DB_PATH);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
    notificationAPI = new NotificationAPI(repository);

    const options: EventsServerOptions = {
      port: TEST_PORT,
      stellarRpcUrl: 'https://soroban-testnet.stellar.org',
      notificationAPI,
    };

    server = createEventsServer(options);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await db.close();
    try {
      await fs.unlink(TEST_DB_PATH);
    } catch {
      /* ignore */
    }
  });

  // ── Criterion 1: Queue statistics ────────────────────────────────────────

  describe('GET /api/schedule/stats — queue statistics', () => {
    it('returns counts for pending, processing, completed, failed, and overdue', async () => {
      // Seed: one pending, one completed
      await repository.create({
        payload: { test: 'pending' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() + 60_000),
        maxRetries: 3,
      });

      const completedId = await repository.create({
        payload: { test: 'completed' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 3,
      });
      await repository.markAsCompleted(completedId);

      const { status, body } = await makeRequest(server, 'GET', '/api/schedule/stats');

      expect(status).toBe(200);
      const stats = body as Record<string, number>;
      // Must include all required count fields.
      expect(stats).toHaveProperty('pending');
      expect(stats).toHaveProperty('processing');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('overdue');
      // Spot-check the values match what we seeded.
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(1);
    });

    it('returns 503 when the scheduler is not enabled', async () => {
      // Rebuild the server without a notificationAPI.
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );

      server = createEventsServer({
        port: TEST_PORT,
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        notificationAPI: null,
      });
      await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));

      const { status } = await makeRequest(server, 'GET', '/api/schedule/stats');
      expect(status).toBe(503);
    });
  });

  // ── Criterion 2: Pending jobs list ───────────────────────────────────────

  describe('GET /api/schedule/queue — pending jobs', () => {
    it('returns an empty list when no notifications are pending', async () => {
      const { status, body } = await makeRequest(server, 'GET', '/api/schedule/queue');

      expect(status).toBe(200);
      const payload = body as { count: number; jobs: unknown[] };
      expect(payload.count).toBe(0);
      expect(payload.jobs).toEqual([]);
    });

    it('returns pending jobs with required fields: id, notificationType, createdAt, executeAt, priority, retryCount', async () => {
      await repository.create({
        payload: { msg: 'hello' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() + 120_000),
        maxRetries: 3,
        priority: 5,
      });

      const { status, body } = await makeRequest(server, 'GET', '/api/schedule/queue');

      expect(status).toBe(200);
      const payload = body as { count: number; jobs: Record<string, unknown>[] };
      expect(payload.count).toBe(1);
      expect(payload.jobs).toHaveLength(1);

      const job = payload.jobs[0];
      // All minimum required fields must be present.
      expect(job).toHaveProperty('id');
      expect(typeof job.id).toBe('number');
      expect(job).toHaveProperty('notificationType', NotificationType.DISCORD);
      expect(job).toHaveProperty('createdAt');
      expect(typeof job.createdAt).toBe('string');
      expect(job).toHaveProperty('executeAt');
      expect(typeof job.executeAt).toBe('string');
      expect(job).toHaveProperty('priority');
      expect(typeof job.priority).toBe('number');
      expect(job).toHaveProperty('retryCount');
      expect(typeof job.retryCount).toBe('number');
    });

    it('does not return completed or failed notifications', async () => {
      // Create and complete one notification.
      const completedId = await repository.create({
        payload: { msg: 'done' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 1,
      });
      await repository.markAsCompleted(completedId);

      // Create and exhaust a failed one.
      const failedId = await repository.create({
        payload: { msg: 'fail' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 1,
      });
      await repository.markAsFailedOrRetry(failedId, new Error('oops'), 0, 1);

      // Add one pending notification.
      await repository.create({
        payload: { msg: 'waiting' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() + 60_000),
        maxRetries: 3,
      });

      const { status, body } = await makeRequest(server, 'GET', '/api/schedule/queue');

      expect(status).toBe(200);
      const payload = body as { count: number; jobs: Record<string, unknown>[] };
      // Only the PENDING notification should appear.
      expect(payload.count).toBe(1);
      expect(payload.jobs).toHaveLength(1);
    });

    it('respects the ?limit= query parameter', async () => {
      // Create 5 pending notifications.
      for (let i = 0; i < 5; i++) {
        await repository.create({
          payload: { seq: i },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://example.com/hook',
          executeAt: new Date(Date.now() + 60_000 + i * 1000),
          maxRetries: 3,
        });
      }

      const { status, body } = await makeRequest(server, 'GET', '/api/schedule/queue?limit=3');

      expect(status).toBe(200);
      const payload = body as { count: number; jobs: unknown[] };
      expect(payload.count).toBe(3);
      expect(payload.jobs).toHaveLength(3);
    });

    it('returns 503 when the scheduler is not enabled', async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );

      server = createEventsServer({
        port: TEST_PORT,
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        notificationAPI: null,
      });
      await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));

      const { status } = await makeRequest(server, 'GET', '/api/schedule/queue');
      expect(status).toBe(503);
    });

    it('is accessible via the /api/v1/ version alias', async () => {
      await repository.create({
        payload: { msg: 'v1-test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() + 60_000),
        maxRetries: 3,
      });

      const { status, body } = await makeRequest(server, 'GET', '/api/v1/schedule/queue');

      expect(status).toBe(200);
      const payload = body as { count: number; jobs: unknown[] };
      expect(payload.count).toBe(1);
    });
  });

  // ── Criterion 3: Queue health ─────────────────────────────────────────────

  describe('GET /api/notifications/health — queue health signal', () => {
    it('returns 503 with an error message when the health monitor is not configured', async () => {
      // The server was created without a healthMonitor option — the default.
      const { status, body } = await makeRequest(server, 'GET', '/api/notifications/health');

      expect(status).toBe(503);
      const payload = body as { error: string };
      expect(payload.error).toBeTruthy();
    });

    it('returns 200 with a health report when the monitor is configured and healthy', async () => {
      // Rebuild the server with a health monitor that has already run its first check.
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );

      const monitor = new NotificationHealthMonitor(null, null, {
        intervalMs: 60_000, // don't auto-run after the initial check
        repository,
      });
      monitor.start();

      server = createEventsServer({
        port: TEST_PORT,
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        notificationAPI,
        healthMonitor: monitor,
      });
      await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));

      const { status, body } = await makeRequest(server, 'GET', '/api/notifications/health');

      monitor.stop();

      expect(status).toBe(200);
      const report = body as Record<string, unknown>;
      // Must expose overall status and a queue sub-section for health signal.
      expect(report).toHaveProperty('status');
      expect(['healthy', 'degraded', 'unhealthy']).toContain(report.status);
      expect(report).toHaveProperty('queue');
      const queue = report.queue as Record<string, unknown>;
      expect(queue).toHaveProperty('status');
      expect(queue).toHaveProperty('pendingJobs');
      expect(typeof queue.pendingJobs).toBe('number');
    });

    it('reports deadLetterQueueDepth in the queue sub-section', async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );

      const monitor = new NotificationHealthMonitor(null, null, {
        intervalMs: 60_000,
        repository,
      });
      monitor.start();

      server = createEventsServer({
        port: TEST_PORT,
        stellarRpcUrl: 'https://soroban-testnet.stellar.org',
        notificationAPI,
        healthMonitor: monitor,
      });
      await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));

      const { status, body } = await makeRequest(server, 'GET', '/api/notifications/health');

      monitor.stop();

      expect(status).toBe(200);
      const report = body as Record<string, unknown>;
      const queue = report.queue as Record<string, unknown>;
      expect(queue).toHaveProperty('deadLetterQueueDepth');
      expect(typeof queue.deadLetterQueueDepth).toBe('number');
    });
  });
});
