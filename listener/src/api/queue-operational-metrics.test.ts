/**
 * Integration and unit tests for Notification Queue Operational Metrics (Issue #797).
 *
 * Verifies the 5 core operational metrics:
 *   1. Pending notifications
 *   2. Processing notifications
 *   3. Successful deliveries
 *   4. Failed deliveries
 *   5. Retry attempts
 *
 * Acceptance Criteria:
 *   - Metrics are available through the existing observability mechanism.
 *   - Metric names and meanings are verified.
 *   - Verified across repository, API endpoints, and health monitoring report.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationAPI } from '../services/notification-api';
import { NotificationHealthMonitor } from '../services/notification-health-monitor';
import { createEventsServer, EventsServerOptions } from './events-server';
import { NotificationType, NotificationStatus } from '../types/scheduled-notification';
import { QueueOperationalMetrics } from '../services/notification-stats-cache';

async function makeRequest(
  server: http.Server,
  method: string,
  pathname: string,
): Promise<{ status: number; envelope: { success: boolean; data?: any; error?: any }; body: any }> {
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
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const data =
              parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
            resolve({ status: res.statusCode!, envelope: parsed, body: data });
          } catch {
            resolve({ status: res.statusCode!, envelope: { success: false }, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let testDbIndex = 0;

describe('Notification Queue Operational Metrics (#797)', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let notificationAPI: NotificationAPI;
  let server: http.Server;
  let testDbPath: string;

  beforeEach(async () => {
    testDbIndex++;
    testDbPath = path.join(
      __dirname,
      `../../test-data/test-queue-operational-metrics-${Date.now()}-${testDbIndex}.db`,
    );
    try {
      await fs.unlink(testDbPath);
    } catch {
      // ignore
    }

    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
    notificationAPI = new NotificationAPI(repository);

    const options: EventsServerOptions = {
      port: 0,
      stellarRpcUrl: 'https://soroban-testnet.stellar.org',
      notificationAPI,
    };

    server = createEventsServer(options);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (db) {
      await db.close();
    }
    try {
      await fs.unlink(testDbPath);
    } catch {
      // ignore
    }
  });

  describe('Repository & Service Layer Metrics', () => {
    it('returns zero for all metrics when queue is empty', async () => {
      const metrics: QueueOperationalMetrics = await repository.getQueueOperationalMetrics();

      expect(metrics).toEqual({
        pendingNotifications: 0,
        processingNotifications: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0,
        retryAttempts: 0,
      });
    });

    it('correctly tracks pending notifications', async () => {
      await repository.create({
        payload: { event: 'user_signup' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://webhook.site/test',
        executeAt: new Date(Date.now() + 60_000),
        maxRetries: 3,
      });

      await repository.create({
        payload: { event: 'payment_received' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://discord.com/api/webhooks/test',
        executeAt: new Date(Date.now() + 120_000),
        maxRetries: 3,
      });

      const metrics = await repository.getQueueOperationalMetrics();
      expect(metrics.pendingNotifications).toBe(2);
      expect(metrics.processingNotifications).toBe(0);
      expect(metrics.successfulDeliveries).toBe(0);
      expect(metrics.failedDeliveries).toBe(0);
      expect(metrics.retryAttempts).toBe(0);
    });

    it('correctly tracks processing notifications', async () => {
      const id = await repository.create({
        payload: { event: 'job_started' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://webhook.site/test',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 3,
      });

      // Fetch and lock to transition to PROCESSING status
      const locked = await repository.fetchAndLockPendingNotifications('worker-1', 60_000, 1);
      expect(locked).toHaveLength(1);

      const metrics = await repository.getQueueOperationalMetrics();
      expect(metrics.pendingNotifications).toBe(0);
      expect(metrics.processingNotifications).toBe(1);
    });

    it('correctly tracks successful deliveries', async () => {
      const id = await repository.create({
        payload: { event: 'job_done' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://discord.com/api/webhooks/test',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 3,
      });

      await repository.markAsCompleted(id);

      const metrics = await repository.getQueueOperationalMetrics();
      expect(metrics.pendingNotifications).toBe(0);
      expect(metrics.processingNotifications).toBe(0);
      expect(metrics.successfulDeliveries).toBe(1);
    });

    it('correctly tracks failed deliveries and retry attempts', async () => {
      const id = await repository.create({
        payload: { event: 'failing_job' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://webhook.site/test',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 2,
      });

      // First retry attempt
      await repository.markAsFailedOrRetry(id, new Error('Temporary 503'), 0, 2);
      await repository.logExecution({
        scheduledNotificationId: id,
        executionAttempt: 1,
        executionTime: new Date(),
        status: 'RETRY',
        errorMessage: 'Temporary 503',
      });

      let metrics = await repository.getQueueOperationalMetrics();
      expect(metrics.pendingNotifications).toBe(1); // returned to pending for retry
      expect(metrics.retryAttempts).toBe(1);
      expect(metrics.failedDeliveries).toBe(0);

      // Second attempt exhausts retries -> FAILED
      await repository.markAsFailedOrRetry(id, new Error('Permanent failure'), 1, 2);
      await repository.logExecution({
        scheduledNotificationId: id,
        executionAttempt: 2,
        executionTime: new Date(),
        status: 'FAILED',
        errorMessage: 'Permanent failure',
      });

      metrics = await repository.getQueueOperationalMetrics();
      expect(metrics.pendingNotifications).toBe(0);
      expect(metrics.failedDeliveries).toBe(1);
      expect(metrics.retryAttempts).toBe(1);
    });

    it('NotificationAPI proxies operational metrics correctly', async () => {
      const metrics = await notificationAPI.getQueueOperationalMetrics();
      expect(metrics).toHaveProperty('pendingNotifications');
      expect(metrics).toHaveProperty('processingNotifications');
      expect(metrics).toHaveProperty('successfulDeliveries');
      expect(metrics).toHaveProperty('failedDeliveries');
      expect(metrics).toHaveProperty('retryAttempts');
    });
  });

  describe('Observability API Endpoints', () => {
    describe('GET /api/schedule/queue/metrics — Dedicated Endpoint', () => {
      it('returns 200 with operational metrics in standardized response', async () => {
        // Seed 1 pending, 1 completed
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

        const { status, envelope, body } = await makeRequest(
          server,
          'GET',
          '/api/schedule/queue/metrics',
        );

        expect(status).toBe(200);
        expect(envelope.success).toBe(true);
        expect(body.pendingNotifications).toBe(1);
        expect(body.processingNotifications).toBe(0);
        expect(body.successfulDeliveries).toBe(1);
        expect(body.failedDeliveries).toBe(0);
        expect(body.retryAttempts).toBe(0);
      });

      it('supports aliases /api/schedule/queue-metrics and /api/notifications/queue-metrics', async () => {
        const res1 = await makeRequest(server, 'GET', '/api/schedule/queue-metrics');
        expect(res1.status).toBe(200);
        expect(res1.body).toHaveProperty('pendingNotifications');

        const res2 = await makeRequest(server, 'GET', '/api/notifications/queue-metrics');
        expect(res2.status).toBe(200);
        expect(res2.body).toHaveProperty('pendingNotifications');
      });

      it('returns 503 when scheduler is not enabled', async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );

        server = createEventsServer({
          port: 0,
          stellarRpcUrl: 'https://soroban-testnet.stellar.org',
          notificationAPI: null,
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));

        const { status } = await makeRequest(server, 'GET', '/api/schedule/queue/metrics');
        expect(status).toBe(503);
      });
    });

    describe('GET /api/schedule/stats — Enriched Scheduler Stats', () => {
      it('exposes all operational metrics alongside legacy fields for backward compatibility', async () => {
        await repository.create({
          payload: { test: 'pending' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'https://example.com/hook',
          executeAt: new Date(Date.now() + 60_000),
          maxRetries: 3,
        });

        const { status, body } = await makeRequest(server, 'GET', '/api/schedule/stats');

        expect(status).toBe(200);
        // Legacy keys
        expect(body.pending).toBe(1);
        expect(body.processing).toBe(0);
        expect(body.completed).toBe(0);
        expect(body.failed).toBe(0);

        // Operational metrics keys (#797)
        expect(body.pendingNotifications).toBe(1);
        expect(body.processingNotifications).toBe(0);
        expect(body.successfulDeliveries).toBe(0);
        expect(body.failedDeliveries).toBe(0);
        expect(body.retryAttempts).toBe(0);
      });
    });

    describe('GET /api/notifications/health — Health Monitor Observability', () => {
      it('includes operationalMetrics under queue section in health report', async () => {
        // Pre-warm stats in repository
        await repository.create({
          payload: { test: 'health-pending' },
          notificationType: NotificationType.WEBHOOK,
          targetRecipient: 'https://example.com/hook',
          executeAt: new Date(Date.now() + 60_000),
          maxRetries: 3,
        });
        await repository.getStats();

        // Start health monitor wired with repository
        const monitor = new NotificationHealthMonitor(null, null, {
          intervalMs: 60_000,
          repository,
        });
        monitor.start();

        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );

        server = createEventsServer({
          port: 0,
          stellarRpcUrl: 'https://soroban-testnet.stellar.org',
          notificationAPI,
          healthMonitor: monitor,
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));

        const { status, body } = await makeRequest(server, 'GET', '/api/notifications/health');

        monitor.stop();

        expect(status).toBe(200);
        expect(body).toHaveProperty('queue');
        expect(body.queue).toHaveProperty('operationalMetrics');

        const metrics = body.queue.operationalMetrics;
        expect(metrics.pendingNotifications).toBe(1);
        expect(metrics.processingNotifications).toBe(0);
        expect(metrics.successfulDeliveries).toBe(0);
        expect(metrics.failedDeliveries).toBe(0);
        expect(metrics.retryAttempts).toBe(0);
      });
    });
  });
});
