/**
 * Tests for the Webhook Consumer Verification Example (#991)
 *
 * Verifies that the reference consumer:
 *  - Accepts a correctly signed request
 *  - Rejects a request with an invalid signature (wrong secret)
 *  - Rejects a request with a tampered body
 *  - Rejects a request with an expired timestamp
 *  - Rejects a request with a missing signature header
 *  - Rejects a request with a missing key-id header
 *  - Rejects a request with an unknown key-id
 *  - Rejects a request with a malformed signature prefix
 */

import crypto from 'crypto';
import {
  verifyNotification,
  buildSigningInput,
  isTimestampFresh,
} from './webhook-consumer-verification-example';
import type { IncomingHttpHeaders } from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'change-me-in-production';
const TEST_KEY_ID = 'key-1';

function sign(rawBody: string, secret: string, timestamp: string): string {
  const signingInput = `${timestamp}.${rawBody}`;
  const hex = crypto.createHmac('sha256', secret).update(signingInput, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function staleTimestamp(): string {
  return String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
}

function futureTimestamp(): string {
  return String(Math.floor(Date.now() / 1000) + 200); // 3+ minutes ahead (beyond skew tolerance)
}

function makeHeaders(
  signature: string,
  keyId: string,
  timestamp: string,
): IncomingHttpHeaders {
  return {
    'x-webhook-signature': signature,
    'x-webhook-key-id': keyId,
    'x-webhook-timestamp': timestamp,
  };
}

const SAMPLE_BODY = JSON.stringify({
  type: 'notification',
  id: 'evt-test-001',
  contractAddress: 'CEXAMPLE',
  eventName: 'transfer',
});

// ─── buildSigningInput ────────────────────────────────────────────────────────

describe('buildSigningInput', () => {
  it('returns timestamp.body when timestamp is provided', () => {
    expect(buildSigningInput('{"a":1}', '1700000000')).toBe('1700000000.{"a":1}');
  });

  it('returns raw body when timestamp is null', () => {
    expect(buildSigningInput('{"a":1}', null)).toBe('{"a":1}');
  });

  it('returns raw body when timestamp is empty string', () => {
    expect(buildSigningInput('{"a":1}', '')).toBe('{"a":1}');
  });
});

// ─── isTimestampFresh ─────────────────────────────────────────────────────────

describe('isTimestampFresh', () => {
  it('accepts a current timestamp', () => {
    expect(isTimestampFresh(freshTimestamp())).toBe(true);
  });

  it('rejects a stale timestamp (> 5 minutes old)', () => {
    expect(isTimestampFresh(staleTimestamp())).toBe(false);
  });

  it('rejects a timestamp far in the future (> 60 s ahead)', () => {
    expect(isTimestampFresh(futureTimestamp())).toBe(false);
  });

  it('accepts a timestamp slightly in the future (within clock-skew tolerance)', () => {
    const slightlyAhead = String(Math.floor(Date.now() / 1000) + 30);
    expect(isTimestampFresh(slightlyAhead)).toBe(true);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(isTimestampFresh('not-a-number')).toBe(false);
  });

  it('rejects an empty string timestamp', () => {
    expect(isTimestampFresh('')).toBe(false);
  });
});

// ─── verifyNotification ───────────────────────────────────────────────────────

describe('verifyNotification', () => {
  // ── Valid requests ────────────────────────────────────────────────────────

  describe('valid requests', () => {
    it('returns valid:true for a correctly signed request', () => {
      const ts = freshTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.valid).toBe(true);
      expect(result.keyId).toBe(TEST_KEY_ID);
      expect(result.reason).toBeUndefined();
    });

    it('returns keyId in the result on success', () => {
      const ts = freshTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.keyId).toBe(TEST_KEY_ID);
    });
  });

  // ── Missing headers ───────────────────────────────────────────────────────

  describe('missing headers', () => {
    it('rejects when X-Webhook-Signature is missing', () => {
      const ts = freshTimestamp();
      const result = verifyNotification(SAMPLE_BODY, {
        'x-webhook-key-id': TEST_KEY_ID,
        'x-webhook-timestamp': ts,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Missing X-Webhook-Signature/i);
    });

    it('rejects when X-Webhook-Key-Id is missing', () => {
      const ts = freshTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, {
        'x-webhook-signature': sig,
        'x-webhook-timestamp': ts,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Missing X-Webhook-Key-Id/i);
    });
  });

  // ── Wrong or unknown key ─────────────────────────────────────────────────

  describe('invalid key-id', () => {
    it('rejects an unknown key-id', () => {
      const ts = freshTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, 'unknown-key', ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Unknown key-id/i);
    });
  });

  // ── Wrong secret ──────────────────────────────────────────────────────────

  describe('wrong secret', () => {
    it('rejects a signature computed with the wrong secret', () => {
      const ts = freshTimestamp();
      const sig = sign(SAMPLE_BODY, 'completely-wrong-secret', ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HMAC mismatch/i);
    });
  });

  // ── Tampered body ─────────────────────────────────────────────────────────

  describe('tampered body', () => {
    it('rejects when the body was modified after signing', () => {
      const ts = freshTimestamp();
      const originalBody = JSON.stringify({ action: 'transfer', amount: 10 });
      const tamperedBody = JSON.stringify({ action: 'transfer', amount: 1_000_000 });
      const sig = sign(originalBody, TEST_SECRET, ts);

      const result = verifyNotification(tamperedBody, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HMAC mismatch/i);
    });
  });

  // ── Expired / invalid timestamp ───────────────────────────────────────────

  describe('timestamp validation', () => {
    it('rejects when the timestamp is too old (replay attack)', () => {
      const ts = staleTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/timestamp expired/i);
    });

    it('rejects when the timestamp is too far in the future', () => {
      const ts = futureTimestamp();
      const sig = sign(SAMPLE_BODY, TEST_SECRET, ts);
      const result = verifyNotification(SAMPLE_BODY, makeHeaders(sig, TEST_KEY_ID, ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/timestamp expired/i);
    });

    it('still verifies correctly when no timestamp header is provided (legacy mode)', () => {
      // Without timestamp the signing input is just the raw body
      const hex = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(SAMPLE_BODY, 'utf8')
        .digest('hex');
      const sig = `sha256=${hex}`;
      const result = verifyNotification(SAMPLE_BODY, {
        'x-webhook-signature': sig,
        'x-webhook-key-id': TEST_KEY_ID,
        // No x-webhook-timestamp
      });
      expect(result.valid).toBe(true);
    });
  });

  // ── Malformed signature format ────────────────────────────────────────────

  describe('malformed signature', () => {
    it('rejects a signature without the sha256= prefix', () => {
      const ts = freshTimestamp();
      const result = verifyNotification(SAMPLE_BODY, {
        'x-webhook-signature': 'md5=deadbeef',
        'x-webhook-key-id': TEST_KEY_ID,
        'x-webhook-timestamp': ts,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/Invalid signature format/i);
    });

    it('rejects a signature with an incorrect hex length', () => {
      const ts = freshTimestamp();
      const result = verifyNotification(SAMPLE_BODY, makeHeaders('sha256=abc', TEST_KEY_ID, ts));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/length mismatch/i);
    });
  });
});
