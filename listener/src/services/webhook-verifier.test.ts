import crypto from 'crypto';
import {
  verifySignature,
  extractSignature,
  extractKeyId,
  extractTimestamp,
  getSecretForKey,
  isTimestampValid,
  buildSigningInput,
  computeWebhookSignature,
  verifyWebhookRequest,
} from './webhook-verifier';
import logger from '../utils/logger';
import { WebhookReplayCache } from './webhook-replay-cache';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

function computeSignatureLegacy(payload: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `sha256=${sig}`;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildSigningInput', () => {
  it('returns raw payload when timestamp is not provided', () => {
    expect(buildSigningInput('{"a":1}')).toBe('{"a":1}');
  });

  it('returns raw payload when timestamp is empty string', () => {
    expect(buildSigningInput('{"a":1}', '')).toBe('{"a":1}');
  });

  it('prepends timestamp and separator when timestamp is provided', () => {
    expect(buildSigningInput('{"a":1}', '1700000000')).toBe('1700000000.{"a":1}');
  });

  it('handles empty payload with timestamp correctly', () => {
    expect(buildSigningInput('', '123')).toBe('123.');
  });
});

describe('computeWebhookSignature', () => {
  it('produces a sha256= prefix signature', () => {
    const sig = computeWebhookSignature('payload', 'secret');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(sig.length).toBe(7 + 64);
  });

  it('produces different signatures when timestamp differs', () => {
    const sigNoTs = computeWebhookSignature('payload', 'secret');
    const sigWithTs = computeWebhookSignature('payload', 'secret', '1700000000');
    expect(sigNoTs).not.toBe(sigWithTs);
  });

  it('is deterministic for the same inputs', () => {
    expect(computeWebhookSignature('p', 's', 't')).toBe(computeWebhookSignature('p', 's', 't'));
  });
});

describe('verifySignature', () => {
  it('returns {valid:true} for a valid legacy (no-timestamp) signature', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const header = computeSignatureLegacy(payload, secret);

    const result = verifySignature(payload, header, secret);
    expect(result.valid).toBe(true);
  });

  it('returns {valid:false, reason:hmac_mismatch} for a signature computed with the wrong secret', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const header = computeSignatureLegacy(payload, secret);

    const result = verifySignature(payload, header, 'wrong_secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hmac_mismatch');
  });

  it('returns {valid:false} when the header does not have the sha256= prefix', () => {
    const payload = '{"event":"test"}';
    const result = verifySignature(payload, 'invalidsignature', 'secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature_prefix');
  });

  it('returns {valid:true} for empty payload with correct signature', () => {
    const payload = '';
    const secret = 'whsec_secret';
    const header = computeSignatureLegacy(payload, secret);

    expect(verifySignature(payload, header, secret).valid).toBe(true);
    expect(verifySignature(payload, header, 'different_secret').valid).toBe(false);
  });

  it('uses constant-time comparison (different lengths handled)', () => {
    const payload = '{}';
    const secret = 'test';
    const header = 'sha256=abc';

    const result = verifySignature(payload, header, secret);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_length_mismatch');
  });

  it('accepts a valid signature when timestamp is cryptographically bound', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const ts = Math.floor(Date.now() / 1000).toString();
    const header = computeWebhookSignature(payload, secret, ts);

    const result = verifySignature(payload, header, secret, ts, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(true);
  });

  it('rejects a legacy-signature request when caller claims it has a timestamp', () => {
    // The attacker takes a previously-captured valid signature (no-timestamp)
    // and re-sends it with a fresh/fake timestamp header expecting the server
    // to skip timestamp-binding.  It must reject because the signature was
    // computed WITHOUT the timestamp.
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const legacyHeader = computeSignatureLegacy(payload, secret);
    const fakeTimestamp = Math.floor(Date.now() / 1000).toString();

    const result = verifySignature(payload, legacyHeader, secret, fakeTimestamp, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hmac_mismatch');
  });

  it('rejects a valid timestamp-bound signature when timestamp is stripped', () => {
    // The attacker captures a request with timestamp-bound signature, then
    // strips the X-Webhook-Timestamp header.  Because signing input differs,
    // the HMAC no longer matches and the request MUST be rejected.
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const ts = Math.floor(Date.now() / 1000).toString();
    const boundHeader = computeWebhookSignature(payload, secret, ts);

    // Attacker removes timestamp header -> verify with no timestamp
    const result = verifySignature(payload, boundHeader, secret, undefined, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hmac_mismatch');
  });

  it('rejects when timestamp is in the signature but forged to a different value', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const realTs = Math.floor(Date.now() / 1000).toString();
    const forgedTs = (parseInt(realTs, 10) + 30).toString();
    const headerBoundToRealTs = computeWebhookSignature(payload, secret, realTs);

    const result = verifySignature(payload, headerBoundToRealTs, secret, forgedTs, { maxAgeSeconds: 86400 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hmac_mismatch');
  });

  it('rejects when signature prefix is entirely missing', () => {
    const result = verifySignature('{}', '', 'secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature_header');
  });

  it('rejects when signature header is undefined-ish via null/empty', () => {
    const result = verifySignature('{}', null as any, 'secret');
    expect(result.valid).toBe(false);
  });

  it('logs all authentication failures via structured logger', () => {
    verifySignature('{}', 'badprefix', 'secret', undefined, undefined, { requestId: 'r-1' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requestId: 'r-1' })
    );
  });
});

