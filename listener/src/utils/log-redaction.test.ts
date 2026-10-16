/**
 * End-to-end log redaction: drives real logging paths and asserts on what the
 * Winston transport actually emits, so a secret can only pass if it would
 * really reach the logs.
 *
 * Sensitive values covered:
 *   API keys, bearer/basic tokens, webhook HMAC secrets & signatures,
 *   Discord/Slack webhook URL tokens, credentials in URLs and query strings,
 *   Stellar secret seeds, passwords, cookies — in log messages, metadata,
 *   nested objects, HTTP headers and Error messages/stacks.
 */
import http from 'http';
import winston from 'winston';
import logger, { configureLogger } from './logger';
import { createEventsServer, EventsServerOptions } from '../api/events-server';
import { computeWebhookSignature } from '../services/webhook-verifier';
import { WebhookDeliveryService } from '../services/webhook-delivery-service';
import * as webhookSender from '../services/webhook-sender';

jest.mock('@stellar/stellar-sdk', () => ({
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    })),
  },
}), { virtual: true });

// ── Fixture secrets (never allowed in output) ───────────────────────────────
const API_KEY = 'nc_live_4f9a1c2e7b3d8e6f0a1b2c3d';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.payload.sig-value';
const WEBHOOK_SECRET = 'whsec_9f8e7d6c5b4a39281706';
const DISCORD_TOKEN = 'Xk2_abcDEF-ghiJKLmnoPQRstuVWXyz0123456789';
const DISCORD_URL = `https://discord.com/api/webhooks/1234567890/${DISCORD_TOKEN}`;
const SLACK_TOKEN = 'zYxWvUtSrQpOnMlKjIhGfEdC';
const SLACK_URL = `https://hooks.slack.com/services/T000/B000/${SLACK_TOKEN}`;
const QUERY_TOKEN = 'qs-token-5e6f7a8b9c';
const URL_PASSWORD = 'hunter2-db-pass';
const STELLAR_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';
const PASSWORD = 'correct-horse-battery-staple';

const ALL_SECRETS = [
  API_KEY, BEARER, WEBHOOK_SECRET, DISCORD_TOKEN, SLACK_TOKEN,
  QUERY_TOKEN, URL_PASSWORD, STELLAR_SEED, PASSWORD,
];

// Public, non-sensitive values that must survive redaction.
const STELLAR_PUBLIC_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// ── Output capture ──────────────────────────────────────────────────────────
let captured: string[] = [];
const spies: jest.SpyInstance[] = [];

const MESSAGE = Symbol.for('message');

/**
 * Captures the fully formatted line the Console transport is about to write
 * (winston's `info[Symbol.for('message')]`), independent of how Jest wires
 * up console/stdout in the current worker.
 */
function capture(): void {
  captured = [];
  spies.push(
    jest
      .spyOn(winston.transports.Console.prototype, 'log')
      .mockImplementation(function (info: any, next?: () => void) {
        captured.push(String(info[MESSAGE] ?? JSON.stringify(info)));
        if (typeof next === 'function') next();
      } as any),
  );
}

function output(): string {
  return captured.join('\n');
}

function expectNoSecrets(text = output()): void {
  for (const secret of ALL_SECRETS) {
    expect(text).not.toContain(secret);
  }
}

beforeAll(() => {
  configureLogger({ level: 'debug', format: 'json' });
});

beforeEach(() => capture());

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

// ── Logger API ──────────────────────────────────────────────────────────────

