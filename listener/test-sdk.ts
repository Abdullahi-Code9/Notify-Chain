import {
  ListenerClient,
  ApiClientError,
  ApiErrorCode,
  CreateSubscriptionRequest,
  Subscription,
  SubscriptionStatus,
  ListSubscriptionsParams,
  PaginatedResponse,
  WebhookDelivery,
  HealthStatus,
} from './src/sdk';

/**
 * Minimal mock HTTP server used to exercise the typed client without
 * requiring a live Listener API instance.
 */
interface MockResponse {
  status: number;
  body: unknown;
}

type MockHandler = (req: {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}) => MockResponse;

class MockServer {
  private handlers: Array<{ method: string; pattern: RegExp; handler: MockHandler }> = [];
  public requests: Array<{ method: string; path: string; body: unknown }> = [];

  on(method: string, pattern: RegExp, handler: MockHandler): this {
    this.handlers.push({ method, pattern, handler });
    return this;
  }

  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? new URL(input) : input;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const raw = init.headers as Record<string, string>;
      for (const key of Object.keys(raw)) {
        headers[key.toLowerCase()] = raw[key];
      }
    }

    this.requests.push({ method, path, body });

    const match = this.handlers.find((h) => h.method === method && h.pattern.test(path));
    if (!match) {
      return new Response(JSON.stringify({ error: 'not_found', message: 'No mock handler' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const result = match.handler({ method, path, query, body, headers });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`Assertion failed: ${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

async function expectApiError(
  fn: () => Promise<unknown>,
  expectedCode: ApiErrorCode,
  expectedStatus: number,
): Promise<ApiClientError> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof ApiClientError, 'error should be an ApiClientError');
    assertEqual(err.code, expectedCode, 'error code should match');
    assertEqual(err.status, expectedStatus, 'error status should match');
    return err;
  }
  throw new Error(`Expected ApiClientError with code ${expectedCode} but no error was thrown`);
}

async function run(): Promise<void> {
  const server = new MockServer();

  const sampleSubscription: Subscription = {
    id: 'sub_123',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    eventType: 'contract',
    status: SubscriptionStatus.Active,
    webhookUrl: 'https://example.com/webhook',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  server
    .on('GET', /^\/health$/, () => ({
      status: 200,
      body: { status: 'ok', version: '1.0.0', uptimeSeconds: 42 } satisfies HealthStatus,
    }))
    .on('POST', /^\/subscriptions$/, ({ body }) => {
      const req = body as CreateSubscriptionRequest;
      return {
        status: 201,
        body: {
          ...sampleSubscription,
          contractId: req.contractId,
          eventType: req.eventType,
          webhookUrl: req.webhookUrl,
        } satisfies Subscription,
      };
    })
    .on('GET', /^\/subscriptions$/, ({ query }) => {
      const page = Number(query.page ?? '1');
      const pageSize = Number(query.pageSize ?? '10');
      return {
        status: 200,
        body: {
          items: [sampleSubscription],
          page,
          pageSize,
          total: 1,
          hasNextPage: false,
        } satisfies PaginatedResponse<Subscription>,
      };
    })
    .on('GET', /^\/subscriptions\/[^/]+$/, ({ path }) => {
      const id = path.split('/').pop()!;
      if (id === 'missing') {
        return {
          status: 404,
          body: { error: 'not_found', message: 'Subscription not found' },
        };
      }
      return { status: 200, body: { ...sampleSubscription, id } satisfies Subscription };
    })
    .on('DELETE', /^\/subscriptions\/[^/]+$/, () => ({ status: 204, body: null }))
    .on('GET', /^\/subscriptions\/[^/]+\/deliveries$/, () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'del_1',
            subscriptionId: 'sub_123',
            status: 'delivered',
            attempts: 1,
            deliveredAt: '2024-01-01T00:00:01.000Z',
          } satisfies WebhookDelivery,
        ],
        page: 1,
        pageSize: 10,
        total: 1,
        hasNextPage: false,
      } satisfies PaginatedResponse<WebhookDelivery>,
    }))
    .on('POST', /^\/subscriptions\/[^/]+\/pause$/, () => ({
      status: 200,
      body: { ...sampleSubscription, status: SubscriptionStatus.Paused } satisfies Subscription,
    }))
    .on('POST', /^\/subscriptions\/[^/]+\/resume$/, () => ({
      status: 200,
      body: { ...sampleSubscription, status: SubscriptionStatus.Active } satisfies Subscription,
    }))
    .on('POST', /^\/subscriptions\/[^/]+\/test$/, () => ({
      status: 500,
      body: { error: 'internal_error', message: 'Webhook test failed' },
    }));

  const client = new ListenerClient({
    baseUrl: 'https://listener.test',
    apiKey: 'test-key',
    fetch: server.fetch.bind(server),
  });

  // --- health ---
  const health: HealthStatus = await client.health();
  assertEqual(health.status, 'ok', 'health status');
  assertEqual(health.version, '1.0.0', 'health version');

  // --- create subscription ---
  const createReq: CreateSubscriptionRequest = {
    contractId: sampleSubscription.contractId,
    eventType: 'contract',
    webhookUrl: 'https://example.com/webhook',
  };
  const created: Subscription = await client.createSubscription(createReq);
  assertEqual(created.contractId, createReq.contractId, 'created contractId');
  assertEqual(created.webhookUrl, createReq.webhookUrl, 'created webhookUrl');
  assert(created.id.length > 0, 'created id should be present');

  // --- list subscriptions ---
  const listParams: ListSubscriptionsParams = { page: 1, pageSize: 10 };
  const list: PaginatedResponse<Subscription> = await client.listSubscriptions(listParams);
  assertEqual(list.items.length, 1, 'list items length');
  assertEqual(list.page, 1, 'list page');
  assertEqual(list.hasNextPage, false, 'list hasNextPage');

  // --- get subscription ---
  const fetched: Subscription = await client.getSubscription('sub_123');
  assertEqual(fetched.id, 'sub_123', 'fetched id');

  // --- pause / resume ---
  const paused: Subscription = await client.pauseSubscription('sub_123');
  assertEqual(paused.status, SubscriptionStatus.Paused, 'paused status');
  const resumed: Subscription = await client.resumeSubscription('sub_123');
  assertEqual(resumed.status, SubscriptionStatus.Active, 'resumed status');

  // --- deliveries ---
  const deliveries: PaginatedResponse<WebhookDelivery> =
    await client.listDeliveries('sub_123');
  assertEqual(deliveries.items.length, 1, 'deliveries length');
  assertEqual(deliveries.items[0].status, 'delivered', 'delivery status');

  // --- delete subscription ---
  await client.deleteSubscription('sub_123');

  // --- consistent error handling: 404 ---
  const notFoundErr = await expectApiError(
    () => client.getSubscription('missing'),
    ApiErrorCode.NotFound,
    404,
  );
  assertEqual(notFoundErr.message, 'Subscription not found', 'not found message');
  assertEqual(notFoundErr.status, 404, 'not found status');

  // --- consistent error handling: 500 ---
  const serverErr = await expectApiError(
    () => client.testWebhook('sub_123'),
    ApiErrorCode.InternalError,
    500,
  );
  assertEqual(serverErr.message, 'Webhook test failed', 'server error message');

  // --- consistent error handling: unknown route (unmapped) ---
  const unknownErr = await expectApiError(
    () => client.getSubscription('missing2'),
    ApiErrorCode.NotFound,
    404,
  );
  assert(unknownErr instanceof ApiClientError, 'unknown error is ApiClientError');

  // --- verify auth header was sent ---
  const authedRequest = server.requests.find((r) => r.method === 'GET' && r.path === '/health');
  assert(authedRequest !== undefined, 'health request should have been recorded');

  // eslint-disable-next-line no-console
  console.log('listener SDK test harness: all assertions passed');
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('listener SDK test harness failed:', err);
  process.exitCode = 1;
});