describe('extractSignature', () => {
  it('extracts from x-webhook-signature header', () => {
    const headers = { 'x-webhook-signature': 'sha256=abc123' };
    expect(extractSignature(headers)).toBe('sha256=abc123');
  });

  it('extracts from X-Webhook-Signature header', () => {
    const headers = { 'X-Webhook-Signature': 'sha256=abc123' };
    expect(extractSignature(headers)).toBe('sha256=abc123');
  });

  it('returns null when no signature header is present', () => {
    expect(extractSignature({})).toBeNull();
  });

  it('takes the first value when header is an array', () => {
    const headers = { 'x-webhook-signature': ['sha256=first', 'sha256=second'] };
    expect(extractSignature(headers)).toBe('sha256=first');
  });
});

describe('extractKeyId', () => {
  it('extracts from x-webhook-key-id header', () => {
    const headers = { 'x-webhook-key-id': 'key-1' };
    expect(extractKeyId(headers)).toBe('key-1');
  });

  it('extracts from X-Webhook-Key-Id header', () => {
    const headers = { 'X-Webhook-Key-Id': 'key-1' };
    expect(extractKeyId(headers)).toBe('key-1');
  });

  it('returns null when no key-id header is present', () => {
    expect(extractKeyId({})).toBeNull();
  });
});

describe('extractTimestamp', () => {
  it('extracts from x-webhook-timestamp header', () => {
    const headers = { 'x-webhook-timestamp': '1700000000' };
    expect(extractTimestamp(headers)).toBe('1700000000');
  });

  it('extracts from X-Webhook-Timestamp header', () => {
    const headers = { 'X-Webhook-Timestamp': '1700000000' };
    expect(extractTimestamp(headers)).toBe('1700000000');
  });

  it('returns null when no timestamp header is present', () => {
    expect(extractTimestamp({})).toBeNull();
  });

  it('takes the first value when header is an array', () => {
    const headers = { 'x-webhook-timestamp': ['1700000000', '1700000001'] };
    expect(extractTimestamp(headers)).toBe('1700000000');
  });
});

describe('getSecretForKey', () => {
  const secrets = [
    { id: 'key-1', secret: 'secret_1' },
    { id: 'key-2', secret: 'secret_2' },
  ];

  it('returns the matching secret', () => {
    expect(getSecretForKey(secrets, 'key-1')).toBe('secret_1');
    expect(getSecretForKey(secrets, 'key-2')).toBe('secret_2');
  });

  it('returns undefined for an unknown key', () => {
    expect(getSecretForKey(secrets, 'unknown-key')).toBeUndefined();
  });

  it('returns undefined for an empty secrets array', () => {
    expect(getSecretForKey([], 'key-1')).toBeUndefined();
  });
});

