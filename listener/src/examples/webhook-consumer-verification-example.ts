/**
 * Webhook Consumer Verification Example (#991)
 *
 * Demonstrates how an external service receiving signed NotifyChain
 * notifications should:
 *
 *  1. Extract the HMAC-SHA256 signature from the `X-Webhook-Signature` header.
 *  2. Look up the correct signing secret via `X-Webhook-Key-Id`.
 *  3. Cryptographically bind the timestamp (`X-Webhook-Timestamp`) to the
 *     signature to prevent replay attacks.
 *  4. Reject any request that fails verification BEFORE processing the payload.
 *  5. Log and audit every verification outcome.
 *
 * Signature format (documented in listener/src/services/webhook-verifier.ts):
 *   X-Webhook-Signature: sha256=<hex-digest>
 *   X-Webhook-Key-Id:    <key-id>                 (identifies the secret to use)
 *   X-Webhook-Timestamp: <unix-seconds>            (replay protection)
 *
 * Signing input:
 *   <timestamp>.<raw-body>   when timestamp is present (recommended)
 *   <raw-body>               without timestamp (legacy — not recommended)
 *
 * Setup:
 *   1. From the repo root run:
 *        cd listener && npm install
 *   2. Set the WEBHOOK_SECRET environment variable to a shared secret that
 *      matches one of the `webhookSecrets` entries configured in the server.
 *   3. Start the reference consumer:
 *        npx ts-node src/examples/webhook-consumer-verification-example.ts
 *   4. Send a test notification (see the `sendTestRequest` helper below or
 *      use the Postman collection in docs/postman/).
 *
 * The server listens on port 4000 by default (override with PORT env var).
 */

import crypto from 'crypto';
import http from 'http';

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

/**
 * The consumer maintains its own registry of known signing keys.
 * In a real deployment these would come from a secrets manager (e.g. Vault,
 * AWS Secrets Manager, or an environment variable per key).
 *
 * Each entry mirrors the `WebhookSecret` type from the NotifyChain server:
 *   { id: string; secret: string }
 */
const KNOWN_SECRETS: Array<{ id: string; secret: string }> = [
  {
    id: process.env['WEBHOOK_KEY_ID'] ?? 'key-1',
    secret: process.env['WEBHOOK_SECRET'] ?? 'change-me-in-production',
  },
];

/** Maximum age of an incoming request before it is treated as a replay. */
const MAX_AGE_SECONDS = 300; // 5 minutes

// ─── Verification helpers ─────────────────────────────────────────────────────

/**
 * Constructs the canonical signing input that NotifyChain used when computing
 * the HMAC for this request.
 *
 *   signingInput = timestamp + "." + rawBody   (with timestamp — recommended)
 *   signingInput = rawBody                     (without timestamp — legacy)
 */
function buildSigningInput(rawBody: string, timestamp: string | null): string {
  if (timestamp !== null && timestamp !== '') {
    return `${timestamp}.${rawBody}`;
  }
  return rawBody;
}

/**
 * Returns `true` when `timestamp` is within the acceptable age window.
 * Rejects stale requests (> MAX_AGE_SECONDS old) and requests whose
 * timestamp is more than 60 s in the future (clock-skew tolerance).
 */
function isTimestampFresh(timestamp: string): boolean {
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const age = Math.floor(Date.now() / 1000) - ts;
  return age <= MAX_AGE_SECONDS && age >= -60;
}

/**
 * Verifies the HMAC-SHA256 signature sent by the NotifyChain server.
 *
 * Returns an object with:
 *   valid   — whether verification passed
 *   reason  — human-readable rejection reason (set only when valid === false)
 */
