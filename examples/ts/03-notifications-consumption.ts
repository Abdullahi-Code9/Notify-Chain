/**
 * Example 03 (TypeScript) — Notification consumption: signed webhooks + polling.
 *
 * Mirrors `../js/03-notifications-consumption.mjs`.
 *
 * Run:
 *   node ts/03-notifications-consumption.ts
 */

import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import {
  createClient,
  computeWebhookSignature,
  verifyWebhookSignature,
  unwrapEnvelope,
  loadConfig,
  extractApiError,
} from './lib/client.ts';
import type { ExampleConfig, ListenerClient, PaginatedHistoryResponse } from './lib/client.ts';

/** Reads a raw request body as a UTF-8 string. */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Returns a header value as a single string (or undefined). */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

interface ReceiverConfig {
  port: number;
  secret: string;
  keyId: string;
  maxAgeSeconds: number;
  requireTimestamp?: boolean;
}

/** HTTP receiver that validates requests with the listener's webhook scheme. */
function startReceiver(config: ReceiverConfig): Promise<Server> {
  const requireTimestamp = config.requireTimestamp ?? true;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const rawBody = await readRawBody(req);
    const signatureHeader = headerValue(req.headers['x-webhook-signature']);
    const sentKeyId = headerValue(req.headers['x-webhook-key-id']);
    const timestampHeader = headerValue(req.headers['x-webhook-timestamp']);

    if (sentKeyId !== config.keyId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown key-id' }));
      return;
    }

    const result = verifyWebhookSignature({
      payload: rawBody,
      signatureHeader,
      secret: config.secret,
      timestampHeader,
      maxAgeSeconds: config.maxAgeSeconds,
      requireTimestamp,
    });

    if (!result.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature', reason: result.reason }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted' }));
  });

  return new Promise((resolve) => {
    server.listen(config.port, '127.0.0.1', () => resolve(server));
  });
}

interface PostSignedResult {
  status: number;
  body: unknown;
}

/** POSTs a payload; `signedBody` is signed, `sentBody` transmitted. */
async function postSigned(
  url: string,
  bodies: { signedBody: string; sentBody: string },
  auth: { secret: string; keyId: string; timestamp: string },
): Promise<PostSignedResult> {
  const signature = computeWebhookSignature(bodies.signedBody, auth.secret, auth.timestamp);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': auth.keyId,
      'X-Webhook-Timestamp': auth.timestamp,
    },
    body: bodies.sentBody,
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

/** Part A — offline verification of the webhook signature scheme. */
async function verifySchemeOffline(config: ExampleConfig): Promise<void> {
  const port = config.receiverPort;
  const url = `http://127.0.0.1:${port}/webhooks`;
  const server = await startReceiver({
    port,
    secret: config.webhookSecret,
    keyId: config.webhookKeyId,
    maxAgeSeconds: config.webhookTimestampMaxAgeSeconds,
  });

  const now = Math.floor(Date.now() / 1000);
  try {
    const event = { event: 'TaskCreated', contractAddress: 'CCEMX6...', data: { id: 42 } };
    const eventRaw = JSON.stringify(event);
    const auth = { secret: config.webhookSecret, keyId: config.webhookKeyId };

    const ok = await postSigned(url, { signedBody: eventRaw, sentBody: eventRaw }, {
      ...auth,
      timestamp: String(now),
    });
    console.log(`  valid signature      -> HTTP ${ok.status} ${JSON.stringify(ok.body)}`);

    const tamperedBody = JSON.stringify({ ...event, data: { id: 43 } });
    const tampered = await postSigned(url, { signedBody: eventRaw, sentBody: tamperedBody }, {
      ...auth,
      timestamp: String(now),
    });
    console.log(`  tampered body        -> HTTP ${tampered.status} ${JSON.stringify(tampered.body)}`);

    const expired = await postSigned(url, { signedBody: eventRaw, sentBody: eventRaw }, {
      ...auth,
      timestamp: String(now - config.webhookTimestampMaxAgeSeconds - 1),
    });
    console.log(`  expired timestamp    -> HTTP ${expired.status} ${JSON.stringify(expired.body)}`);

    const wrongSecret = await postSigned(url, { signedBody: eventRaw, sentBody: eventRaw }, {
      secret: 'wrong-secret',
      keyId: config.webhookKeyId,
      timestamp: String(now),
    });
    console.log(`  wrong secret         -> HTTP ${wrongSecret.status} ${JSON.stringify(wrongSecret.body)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Part B — post a signed webhook to the real listener (best-effort). */
async function postToListener(client: ListenerClient, config: ExampleConfig): Promise<void> {
  const payload = { event: 'TaskCreated', contractAddress: 'CCEMX6...', data: { id: 42 } };
  const res = await client.sendSignedWebhook(payload, {
    secret: config.webhookSecret,
    keyId: config.webhookKeyId,
  });
  console.log(`POST /api/webhooks -> HTTP ${res.status} body=${JSON.stringify(res.data)}`);
  if (!res.ok) {
    const error = extractApiError(res.data);
    console.log(`  error code: ${error?.code} message: ${error?.message}`);
  }
}

/** Part B — page through delivery history using the opaque cursor. */
async function pollHistory(client: ListenerClient): Promise<void> {
  let cursor: string | undefined;
  let page = 0;
  do {
    const res = await client.getNotificationHistory({ limit: 2, cursor });
    if (!res.ok) {
      console.log(`GET /api/notifications/history -> HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      return;
    }
    const { records, itemCount, totalPages, nextCursor } = unwrapEnvelope<PaginatedHistoryResponse>(res.data);
    page += 1;
    console.log(`  page ${page}: ${records.length} record(s), itemCount=${itemCount}, totalPages=${totalPages}`);
    for (const record of records) {
      console.log(
        `    #${record.id} notif=${record.scheduledNotificationId} ` +
          `attempt=${record.executionAttempt} status=${record.status} ` +
          `durationMs=${record.responseDuration} at=${record.executionTime}`,
      );
    }
    cursor = nextCursor ?? undefined;
  } while (cursor);
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('Part A — local receiver verifying the listener webhook scheme');
  console.log('-----------------------------------------------------------');
  await verifySchemeOffline(config);
  console.log('');

  console.log('Part B — real listener (best-effort)');
  console.log('------------------------------------');
  const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  try {
    await postToListener(client, config);
    console.log('');
    console.log('Delivery history (/api/notifications/history):');
    await pollHistory(client);
  } catch (err) {
    console.log(`Listener unreachable: ${err instanceof Error ? err.message : String(err)}`);
    console.log('Start the listener, then re-run for Part B.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
