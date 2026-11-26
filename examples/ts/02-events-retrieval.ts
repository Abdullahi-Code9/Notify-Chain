/**
 * Example 02 (TypeScript) — Events retrieval, range queries and payload parsing.
 *
 * Mirrors `../js/02-events-retrieval.mjs`.
 *
 * Run:
 *   node ts/02-events-retrieval.ts
 */

import {
  createClient,
  unwrapEnvelope,
  extractApiError,
  loadConfig,
} from './lib/client.ts';
import type { DisplayEvent, EventsData, EventsHistoryData, ListenerClient } from './lib/client.ts';

/** Human-friendly view of a stored event. */
interface DescribedEvent {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: string[];
  valueBytes: number;
  txHash: string | null;
  receivedAt: string;
}

/** Parses one stored event into a summary (value is base64 XDR, topic decoded). */
function describeEvent(event: DisplayEvent): DescribedEvent {
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

/** Client-side filtering — `/api/events` has no server-side filters. */
function filterEvents(
  events: DisplayEvent[],
  filter: { contractAddress?: string; eventName?: string },
): DisplayEvent[] {
  return events.filter((e) => {
    if (filter.contractAddress && e.contractAddress !== filter.contractAddress) return false;
    if (filter.eventName && e.eventName !== filter.eventName) return false;
    return true;
  });
}

/** Fetches the newest events using the success envelope. */
async function fetchLatestEvents(client: ListenerClient, limit: number): Promise<DisplayEvent[] | null> {
  const res = await client.getEvents({ limit });
  if (!res.ok) {
    console.log(`GET /api/events -> HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    return null;
  }
  const payload = unwrapEnvelope<EventsData>(res.data); // { count, events }
  console.log(`GET /api/events?limit=${limit} -> HTTP ${res.status}`);
  console.log(`  requestId        : ${res.requestId}`);
  console.log(`  data.count       : ${payload.count}`);
  console.log(`  data.events      : ${payload.events.length} returned`);
  return payload.events;
}

/** Demonstrates an inclusive ledger-range query, including the 400 path. */
async function rangeQuery(client: ListenerClient): Promise<void> {
  const valid = await client.getEventsByLedgerRange(1, 5000);
  if (valid.ok) {
    const payload = unwrapEnvelope<EventsHistoryData>(valid.data);
    console.log(
      `GET /api/events/history?fromLedger=1&toLedger=5000 -> HTTP ${valid.status} ` +
        `(${payload.count} events across ledgers ${payload.startLedger}..${payload.endLedger})`,
    );
  } else {
    console.log(`GET /api/events/history -> HTTP ${valid.status}`);
  }

  const invalid = await client.getEventsByLedgerRange(1, 20000);
  if (!invalid.ok) {
    const error = extractApiError(invalid.data);
    console.log(`\nOversized range -> HTTP ${invalid.status}`);
    console.log(`  envelope code    : ${error?.code}`);
    console.log(`  message          : ${error?.message}`);
    console.log(`  details          : ${JSON.stringify(error?.details)}`);
    console.log(`  correlation_id   : ${error?.correlationId ?? invalid.correlationId}`);
  }

  const missing = await client.get('/api/events/history', { query: { fromLedger: 1 } });
  if (!missing.ok) {
    const error = extractApiError(missing.data);
    console.log(`Missing toLedger -> HTTP ${missing.status} code=${error?.code} message="${error?.message}"`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  let events: DisplayEvent[] | null;
  try {
    events = await fetchLatestEvents(client, 5);
  } catch (err) {
    console.log(`Listener unreachable: ${err instanceof Error ? err.message : String(err)}`);
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

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