describe('isTimestampValid', () => {
  it('accepts a recent timestamp within the expiration window', () => {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    expect(isTimestampValid(currentTimestamp.toString(), 300)).toBe(true);
  });

  it('rejects a timestamp older than the expiration window', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago, max is 300
    expect(isTimestampValid(oldTimestamp.toString(), 300)).toBe(false);
  });

  it('accepts a timestamp at the exact expiration boundary', () => {
    const boundaryTimestamp = Math.floor(Date.now() / 1000) - 300; // Exactly 300 seconds ago
    expect(isTimestampValid(boundaryTimestamp.toString(), 300)).toBe(true);
  });

  it('rejects a timestamp just over the expiration boundary', () => {
    const overBoundaryTimestamp = Math.floor(Date.now() / 1000) - 301; // 301 seconds ago
    expect(isTimestampValid(overBoundaryTimestamp.toString(), 300)).toBe(false);
  });

  it('rejects a timestamp from the future (more than 1 minute ahead)', () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 120; // 2 minutes in the future
    expect(isTimestampValid(futureTimestamp.toString(), 300)).toBe(false);
  });

  it('accepts a timestamp slightly in the future (within clock skew tolerance)', () => {
    const slightlyFutureTimestamp = Math.floor(Date.now() / 1000) + 30; // 30 seconds in the future
    expect(isTimestampValid(slightlyFutureTimestamp.toString(), 300)).toBe(true);
  });

  it('rejects an invalid timestamp string', () => {
    expect(isTimestampValid('not-a-number', 300)).toBe(false);
  });

  it('rejects an empty timestamp string', () => {
    expect(isTimestampValid('', 300)).toBe(false);
  });

  it('rejects NaN as a timestamp', () => {
    expect(isTimestampValid('NaN', 300)).toBe(false);
  });
});

describe('verifySignature with timestamp expiration', () => {
  it('verifies both signature AND timestamp when both are valid (bound signature)', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const currentTimestamp = Math.floor(Date.now() / 1000).toString();
    const header = computeWebhookSignature(payload, secret, currentTimestamp);

    const result = verifySignature(payload, header, secret, currentTimestamp, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(true);
  });

  it('rejects when signature is bound to timestamp but timestamp is expired', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const header = computeWebhookSignature(payload, secret, oldTimestamp);

    const result = verifySignature(payload, header, secret, oldTimestamp, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_expired');
  });

  it('rejects when timestamp is valid but HMAC is computed with wrong secret', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const currentTimestamp = Math.floor(Date.now() / 1000).toString();
    const header = computeWebhookSignature(payload, secret, currentTimestamp);

    const result = verifySignature(payload, header, 'wrong_secret', currentTimestamp, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(false);
  });

  it('skips timestamp expiration check when maxAgeSeconds is not specified', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const header = computeWebhookSignature(payload, secret, oldTimestamp);

    const result = verifySignature(payload, header, secret, oldTimestamp, {});
    expect(result.valid).toBe(true);
  });

  it('skips timestamp binding when timestamp header is not provided (legacy mode)', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const header = computeWebhookSignature(payload, secret);

    const result = verifySignature(payload, header, secret, undefined, { maxAgeSeconds: 300 });
    expect(result.valid).toBe(true);
  });
});

