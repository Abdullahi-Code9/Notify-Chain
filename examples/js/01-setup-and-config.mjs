#!/usr/bin/env node
/**
 * Example 01 — Setup, configuration and authentication.
 *
 * Shows how to:
 *   1. Read configuration from environment variables.
 *   2. Build the auth + tracing headers the listener expects.
 *   3. Initialise a reusable `ListenerClient`.
 *   4. Verify connectivity with `GET /health`.
 *
 * Run:
 *   node js/01-setup-and-config.mjs
 *   node --env-file=.env js/01-setup-and-config.mjs
 */

import {
  ListenerClient,
  createClient,
  loadConfig,
  maskSecret,
} from './lib/client.mjs';

/**
 * Prints the effective configuration with secrets masked.
 */
function printConfig(config) {
  console.log('Effective configuration');
  console.log('-----------------------');
  console.log(`  EVENTS_API_BASE_URL               : ${config.baseUrl}`);
  console.log(`  EVENTS_API_KEY                    : ${maskSecret(config.apiKey)}`);
  console.log(`  WEBHOOK_SECRET                    : ${maskSecret(config.webhookSecret)}`);
  console.log(`  WEBHOOK_KEY_ID                    : ${config.webhookKeyId}`);
  console.log(`  WEBHOOK_TIMESTAMP_MAX_AGE_SECONDS : ${config.webhookTimestampMaxAgeSeconds}`);
  console.log('');
}

/**
 * Shows the exact headers the client attaches, without sending anything.
 */
function printHeaders(client) {
  const headers = client.buildHeaders({ body: { example: true }, correlationId: 'example-correlation-1' });
  console.log('Request headers the client would send for a JSON POST:');
  console.log(JSON.stringify(headers, null, 2));
  console.log('');
}

/**
 * Best-effort reachability probe. `/health` is not enveloped — it returns the
 * health object directly and uses HTTP 200 (ok/degraded) or 503 (error).
 */
async function probeHealth(client) {
  try {
    const res = await client.health();
    console.log(`GET /health -> HTTP ${res.status}`);
    console.log(`  X-Request-Id     : ${res.requestId}`);
    console.log(`  X-Correlation-Id : ${res.correlationId}`);
    console.log(`  body             : ${JSON.stringify(res.data)}`);
  } catch (err) {
    console.log(`GET /health unreachable: ${err.message}`);
    console.log('Start the listener first (see examples/README.md) and re-run.');
  }
}

async function main() {
  const config = loadConfig();
  printConfig(config);

  // Explicit construction shows every knob; `createClient()` does the same
  // with a generated correlation id.
  const client = new ListenerClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    correlationId: 'example-setup-1',
  });

  printHeaders(client);

  // Equivalent shorthand used by the other examples.
  const shorthand = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  console.log(`createClient() base URL: ${shorthand.baseUrl}`);
  console.log('');

  await probeHealth(client);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