describe('logger redaction', () => {
  it('redacts sensitive metadata keys at every log level', () => {
    const meta = {
      apiKey: API_KEY,
      password: PASSWORD,
      webhookSecret: WEBHOOK_SECRET,
      secretSeed: STELLAR_SEED,
      requestId: 'req-123',
    };
    logger.debug('debug', meta);
    logger.info('info', meta);
    logger.warn('warn', meta);
    logger.error('error', meta);

    expectNoSecrets();
    expect(output()).toContain('[REDACTED]');
    expect(output()).toContain('req-123');
    expect(captured.length).toBeGreaterThanOrEqual(4);
  });

  it('redacts secrets interpolated into the log message itself', () => {
    logger.info(`Posting notification to ${DISCORD_URL}`);
    logger.info(`Calling https://api.example.com/v1/send?channel=ops&token=${QUERY_TOKEN}`);
    logger.info(`Signing with ${WEBHOOK_SECRET} using Bearer ${BEARER}`);
    logger.info(`Loaded account seed ${STELLAR_SEED}`);

    expectNoSecrets();
    expect(output()).toContain('https://discord.com/api/webhooks/[REDACTED]');
    expect(output()).toContain('channel=ops');
  });

  it('redacts webhook URLs logged under innocuous keys (targetUrl, targetRecipient)', () => {
    logger.info('Delivering', {
      targetUrl: DISCORD_URL,
      targetRecipient: SLACK_URL,
      endpoint: `https://admin:${URL_PASSWORD}@internal.example.com/hook`,
      callback: `https://hooks.example.com/in?api_key=${API_KEY}&id=7`,
    });

    expectNoSecrets();
    expect(output()).toContain('internal.example.com/hook');
    expect(output()).toContain('id=7');
  });

  it('redacts raw HTTP header objects', () => {
    logger.warn('Incoming request', {
      headers: {
        'x-api-key': API_KEY,
        authorization: `Bearer ${BEARER}`,
        'x-webhook-signature': computeWebhookSignature('{}', WEBHOOK_SECRET, '1700000000'),
        cookie: `session=${PASSWORD}`,
        'content-type': 'application/json',
      },
    });

    expectNoSecrets();
    expect(output()).toContain('application/json');
    expect(output()).not.toMatch(/sha256=[0-9a-f]{16,}/);
  });

  it('redacts secrets inside Error messages and stacks', () => {
    const err = new Error(`fetch failed for ${DISCORD_URL} (Basic ${PASSWORD})`);
    logger.error('Delivery failed', { error: err, requestId: 'req-err' });

    expectNoSecrets();
    expect(output()).toContain('fetch failed for');
    expect(output()).toContain('req-err');
  });

  it('redacts deeply nested config blocks while keeping public ids', () => {
    logger.info('Config loaded', {
      config: {
        webhookSecrets: [{ id: 'partner-1', secret: WEBHOOK_SECRET }],
        apiKeys: [{ name: 'ci', key: API_KEY }],
        stellar: { account: STELLAR_PUBLIC_KEY, contract: CONTRACT_ID },
      },
    });

    expectNoSecrets();
    expect(output()).toContain('partner-1');
    expect(output()).toContain(STELLAR_PUBLIC_KEY);
    expect(output()).toContain(CONTRACT_ID);
  });

  it('does not crash on cyclic metadata', () => {
    const cyclic: Record<string, unknown> = { token: API_KEY };
    cyclic.self = cyclic;

    expect(() => logger.info('cyclic', { cyclic })).not.toThrow();
    expectNoSecrets();
    expect(output()).toContain('[Circular]');
  });
});

// ── HTTP server logging paths ───────────────────────────────────────────────

describe('events server logging paths', () => {
  const options: EventsServerOptions = {
    port: 0,
    stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
    contractAddresses: [],
    apiKeys: [{ key: API_KEY, name: 'primary' }],
    webhookSecrets: [{ id: 'partner-1', secret: WEBHOOK_SECRET }],
  };
  let server: http.Server;

  function send(opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string }) {
    return new Promise<number>((resolve, reject) => {
      const { port } = server.address() as { port: number };
      const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  beforeAll((done) => {
    server = createEventsServer(options);
    server.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('API key auth failures never log the presented or configured key', async () => {
    const wrongKey = `${API_KEY}-guess`;
    const status = await send({
      method: 'GET',
      path: `/api/notifications/history?api_key=${QUERY_TOKEN}`,
      headers: { 'X-API-Key': wrongKey, Authorization: `Bearer ${BEARER}` },
    });

    expect(status).toBe(401);
    expect(output()).toContain('API key authentication failed');
    expectNoSecrets();
    expect(output()).not.toContain(wrongKey);
  });

  it('webhook signature failures never log the secret or signature', async () => {
    const body = JSON.stringify({ event: 'x' });
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = computeWebhookSignature(body, `${WEBHOOK_SECRET}-wrong`, ts);
    const status = await send({
      method: 'POST',
      path: '/api/webhooks',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': forged,
        'X-Webhook-Key-Id': 'partner-1',
        'X-Webhook-Timestamp': ts,
      },
      body,
    });

    expect(status).toBe(401);
    expect(output()).toContain('Webhook');
    expectNoSecrets();
    expect(output()).not.toContain(forged.slice('sha256='.length));
  });

  it('successful webhook auth logs the key id but not the signature', async () => {
    const body = JSON.stringify({ event: 'ok' });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = computeWebhookSignature(body, WEBHOOK_SECRET, ts);
    const status = await send({
      method: 'POST',
      path: '/api/webhooks',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Key-Id': 'partner-1',
        'X-Webhook-Timestamp': ts,
      },
      body,
    });

    expect(status).toBe(202);
    expect(output()).toContain('partner-1');
    expectNoSecrets();
    expect(output()).not.toContain(signature.slice('sha256='.length));
  });
});

// ── Outbound delivery logging path ──────────────────────────────────────────

describe('webhook delivery logging path', () => {
  it.each([
    ['success', 200],
    ['server error', 503],
    ['client error', 404],
  ])('does not log the webhook token on %s', async (_label, status) => {
    jest.spyOn(webhookSender, 'sendWebhook').mockResolvedValue({
      ok: status < 300,
      status,
    } as Awaited<ReturnType<typeof webhookSender.sendWebhook>>);

    const service = new WebhookDeliveryService({
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    await service.deliver(DISCORD_URL, { content: 'hi' }, 'req-delivery');

    expect(output()).toContain('req-delivery');
    expectNoSecrets();
  });

  it('does not log the webhook token when the request throws', async () => {
    jest
      .spyOn(webhookSender, 'sendWebhook')
      .mockRejectedValue(new Error(`connect ECONNREFUSED ${DISCORD_URL}`));

    const service = new WebhookDeliveryService();
    await service.deliver(DISCORD_URL, { content: 'hi' }, 'req-throw');

    expectNoSecrets();
  });
});