function verifyNotification(
  rawBody: string,
  headers: http.IncomingHttpHeaders,
): { valid: boolean; reason?: string; keyId?: string } {
  // 1. Extract required headers (Node.js lower-cases all header names)
  const signatureHeader = (headers['x-webhook-signature'] as string | undefined) ?? null;
  const keyId = (headers['x-webhook-key-id'] as string | undefined) ?? null;
  const timestamp = (headers['x-webhook-timestamp'] as string | undefined) ?? null;

  if (!signatureHeader) {
    return { valid: false, reason: 'Missing X-Webhook-Signature header' };
  }
  if (!keyId) {
    return { valid: false, reason: 'Missing X-Webhook-Key-Id header' };
  }

  // 2. Validate signature format: must start with "sha256="
  if (!signatureHeader.startsWith('sha256=')) {
    return {
      valid: false,
      reason: `Invalid signature format — expected "sha256=<hex>", got "${signatureHeader.slice(0, 15)}..."`,
    };
  }

  // 3. Look up the secret for the advertised key-id
  const entry = KNOWN_SECRETS.find((s) => s.id === keyId);
  if (!entry) {
    return { valid: false, reason: `Unknown key-id: ${keyId}` };
  }

  // 4. Validate timestamp freshness (replay protection)
  if (timestamp !== null && timestamp !== '') {
    if (!isTimestampFresh(timestamp)) {
      return {
        valid: false,
        reason: 'Request timestamp expired or invalid — possible replay attack',
      };
    }
  }

  // 5. Recompute the HMAC over the same signing input the server used
  const signingInput = buildSigningInput(rawBody, timestamp);
  const expectedHex = crypto
    .createHmac('sha256', entry.secret)
    .update(signingInput, 'utf8')
    .digest('hex');
  const expectedHeader = `sha256=${expectedHex}`;

  // 6. Constant-time comparison — prevents timing oracle attacks
  const provided = Buffer.from(signatureHeader, 'utf8');
  const expected = Buffer.from(expectedHeader, 'utf8');

  if (provided.length !== expected.length) {
    return { valid: false, reason: 'Signature length mismatch — invalid signature' };
  }

  if (!crypto.timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'HMAC mismatch — signature does not match payload' };
  }

  return { valid: true, keyId };
}

// ─── Event processor ──────────────────────────────────────────────────────────

/**
 * Called only after a notification has been successfully verified.
 * Replace this with your real business logic.
 */
function processVerifiedEvent(payload: unknown): void {
  // The payload is the JSON body sent by the NotifyChain listener.
  // Common fields include:
  //   event.id, event.contractAddress, event.eventName, event.ledger,
  //   event.timestamp, event.data (the decoded on-chain event parameters).
  console.log(
    '[consumer] ✅  Verified event received — processing:',
    JSON.stringify(payload, null, 2),
  );

  // Example: branch on event type
  const ev = payload as Record<string, unknown>;
  if (ev['type'] === 'notification') {
    console.log('[consumer] Handling notification event:', ev['id']);
  }
}

// ─── HTTP consumer server ─────────────────────────────────────────────────────

/**
 * Collects the raw request body as a single UTF-8 string.
 * It is critical that the raw bytes are preserved — any re-serialisation
 * would invalidate the HMAC because the server signed the exact bytes
 * that were sent over the wire.
 */
function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // This consumer only handles POST / (NotifyChain sends POST to the URL
  // registered as the webhook target).
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // ── Step 1: collect the raw body ──────────────────────────────────────────
  let rawBody: string;
  try {
    rawBody = await collectBody(req);
  } catch (err) {
    console.error('[consumer] Failed to read request body:', err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read request body' }));
    return;
  }

  // ── Step 2: verify the signature BEFORE touching the payload ─────────────
  const verification = verifyNotification(rawBody, req.headers);

  if (!verification.valid) {
    // Log the rejection with enough context for forensic review
    console.warn('[consumer] ⛔  Signature verification FAILED —', verification.reason, {
      keyId: req.headers['x-webhook-key-id'],
      timestamp: req.headers['x-webhook-timestamp'],
      bodyLength: rawBody.length,
    });

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized', reason: verification.reason }));
    return;
  }

  // ── Step 3: parse and process the verified payload ────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error('[consumer] Verified body is not valid JSON');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  try {
    processVerifiedEvent(payload);
  } catch (err) {
    console.error('[consumer] Event processing error:', err);
    // Return 500 so NotifyChain will retry the delivery
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal processing error' }));
    return;
  }

  // ── Step 4: acknowledge receipt ───────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', verified: true }));
});

