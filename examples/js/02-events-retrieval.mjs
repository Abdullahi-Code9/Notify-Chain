#!/usr/bin/env node
/**
 * Example 02 — Events retrieval, range queries and payload parsing.
 *
 * Endpoints (verified against listener/src/api/events-server.ts):
 *   GET /api/events?limit=N               (events-server.ts:723)
 *     → 200 { success: true, data: { count, events: DisplayEvent[] } }
 *       limit defaults to 20, clamped to [1, 100] (utils/pagination.ts:35).
 *
 *   GET /api/events/history?fromLedger&toLedger   (events-server.ts:672)
 *     → 200 { success: true, data: { count, startLedger, endLedger, events } }
 *       both params required; span ≤ 10 000 ledgers (ledger-range-validator.ts:17).
 *     → 400 { success: false, error: { code: 'BAD_REQUEST', message, details } }
 *
 * Neither endpoint requires an API key.
 *
 * Run:
 *   node js/02-events-retrieval.mjs
 */

import { createClient, unwrapEnvelope, extractApiError, loadConfig } from './lib/client.mjs';

/**
 * Parses one stored event into a human-friendly summary.
 * `value` is base64-encoded XDR; `topic` is the decoded topic array.
 */
function describeEvent(event) {
  return {
    eventId: event.eventId,
    contractAddress: event.contractAddress,
    eventName: event.eventName,
    ledger: event.ledger,
    type: event.type,
    topic: event.topic,
    valueBytes: event.value ? event.value.length : 0,
    txHash: event.txHash ?? null,
    receivedAt: new Date(event.receivedAt).toISOString(),
  };
}

/** Filters events client-side — `/api/events` has no server-side filters. */
function filterEvents(events, { contractAddress, eventName }) {
  return events.filter((e) => {
    if (contractAddress && e.contractAddress !== contractAddress) return false;
    if (eventName && e.eventName !== eventName) return false;
    return true;
  });
}

/** Fetches the newest events using the success envelope. */
async function fetchLatestEvents(client, limit) {
  const res = await client.getEvents({ limit });
  if (!res.ok) {
    console.log(`GET /api/events -> HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    return null;
  }
  const payload = unwrapEnvelope(res.data); // { count, events }
  console.log(`GET /api/events?limit=${limit} -> HTTP ${res.status}`);
  console.log(`  requestId        : ${res.requestId}`);
  console.log(`  data.count       : ${payload.count}`);
  console.log(`  data.events      : ${payload.events.length} returned`);
  return payload.events;
}

/** Demonstrates an inclusive ledger-range query, including the 400 path. */
async function rangeQuery(client) {
  const valid = await client.getEventsByLedgerRange(1, 5000);
  if (valid.ok) {
    const payload = unwrapEnvelope(valid.data);
    console.log(
      `GET /api/events/history?fromLedger=1&toLedger=5000 -> HTTP ${valid.status} ` +
        `(${payload.count} events across ledgers ${payload.startLedger}..${payload.endLedger})`,
    );
  } else {
    console.log(`GET /api/events/history -> HTTP ${valid.status}`);
  }

  // Span > MAX_LEDGER_RANGE (10 000) is rejected with the error envelope.
  const invalid = await client.getEventsByLedgerRange(1, 20000);
  if (!invalid.ok) {
    const error = extractApiError(invalid.data);
    console.log(`\nOversized range -> HTTP ${invalid.status}`);
    console.log(`  envelope code    : ${error?.code}`);
    console.log(`  message          : ${error?.message}`);
    console.log(`  details          : ${JSON.stringify(error?.details)}`);
    console.log(`  correlation_id   : ${error?.correlationId ?? invalid.correlationId}`);
  }

  // A missing parameter is also a 400.
  const missing = await client.get('/api/events/history', { query: { fromLedger: 1 } });
  if (!missing.ok) {
    const error = extractApiError(missing.data);
    console.log(`Missing toLedger -> HTTP ${missing.status} code=${error?.code} message="${error?.message}"`);
  }
}

async function main() {
  const config = loadConfig();
  const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  let events;
  try {
    events = await fetchLatestEvents(client, 5);
  } catch (err) {
    console.log(`Listener unreachable: ${err.message}`);
    console.log('Start the listener, then re-run.');
    return;
  }
  if (!events) return;
  console.log('');

  if (events.length === 0) {
    console.log('No events stored yet. Filtering demo skipped.');
  } else {
    const sample = events[0];
    console.log('Parsed sample event:');
    console.log(JSON.stringify(describeEvent(sample), null, 2));
    console.log('');

    const filtered = filterEvents(events, { contractAddress: sample.contractAddress });
    console.log(
      `Client-side filter (contractAddress=${sample.contractAddress}): ` +
        `${filtered.length} of ${events.length} events`,
    );
    console.log('');
  }

  await rangeQuery(client);

  console.log('\nNote: /api/events supports only `limit` (no offset/filter params).');
  console.log('Use /api/notifications/history for offset/cursor pagination (example 03).');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
