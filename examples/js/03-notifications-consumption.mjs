#!/usr/bin/env node
/**
 * Example 03 — Notification consumption: signed webhooks + history polling.
 *
 * Part A: a local HTTP receiver that verifies incoming webhook signatures with
 *         the SAME scheme the listener uses
 *         (listener/src/services/webhook-verifier.ts):
 *           - headers: X-Webhook-Signature, X-Webhook-Key-Id, X-Webhook-Timestamp
 *           - signing input: `${timestamp}.${rawBody}` (body alone if no timestamp)
 *           - signature: `sha256=<hex>` HMAC-SHA256 over the signing input
 *           - constant-time comparison, timestamp freshness window (default 300s)
 *         It then signs its own payloads and POSTs them, exercising accept,
 *         tamper and expiry paths — all offline.
 *
 * Part B: `POST /api/webhooks` against the real listener (best-effort), then
 *         `GET /api/notifications/history` with cursor pagination
 *         (listener/src/api/events-server.ts:1788, notification-history.ts).
 *
 * Run:
 *   node js/03-notifications-consumption.mjs
 */

import http from 'node:http';
import {
  createClient,
  computeWebhookSignature,
  verifyWebhookSignature,
  loadConfig,
  extractApiError,
} from './lib/client.mjs';

/** Reads the raw request body as a UTF-8 string. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Starts a receiver that validates every request against the listener's
 * webhook signature scheme, mirroring `verifyWebhookRequest`.
 */
function startReceiver({ port, secret, keyId, maxAgeSeconds, requireTimestamp = true }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers['x-webhook-signature'];
    const sentKeyId = req.headers['x-webhook-key-id'];
    const timestampHeader = req.headers['x-webhook-timestamp'];

    if (sentKeyId !== keyId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown key-id' }));
      return;
    }

    const result = verifyWebhookSignature({
      payload: rawBody,
      signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : undefined,
      secret,
      timestampHeader: typeof timestampHeader === 'string' ? timestampHeader : undefined,
      maxAgeSeconds,
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
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * POSTs a payload to the local receiver and returns the status.
 *
 * `signedBody` is what the signature is computed over; `sentBody` is what is
 * actually transmitted. They are identical for an honest sender — passing a
 * different value for `sentBody` simulates an in-transit tamper.
 */
async function postSigned(url, { signedBody, sentBody }, { secret, keyId, timestamp }) {
  const signature = computeWebhookSignature(signedBody, secret, timestamp);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
      'X-Webhook-Key-Id': keyId,
      'X-Webhook-Timestamp': timestamp,
    },
    body: sentBody,
  });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

/** Part A — offline verification of the webhook signature scheme. */
async function verifySchemeOffline(config) {
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

    // Signature is valid for `eventRaw`, but a different body is transmitted.
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
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Part B — post a signed webhook to the real listener (best-effort). */
async function postToListener(client, config) {
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
async function pollHistory(client) {
  let cursor;
  let page = 0;
  do {
    const res = await client.getNotificationHistory({ limit: 2, cursor });
    if (!res.ok) {
      console.log(`GET /api/notifications/history -> HTTP ${res.status}: ${JSON.stringify(res.data)}`);
      return;
    }
    // This endpoint returns the paginated object directly (no success envelope).
    const { records, itemCount, totalPages, nextCursor } = res.data;
    page += 1;
    console.log(
      `  page ${page}: ${records.length} record(s), itemCount=${itemCount}, totalPages=${totalPages}`,
    );
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

async function main() {
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
    console.log(`Listener unreachable: ${err.message}`);
    console.log('Start the listener, then re-run for Part B.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