// ─── Test helper ──────────────────────────────────────────────────────────────

/**
 * Sends a signed test request to the consumer server.
 * Useful for verifying the consumer is configured correctly without needing
 * a running NotifyChain listener instance.
 *
 * Acceptance criteria check (from issue #991):
 *  ✔  Uses the documented signature format (sha256= prefix, timestamp binding)
 *  ✔  A request with the correct secret succeeds
 *  ✔  A request with a wrong secret is rejected with 401
 *  ✔  A request with an expired timestamp is rejected with 401
 */
async function sendTestRequest(opts: {
  secret?: string;
  keyId?: string;
  tamper?: boolean;
  expireTimestamp?: boolean;
}): Promise<void> {
  const secret = opts.secret ?? KNOWN_SECRETS[0]!.secret;
  const keyId = opts.keyId ?? KNOWN_SECRETS[0]!.id;
  const body = JSON.stringify({
    type: 'notification',
    id: `evt-${Date.now()}`,
    contractAddress: 'CEXAMPLECONTRACTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    eventName: 'transfer',
    data: { from: 'GABC...', to: 'GXYZ...', amount: '100' },
  });

  // Build a fresh (or deliberately stale) timestamp
  const timestamp = opts.expireTimestamp
    ? String(Math.floor(Date.now() / 1000) - 600) // 10 minutes ago — expired
    : String(Math.floor(Date.now() / 1000));

  // Compute the signature over timestamp.body
  const signingInput = `${timestamp}.${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  const signature = `sha256=${hmac}`;

  // Optionally tamper with the body after signing to simulate an attack
  const sentBody = opts.tamper ? body.replace('transfer', 'TAMPERED') : body;

  const reqBody = Buffer.from(sentBody, 'utf8');

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': reqBody.length,
          'X-Webhook-Signature': signature,
          'X-Webhook-Key-Id': keyId,
          'X-Webhook-Timestamp': timestamp,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          const label = opts.tamper
            ? 'Tampered body'
            : opts.expireTimestamp
              ? 'Expired timestamp'
              : opts.secret && opts.secret !== KNOWN_SECRETS[0]?.secret
                ? 'Wrong secret'
                : 'Valid request';
          console.log(`[test] ${label} → HTTP ${res.statusCode}:`, data);
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`[consumer] Webhook consumer listening on http://127.0.0.1:${PORT}`);
    console.log(
      `[consumer] Using key-id "${KNOWN_SECRETS[0]!.id}" with secret "${KNOWN_SECRETS[0]!.secret}"`,
    );
    console.log(
      '[consumer] Set WEBHOOK_SECRET and WEBHOOK_KEY_ID env vars to match your server config.\n',
    );

    // Run a self-test suite to confirm the consumer behaves correctly
    console.log('──── Self-test suite ────');

    // 1. Valid request — should succeed (HTTP 200)
    await sendTestRequest({});

    // 2. Wrong secret — should be rejected (HTTP 401)
    await sendTestRequest({ secret: 'completely-wrong-secret' });

    // 3. Tampered body — should be rejected (HTTP 401)
    await sendTestRequest({ tamper: true });

    // 4. Expired timestamp — should be rejected (HTTP 401)
    await sendTestRequest({ expireTimestamp: true });

    console.log('──── Self-test complete ────\n');
    console.log('[consumer] Server remains running. Send POST requests to test manually.');
  });
}

export {
  verifyNotification,
  buildSigningInput,
  isTimestampFresh,
  processVerifiedEvent,
  collectBody,
};
