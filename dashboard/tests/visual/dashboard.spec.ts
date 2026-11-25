import { expect, test, type Page } from '@playwright/test';

const FIXED_TIME = new Date('2026-07-01T12:00:00.000Z');
const API_ORIGIN = 'http://localhost:8787';

const events = [
  {
    eventId: 'evt-1001',
    contractAddress: 'CCONTRACT000000000000000000000000000000000000000000000000',
    eventName: 'notification_scheduled',
    ledger: 120045,
    type: 'contract',
    topic: ['notification_scheduled'],
    value: 'Payment reminder',
    txHash: 'a1b2c3d4e5f60708',
    receivedAt: FIXED_TIME.getTime() - 60_000,
  },
  {
    eventId: 'evt-1002',
    contractAddress: 'CCONTRACT000000000000000000000000000000000000000000000000',
    eventName: 'notification_expired',
    ledger: 120044,
    type: 'contract',
    topic: ['notification_expired'],
    value: 'Subscription renewal',
    txHash: 'b2c3d4e5f60708a1',
    receivedAt: FIXED_TIME.getTime() - 120_000,
  },
];

const webhookDeliveries = [
  {
    id: 'delivery-1',
    eventType: 'payment.completed',
    targetUrl: 'https://hooks.example.test/payments',
    httpStatus: 200,
    errorPayload: null,
    status: 'success',
    latencyMs: 124,
    attemptedAt: FIXED_TIME.getTime() - 5 * 60_000,
    attemptNumber: 1,
  },
  {
    id: 'delivery-2',
    eventType: 'subscription.updated',
    targetUrl: 'https://hooks.example.test/subscriptions',
    httpStatus: 503,
    errorPayload: 'Service unavailable',
    status: 'failed',
    latencyMs: null,
    attemptedAt: FIXED_TIME.getTime() - 10 * 60_000,
    attemptNumber: 2,
  },
  {
    id: 'delivery-3',
    eventType: 'payment.completed',
    targetUrl: 'https://hooks.example.test/payments',
    httpStatus: 201,
    errorPayload: null,
    status: 'success',
    latencyMs: 86,
    attemptedAt: FIXED_TIME.getTime() - 15 * 60_000,
    attemptNumber: 1,
  },
];

async function installStableDashboardData(page: Page) {
  await page.clock.install({ time: FIXED_TIME });
  await page.addInitScript(() => {
    localStorage.setItem('notify-chain-theme', 'dark');
  });

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname.replace(/\/+/g, '/');
    let body: unknown;

    switch (pathname) {
      case '/api/events':
        body = { events };
        break;
      case '/api/status':
        body = { timestamp: FIXED_TIME.toISOString(), contracts: [] };
        break;
      case '/api/indexing/health':
        body = {
          status: 'synced',
          timestamp: FIXED_TIME.toISOString(),
          indexedLedger: 120045,
          networkTipLedger: 120045,
          ledgerLag: 0,
          processingDelayMs: 42,
          lastIngestedAt: FIXED_TIME.toISOString(),
        };
        break;
      case '/api/schedule/stats':
        body = { pending: 8, processing: 2, completed: 142, failed: 3, overdue: 1 };
        break;
      case '/health':
        body = {
          status: 'ok',
          timestamp: FIXED_TIME.toISOString(),
          services: {
            stellarRpc: { status: 'ok', latencyMs: 45 },
            discord: { status: 'ok', latencyMs: 18 },
            eventRegistry: { status: 'ok', eventCount: 12 },
          },
        };
        break;
      case '/api/analytics':
        body = {
          totalRecorded: 150,
          windowStart: FIXED_TIME.getTime() - 86_400_000,
          windowEnd: FIXED_TIME.getTime(),
          overall: {
            total: 150,
            success: 142,
            failure: 3,
            retry: 4,
            skipped: 1,
            successRate: 0.9467,
            averageDurationMs: 120,
          },
          byType: [],
          byContract: [],
          hourlyBuckets: [],
          errorBreakdown: {},
        };
        break;
      case '/api/webhooks/deliveries':
        body = { deliveries: webhookDeliveries, total: webhookDeliveries.length };
        break;
      default:
        body = {};
    }

    await route.fulfill({ json: body });
  });
}

test.beforeEach(async ({ page }) => {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`[browser] ${message.text()}`);
    }
  });
  await installStableDashboardData(page);
});

test('event explorer baseline', async ({ page }) => {
  await page.goto('/#explorer');
  await expect(page.getByRole('heading', { name: 'Smart Contract Event Log' })).toBeVisible();
  await expect(page.getByText('Showing 1–2 of 2 events')).toBeVisible();
  await expect(page).toHaveScreenshot('event-explorer.png', { fullPage: true });
});

test('webhook performance baseline', async ({ page }) => {
  await page.goto('/#webhooks');
  await expect(page.getByRole('heading', { name: 'Delivery Performance' })).toBeVisible();
  await expect(page).toHaveScreenshot('webhook-performance.png', { fullPage: true });
});

test('notification search baseline', async ({ page }) => {
  await page.goto('/#search');
  await expect(page.getByRole('heading', { name: 'Notification Search' })).toBeVisible();
  await expect(page).toHaveScreenshot('notification-search.png', { fullPage: true });
});
