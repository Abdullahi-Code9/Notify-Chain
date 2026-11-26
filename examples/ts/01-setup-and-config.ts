/**
 * Example 01 (TypeScript) — Setup, configuration and authentication.
 *
 * Mirrors `../js/01-setup-and-config.mjs`.
 *
 * Run (Node 22.6+ / 24 strips types on the fly):
 *   node ts/01-setup-and-config.ts
 */

import {
  ListenerClient,
  createClient,
  loadConfig,
  maskSecret,
} from './lib/client.ts';
import type { ExampleConfig } from './lib/client.ts';

/** Prints the effective configuration with secrets masked. */
function printConfig(config: ExampleConfig): void {
  console.log('Effective configuration');
  console.log('-----------------------');
  console.log(`  EVENTS_API_BASE_URL               : ${config.baseUrl}`);
  console.log(`  EVENTS_API_KEY                    : ${maskSecret(config.apiKey)}`);
  console.log(`  WEBHOOK_SECRET                    : ${maskSecret(config.webhookSecret)}`);
  console.log(`  WEBHOOK_KEY_ID                    : ${config.webhookKeyId}`);
  console.log(`  WEBHOOK_TIMESTAMP_MAX_AGE_SECONDS : ${config.webhookTimestampMaxAgeSeconds}`);
  console.log('');
}

/** Shows the exact headers the client attaches, without sending anything. */
function printHeaders(client: ListenerClient): void {
  const headers = client.buildHeaders({
    body: { example: true },
    correlationId: 'example-correlation-1',
  });
  console.log('Request headers the client would send for a JSON POST:');
  console.log(JSON.stringify(headers, null, 2));
  console.log('');
}

/** Best-effort reachability probe against `GET /health`. */
async function probeHealth(client: ListenerClient): Promise<void> {
  try {
    const res = await client.health();
    console.log(`GET /health -> HTTP ${res.status}`);
    console.log(`  X-Request-Id     : ${res.requestId}`);
    console.log(`  X-Correlation-Id : ${res.correlationId}`);
    console.log(`  body             : ${JSON.stringify(res.data)}`);
  } catch (err) {
    console.log(`GET /health unreachable: ${err instanceof Error ? err.message : String(err)}`);
    console.log('Start the listener first (see examples/README.md) and re-run.');
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  printConfig(config);

  const client = new ListenerClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    correlationId: 'example-setup-1',
  });

  printHeaders(client);

  const shorthand = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  console.log(`createClient() base URL: ${shorthand.baseUrl}`);
  console.log('');

  await probeHealth(client);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