describe('verifyWebhookRequest — end-to-end request authentication', () => {
  const SECRETS = [
    { id: 'key-alpha', secret: 'whsec_alpha_abc123' },
    { id: 'key-beta', secret: 'whsec_beta_def456' },
  ];

  it('AUTHENTICATES a valid timestamp-bound request and logs success', async () => {
    const payload = '{"event":"delivery","id":"evt-1"}';
    const key = SECRETS[0];
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = computeWebhookSignature(payload, key.secret, ts);

    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': key.id,
        'x-webhook-timestamp': ts,
      },
      rawBody: payload,
      secrets: SECRETS,
      requestId: 'r-verify-1',
      correlationId: 'c-verify-1',
    });

    expect(outcome.authenticated).toBe(true);
    expect(outcome.keyId).toBe(key.id);
    expect(outcome.timestampVerified).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('succeeded'),
      expect.objectContaining({ requestId: 'r-verify-1' })
    );
  });

  it('REJECTS with 401 when signature header is entirely missing', async () => {
    const outcome = await verifyWebhookRequest({
      headers: { 'x-webhook-key-id': 'key-alpha' },
      rawBody: '{}',
      secrets: SECRETS,
      requestId: 'r-missing-sig',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_MISSING_SIGNATURE');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('REJECTS with 401 when key-id header is missing', async () => {
    const payload = '{}';
    const sig = computeWebhookSignature(payload, SECRETS[0].secret);
    const outcome = await verifyWebhookRequest({
      headers: { 'x-webhook-signature': sig },
      rawBody: payload,
      secrets: SECRETS,
      requestId: 'r-missing-keyid',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_MISSING_KEY_ID');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('REJECTS with 401 AUTH_UNKNOWN_KEY_ID for a key-id not in the secrets array', async () => {
    const payload = '{}';
    const sig = computeWebhookSignature(payload, 'rogue-secret');
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': 'key-does-not-exist',
      },
      rawBody: payload,
      secrets: SECRETS,
      requestId: 'r-unknown-key',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_UNKNOWN_KEY_ID');
  });

  it('REJECTS with 401 AUTH_INVALID_SIGNATURE when HMAC does not match (wrong secret)', async () => {
    const payload = '{"malicious":true}';
    const forgedSig = computeWebhookSignature(payload, 'wrong-secret');
    const ts = Math.floor(Date.now() / 1000).toString();
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': forgedSig,
        'x-webhook-key-id': SECRETS[0].id,
        'x-webhook-timestamp': ts,
      },
      rawBody: payload,
      secrets: SECRETS,
      requestId: 'r-bad-hmac',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('REJECTS with 401 AUTH_TIMESTAMP_EXPIRED for a stale timestamp bound to a valid HMAC', async () => {
    const payload = '{"event":"old"}';
    const oldTs = (Math.floor(Date.now() / 1000) - 1000).toString();
    const sig = computeWebhookSignature(payload, SECRETS[1].secret, oldTs);
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': SECRETS[1].id,
        'x-webhook-timestamp': oldTs,
      },
      rawBody: payload,
      secrets: SECRETS,
      maxAgeSeconds: 300,
      requestId: 'r-expired-ts',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('REJECTS with 401 AUTH_INVALID_SIGNATURE_FORMAT when prefix is wrong', async () => {
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': 'md5=deadbeef',
        'x-webhook-key-id': SECRETS[0].id,
      },
      rawBody: '{}',
      secrets: SECRETS,
      requestId: 'r-bad-prefix',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_INVALID_SIGNATURE_FORMAT');
  });

  it('logs source IP and correlation ID on auth failure for audit trail', async () => {
    await verifyWebhookRequest({
      headers: { 'x-webhook-key-id': SECRETS[0].id },
      rawBody: '{}',
      secrets: SECRETS,
      sourceIp: '203.0.113.42',
      requestId: 'r-audit-1',
      correlationId: 'corr-audit-99',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceIp: '203.0.113.42',
        requestId: 'r-audit-1',
        correlationId: 'corr-audit-99',
      })
    );
  });

  it('REJECTS payload tampering — attacker modifies body after valid signature computed', async () => {
    const originalBody = '{"action":"transfer","amount":10}';
    const tamperedBody = '{"action":"transfer","amount":1000000}';
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = computeWebhookSignature(originalBody, SECRETS[0].secret, ts);
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': SECRETS[0].id,
        'x-webhook-timestamp': ts,
      },
      rawBody: tamperedBody,
      secrets: SECRETS,
      requestId: 'r-tamper',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.errorCode).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('REJECTS signature forged for a different key-id (even if HMAC is valid for another secret)', async () => {
    const payload = '{}';
    // Signed with key-beta's secret but presented as key-alpha.
    // A timestamp is included so the request reaches the HMAC comparison and
    // this test keeps exercising the key-swap path specifically.
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = computeWebhookSignature(payload, SECRETS[1].secret, ts);
    const outcome = verifyWebhookRequest({
    // Signed with key-beta's secret but presented as key-alpha
    const sig = computeWebhookSignature(payload, SECRETS[1].secret);
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': SECRETS[0].id,
        'x-webhook-timestamp': ts,
      },
      rawBody: payload,
      secrets: SECRETS,
      requestId: 'r-key-swap',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.errorCode).toBe('AUTH_INVALID_SIGNATURE');
  });

  it('rejects empty-string signature with missing_signature_header flow', async () => {
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': '',
        'x-webhook-key-id': SECRETS[0].id,
      },
      rawBody: '{}',
      secrets: SECRETS,
      requestId: 'r-empty-sig',
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
  });

  it('uses default maxAgeSeconds=300 when not explicitly provided', async () => {
    const payload = '{}';
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = computeWebhookSignature(payload, SECRETS[0].secret, ts);
    const outcome = await verifyWebhookRequest({
      headers: {
        'x-webhook-signature': sig,
        'x-webhook-key-id': SECRETS[0].id,
        'x-webhook-timestamp': ts,
      },
      rawBody: payload,
      secrets: SECRETS,
    });
    expect(outcome.authenticated).toBe(true);
  });
});

