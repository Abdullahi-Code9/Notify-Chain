#!/usr/bin/env node
/**
 * Example 04 — Error handling, retries and malformed responses.
 *
 * Covers:
 *   1. Parsing BOTH real error shapes the listener emits:
 *        - standard envelope:  { success:false, error:{ code, message, details, correlation_id } }
 *        - bare shape:         { error: "message", code: "MACHINE_CODE" }
 *          (used by /api/schedule* and /api/webhooks auth failures)
 *   2. Retrying on 429 / 5xx with exponential backoff that honours `Retry-After`.
 *      (429 comes from rate-limiter.ts:156; those responses carry Retry-After.)
 *   3. Surviving malformed (non-JSON) bodies.
 *
 * The retry + malformed demos use an injected fetch / local server so they run
 * fully offline. The 404 / 400 demos hit the real listener when available.
 *
 * Run:
 *   node js/04-error-handling-and-retries.mjs
 */

import http from 'node:http';
import { createClient, extractApiError, loadConfig, ListenerApiError } from './lib/client.mjs';

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes the delay before the next retry, preferring the server's
 * `Retry-After` header (seconds or HTTP-date) over exponential backoff.
 */
function computeBackoffMs(headers, attempt, baseDelayMs, jitter = true) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const backoff = baseDelayMs * 2 ** attempt;
  return jitter ? backoff + Math.floor(Math.random() * baseDelayMs) : backoff;
}

/**
 * Retries `fn(attempt)` while the response status is retryable.
 * `fn` must resolve to the client's `{ status, ok, headers, data, ... }` shape.
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 100, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    const res = await fn(attempt);
    const retryable = !res.ok && RETRYABLE_STATUSES.includes(res.status);
    if (!retryable || attempt >= retries) return res;
    const delayMs = computeBackoffMs(res.headers, attempt, baseDelayMs);
    if (onRetry) onRetry(attempt, res.status, delayMs);
    await sleep(delayMs);
    attempt += 1;
  }
}

/** Builds a fetch stub that plays back a scripted list of responses. */
function scriptedFetch(steps) {
  let index = 0;
  return async () => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return new Response(step.body, { status: step.status, headers: step.headers ?? {} });
  };
}

/** Demo: 429 then 200, honouring Retry-After. */
async function demoRetryRateLimit() {
  console.log('Retry on 429 (honours Retry-After)');
  const fetchImpl = scriptedFetch([
    { status: 429, headers: { 'Retry-After': '0' }, body: JSON.stringify({ error: 'Too Many Requests' }) },
    { status: 200, body: JSON.stringify({ success: true, data: { count: 0, events: [] } }) },
  ]);
  const client = createClient({ fetchImpl });
  const res = await withRetry(() => client.getEvents(), {
    onRetry: (attempt, status, delayMs) =>
      console.log(`  attempt ${attempt + 1}: HTTP ${status}, waiting ${delayMs}ms`),
  });
  console.log(`  final: HTTP ${res.status}\n`);
}

/** Demo: two 500s then 200, with exponential backoff (no Retry-After). */
async function demoRetryServerErrors() {
  console.log('Retry on 500 (exponential backoff)');
  const fetchImpl = scriptedFetch([
    { status: 500, body: JSON.stringify({ error: 'SQLITE_BUSY: database is locked' }) },
    { status: 500, body: JSON.stringify({ error: 'SQLITE_BUSY: database is locked' }) },
    { status: 200, body: JSON.stringify({ success: true, data: { count: 0, events: [] } }) },
  ]);
  const client = createClient({ fetchImpl });
  await withRetry(() => client.getEvents(), {
    baseDelayMs: 50,
    onRetry: (attempt, status, delayMs) =>
      console.log(`  attempt ${attempt + 1}: HTTP ${status}, waiting ${delayMs}ms`),
  });
  console.log('  recovered after retries\n');
}

/** Demo: parsing both real envelope shapes. */
function demoEnvelopeParsing() {
  console.log('Error envelope parsing');
  const envelope = {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded. Try again in 12 seconds.',
      details: [],
      correlation_id: '4d1c3c1e-0000-0000-0000-000000000000',
    },
  };
  const bare = { error: 'executeAt is not a valid date', code: 'INVALID_DATE' };
  console.log('  standard :', JSON.stringify(extractApiError(envelope)));
  console.log('  bare     :', JSON.stringify(extractApiError(bare)));
  console.log('');
}

/** Demo: a non-JSON body is reported as `malformed`, not thrown. */
async function demoMalformedJson() {
  console.log('Malformed (non-JSON) response');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><h1>not json</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
    const res = await client.get('/api/events');
    console.log(`  status=${res.status} malformed=${res.malformed} raw="${res.raw}"`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('');
}

/** Demo: real listener 404 + 400 (best-effort). */
async function demoRealErrors(client) {
  console.log('Real listener errors (best-effort)');
  try {
    const notFound = await client.get('/api/this-route-does-not-exist');
    const nf = extractApiError(notFound.data);
    console.log(`  404 -> code=${nf?.code} message="${nf?.message}" correlation_id=${nf?.correlationId}`);

    const badRange = await client.getEventsByLedgerRange(1, 999999);
    const br = extractApiError(badRange.data);
    console.log(`  400 -> code=${br?.code} message="${br?.message}" details=${JSON.stringify(br?.details)}`);
  } catch (err) {
    if (err instanceof ListenerApiError) {
      console.log(`  listener unreachable: ${err.message}`);
    } else {
      throw err;
    }
  }
}

async function main() {
  demoEnvelopeParsing();
  await demoRetryRateLimit();
  await demoRetryServerErrors();
  await demoMalformedJson();

  const config = loadConfig();
  const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  await demoRealErrors(client);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