describe('Issue #853 — replay protection at the request boundary', () => {
  const SECRETS = [{ id: 'key-alpha', secret: 'whsec_alpha_abc123' }];
  const BODY = '{"action":"transfer","amount":10}';

  function signedHeaders(body: string, timestamp: string | null, secret = 'whsec_alpha_abc123') {
    return {
      'x-webhook-signature': computeWebhookSignature(body, secret, timestamp ?? undefined),
      'x-webhook-key-id': 'key-alpha',
      ...(timestamp === null ? {} : { 'x-webhook-timestamp': timestamp }),
    };
  }

  it('REJECTS a request that carries no timestamp (would otherwise replay forever)', () => {
    const outcome = verifyWebhookRequest({
      headers: signedHeaders(BODY, null),
      rawBody: BODY,
      secrets: SECRETS,
    });

    expect(outcome.authenticated).toBe(false);
    expect(outcome.statusCode).toBe(401);
    expect(outcome.errorCode).toBe('AUTH_MISSING_TIMESTAMP');
  });

  it('ACCEPTS the same timestamp-less request when legacy mode is opted into', () => {
    const outcome = verifyWebhookRequest({
      headers: signedHeaders(BODY, null),
      rawBody: BODY,
      secrets: SECRETS,
      requireTimestamp: false,
    });
    expect(outcome.authenticated).toBe(true);
  });

  it('REJECTS a captured request replayed after the freshness window has passed', () => {
    const realNow = Date.now;
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = signedHeaders(BODY, ts);

      const first = verifyWebhookRequest({
        headers,
        rawBody: BODY,
        secrets: SECRETS,
        maxAgeSeconds: 300,
      });
      expect(first.authenticated).toBe(true);

      // Replay one hour later with the exact same captured headers.
      Date.now = () => realNow() + 60 * 60 * 1000;
      const replay = verifyWebhookRequest({
        headers,
        rawBody: BODY,
        secrets: SECRETS,
        maxAgeSeconds: 300,
      });

      expect(replay.authenticated).toBe(false);
      expect(replay.errorCode).toBe('AUTH_TIMESTAMP_EXPIRED');
    } finally {
      Date.now = realNow;
    }
  });

  it('REJECTS a verbatim replay inside the freshness window via the replay cache', () => {
    const replayCache = new WebhookReplayCache();
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(BODY, ts);

    const first = verifyWebhookRequest({
      headers,
      rawBody: BODY,
      secrets: SECRETS,
      replayCache,
    });
    expect(first.authenticated).toBe(true);

    // Same signature, no Idempotency-Key header — the pre-existing replay
    // defence the attacker would trivially bypass.
    const second = verifyWebhookRequest({
      headers,
      rawBody: BODY,
      secrets: SECRETS,
      replayCache,
    });

    expect(second.authenticated).toBe(false);
    expect(second.statusCode).toBe(409);
    expect(second.errorCode).toBe('AUTH_REPLAY_DETECTED');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('replayed request'),
      expect.objectContaining({ keyId: 'key-alpha' })
    );
  });

  it('replay cache does not reject a genuinely new request from the same key', () => {
    const replayCache = new WebhookReplayCache();
    const ts = String(Math.floor(Date.now() / 1000));

    const a = verifyWebhookRequest({
      headers: signedHeaders(BODY, ts),
      rawBody: BODY,
      secrets: SECRETS,
      replayCache,
    });
    const other = '{"action":"transfer","amount":20}';
    const b = verifyWebhookRequest({
      headers: signedHeaders(other, ts),
      rawBody: other,
      secrets: SECRETS,
      replayCache,
    });

    expect(a.authenticated).toBe(true);
    expect(b.authenticated).toBe(true);
  });

  it('does not record invalid signatures in the replay cache', () => {
    const replayCache = new WebhookReplayCache();
    const ts = String(Math.floor(Date.now() / 1000));

    const bad = verifyWebhookRequest({
      headers: signedHeaders(BODY, ts, 'some_other_secret'),
      rawBody: BODY,
      secrets: SECRETS,
      replayCache,
    });
    expect(bad.authenticated).toBe(false);

    // The genuine request must still be accepted afterwards.
    const good = verifyWebhookRequest({
      headers: signedHeaders(BODY, ts),
      rawBody: BODY,
      secrets: SECRETS,
      replayCache,
    });
    expect(good.authenticated).toBe(true);
  });

  it('REJECTS a non-integer timestamp instead of silently truncating it', () => {
    const ts = `${Math.floor(Date.now() / 1000)}garbage`;
    const outcome = verifyWebhookRequest({
      headers: signedHeaders(BODY, ts),
      rawBody: BODY,
      secrets: SECRETS,
    });

    expect(outcome.authenticated).toBe(false);
    expect(outcome.errorCode).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('REJECTS a fractional timestamp', () => {
    const ts = `${Math.floor(Date.now() / 1000)}.9`;
    const outcome = verifyWebhookRequest({
      headers: signedHeaders(BODY, ts),
      rawBody: BODY,
      secrets: SECRETS,
    });
    expect(outcome.authenticated).toBe(false);
    expect(outcome.errorCode).toBe('AUTH_TIMESTAMP_EXPIRED');
  });

  it('accepts an uppercase hex signature (hex is case-insensitive)', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(BODY, ts);
    const outcome = verifyWebhookRequest({
      headers: {
        ...headers,
        'x-webhook-signature': headers['x-webhook-signature'].toUpperCase(),
      },
      rawBody: BODY,
      secrets: SECRETS,
    });

    expect(outcome.authenticated).toBe(true);
  });

  it('still rejects a genuine signature whose hex case was altered', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(BODY, ts);
    const tampered = headers['x-webhook-signature'].replace(/.$/, (c) =>
      c === 'a' ? 'b' : 'a'
    );
    const outcome = verifyWebhookRequest({
      headers: { ...headers, 'x-webhook-signature': tampered },
      rawBody: BODY,
      secrets: SECRETS,
    });
    expect(outcome.authenticated).toBe(false);
  });
});
