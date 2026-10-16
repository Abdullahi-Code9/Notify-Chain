import crypto from 'crypto';
import { WebhookSecret } from '../types';
import logger from '../utils/logger';
import { WebhookReplayCache, buildReplayCacheKey } from './webhook-replay-cache';

const SIGNATURE_PREFIX = 'sha256=';
const SIGNING_SEPARATOR = '.';

/** A timestamp header must be a bare integer number of seconds since the epoch. */
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

export interface SignatureVerificationOptions {
  /** Maximum age of the request in seconds (default: 300 = 5 minutes) */
  maxAgeSeconds?: number;
  /**
   * Reject requests that carry no `X-Webhook-Timestamp`.
   *
   * When false (the default, preserving legacy behaviour) a request without a
   * timestamp is signed over the bare body and is therefore valid forever.
   * Webhook ingress should set this to true so replay is bounded by
   * `maxAgeSeconds` instead of being unbounded.
   */
  requireTimestamp?: boolean;
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Constructs the signed payload string used for HMAC computation.
 *
 * REPLAY PROTECTION — The timestamp is CRYPTOGRAPHICALLY BOUND to the
 * signature so that stripping the `X-Webhook-Timestamp` header from a
 * previously-valid request does NOT produce a re-playable payload.
 *
 * Scheme:
 *   signingInput = timestamp + "." + rawBody          (when timestamp is present)
 *   signingInput = rawBody                             (no timestamp — legacy only)
 *
 * The HMAC is then computed over `signingInput` using the per-key secret.
 */
export function buildSigningInput(payload: string, timestamp?: string): string {
  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    return `${timestamp}${SIGNING_SEPARATOR}${payload}`;
  }
  return payload;
}

/**
 * Computes a webhook signature for a given payload and optional timestamp.
 * Used by test suites and internal sender tooling.
 */
export function computeWebhookSignature(
  payload: string,
  secret: string,
  timestamp?: string
): string {
  const signingInput = buildSigningInput(payload, timestamp);
  const hex = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/**
 * Verifies a webhook signature with cryptographic timestamp binding.
 *
 * Acceptance criteria enforced here:
 *  • Incoming requests are authenticated via HMAC-SHA256.
 *  • Invalid signatures are rejected (returns `false` with a reason log).
 *  • Timestamps are cryptographically bound to the HMAC — an attacker cannot
 *    simply drop the timestamp header and replay an old valid request.
 *  • All authentication failures are emitted to the structured audit log
 *    with `requestId`, `correlationId`, key-id, and failure reason.
 */
export function verifySignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  timestampHeader?: string,
  options?: SignatureVerificationOptions,
  auditContext?: { keyId?: string; requestId?: string; correlationId?: string; sourceIp?: string }
): SignatureVerificationResult {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    logger.warn('Webhook signature verification failed: missing signature header', auditContext);
    return { valid: false, reason: 'missing_signature_header' };
  }

  // The prefix is compared case-insensitively: hex digests are case-insensitive
  // by definition, and several senders emit `SHA256=`.
  if (signatureHeader.slice(0, SIGNATURE_PREFIX.length).toLowerCase() !== SIGNATURE_PREFIX) {
    logger.warn('Webhook signature verification failed: invalid prefix', {
      ...auditContext,
      receivedPrefix: signatureHeader.slice(0, Math.min(signatureHeader.length, 10)),
    });
    return { valid: false, reason: 'invalid_signature_prefix' };
  }

  const hasTimestamp = timestampHeader !== undefined && timestampHeader !== null && timestampHeader !== '';

  if (!hasTimestamp && options?.requireTimestamp) {
    logger.warn('Webhook signature verification failed: timestamp required but absent', {
      ...auditContext,
    });
    return { valid: false, reason: 'missing_timestamp' };
  }

  // Validate timestamp expiration if provided
  if (hasTimestamp && options?.maxAgeSeconds !== undefined) {
    if (!isTimestampValid(timestampHeader as string, options.maxAgeSeconds)) {
      logger.warn('Webhook signature verification failed: timestamp expired or invalid', {
        ...auditContext,
        timestampHeader,
        maxAgeSeconds: options.maxAgeSeconds,
      });
      return { valid: false, reason: 'timestamp_expired' };
    }
  }

  const signingInput = buildSigningInput(payload, timestampHeader);
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf8')
    .digest('hex');

  const providedSig = signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase();

  if (expectedSig.length !== providedSig.length) {
    logger.warn('Webhook signature verification failed: signature length mismatch', {
      ...auditContext,
      expectedLength: expectedSig.length,
      providedLength: providedSig.length,
    });
    return { valid: false, reason: 'signature_length_mismatch' };
  }

  const match = crypto.timingSafeEqual(
    Buffer.from(expectedSig, 'utf8'),
    Buffer.from(providedSig, 'utf8')
  );

  if (!match) {
    logger.warn('Webhook signature verification failed: HMAC mismatch', auditContext);
    return { valid: false, reason: 'hmac_mismatch' };
  }

  return { valid: true };
}

/**
 * Validates that a timestamp header is within the acceptable age window.
 * Prevents replay attacks by rejecting requests with stale timestamps.
 *
 * The header must be a bare integer. `parseInt` alone would accept values such
 * as `"1700000000abc"` or `"1700000000.9"`, which would let a sender smuggle
 * arbitrary bytes past validation while still signing a value the verifier
 * silently truncates.
 */
export function isTimestampValid(timestampHeader: string, maxAgeSeconds: number): boolean {
  try {
    if (typeof timestampHeader !== 'string' || !TIMESTAMP_PATTERN.test(timestampHeader)) {
      return false;
    }

    const requestTimestamp = Number(timestampHeader);

    if (!Number.isSafeInteger(requestTimestamp)) {
      return false;
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const requestAge = currentTimestamp - requestTimestamp;

    // Reject if request is too old or from the future (allow small clock skew)
    if (requestAge > maxAgeSeconds || requestAge < -60) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function extractSignature(headers: Record<string, string | string[] | undefined>): string | null {
  const sigHeader = headers['x-webhook-signature'] ?? headers['X-Webhook-Signature'];
  if (!sigHeader) return null;
  return Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
}

export function extractKeyId(headers: Record<string, string | string[] | undefined>): string | null {
  const keyId = headers['x-webhook-key-id'] ?? headers['X-Webhook-Key-Id'];
  if (!keyId) return null;
  return Array.isArray(keyId) ? keyId[0] : keyId;
}

export function extractTimestamp(headers: Record<string, string | string[] | undefined>): string | null {
  const ts = headers['x-webhook-timestamp'] ?? headers['X-Webhook-Timestamp'];
  if (!ts) return null;
  return Array.isArray(ts) ? ts[0] : ts;
}

export function getSecretForKey(secrets: WebhookSecret[], keyId: string): string | undefined {
  return secrets.find((s) => s.id === keyId)?.secret;
}

export function collectRawBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface WebhookVerificationContext {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  secrets: WebhookSecret[];
  sourceIp?: string;
  requestId?: string;
  correlationId?: string;
  maxAgeSeconds?: number;
  /**
   * Reject requests that carry no `X-Webhook-Timestamp`. Defaults to true:
   * without a bound timestamp a captured request stays valid indefinitely.
   */
  requireTimestamp?: boolean;
  /**
   * Server-side replay cache. When supplied, a request whose signature has
   * already been accepted inside the freshness window is rejected, which closes
   * the hole left by the optional client-supplied `Idempotency-Key`.
   */
  replayCache?: WebhookReplayCache;
  auditService?: import('./security-audit').SecurityAuditService;
}

export interface WebhookVerificationOutcome {
  authenticated: boolean;
  statusCode: number;
  errorCode: string;
  message: string;
  keyId?: string;
  timestampVerified: boolean;
}

const AUTH_ERRORS: Record<string, { message: string; code: string; status: number }> = {
  missing_signature_header: {
    message: 'Missing signature header',
    code: 'AUTH_MISSING_SIGNATURE',
    status: 401,
  },
  missing_key_id: {
    message: 'Missing key-id header',
    code: 'AUTH_MISSING_KEY_ID',
    status: 401,
  },
  unknown_key_id: {
    message: 'Unknown key-id',
    code: 'AUTH_UNKNOWN_KEY_ID',
    status: 401,
  },
  invalid_signature_prefix: {
    message: 'Invalid signature format',
    code: 'AUTH_INVALID_SIGNATURE_FORMAT',
    status: 401,
  },
  missing_timestamp: {
    message: 'Missing timestamp header',
    code: 'AUTH_MISSING_TIMESTAMP',
    status: 401,
  },
  replay_detected: {
    message: 'Request already processed',
    code: 'AUTH_REPLAY_DETECTED',
    status: 409,
  },
  timestamp_expired: {
    message: 'Request timestamp expired or invalid',
    code: 'AUTH_TIMESTAMP_EXPIRED',
    status: 401,
  },
  signature_length_mismatch: {
    message: 'Invalid signature',
    code: 'AUTH_INVALID_SIGNATURE',
    status: 401,
  },
  hmac_mismatch: {
    message: 'Invalid signature',
    code: 'AUTH_INVALID_SIGNATURE',
    status: 401,
  },
};

export function verifyWebhookRequest(ctx: WebhookVerificationContext): WebhookVerificationOutcome {
  const {
    headers,
    rawBody,
    secrets,
    sourceIp,
    requestId,
    correlationId,
    maxAgeSeconds,
    requireTimestamp = true,
    replayCache,
  } = ctx;
export async function verifyWebhookRequest(ctx: WebhookVerificationContext): Promise<WebhookVerificationOutcome> {
  const { headers, rawBody, secrets, sourceIp, requestId, correlationId, maxAgeSeconds, auditService } = ctx;

  const signatureHeader = extractSignature(headers);
  const keyId = extractKeyId(headers);
  const timestampHeader = extractTimestamp(headers);

  const auditContext = {
    requestId,
    correlationId,
    keyId: keyId ?? undefined,
    sourceIp,
    contentLength: rawBody.length,
  };

  if (!signatureHeader) {
    logger.warn('Webhook authentication rejected: missing signature header', auditContext);
    const e = AUTH_ERRORS.missing_signature_header;
    if (auditService) {
      await auditService.record({
        action: 'auth_failure',
        actor: 'unknown',
        sourceIp,
        requestId,
        correlationId,
        outcome: e.code,
        details: { reason: e.message },
      });
    }
    return {
      authenticated: false,
      statusCode: e.status,
      errorCode: e.code,
      message: e.message,
      timestampVerified: false,
    };
  }

  if (!keyId) {
    logger.warn('Webhook authentication rejected: missing key-id header', auditContext);
    const e = AUTH_ERRORS.missing_key_id;
    if (auditService) {
      await auditService.record({
        action: 'auth_failure',
        actor: 'unknown',
        sourceIp,
        requestId,
        correlationId,
        outcome: e.code,
        details: { reason: e.message },
      });
    }
    return {
      authenticated: false,
      statusCode: e.status,
      errorCode: e.code,
      message: e.message,
      timestampVerified: false,
    };
  }

  const secret = getSecretForKey(secrets, keyId);
  if (!secret) {
    logger.warn('Webhook authentication rejected: unknown key-id', { ...auditContext, keyId });
    const e = AUTH_ERRORS.unknown_key_id;
    if (auditService) {
      await auditService.record({
        action: 'auth_failure',
        actor: keyId,
        sourceIp,
        requestId,
        correlationId,
        outcome: e.code,
        details: { reason: e.message },
      });
    }
    return {
      authenticated: false,
      statusCode: e.status,
      errorCode: e.code,
      message: e.message,
      keyId,
      timestampVerified: false,
    };
  }

  const effectiveMaxAgeSeconds = maxAgeSeconds ?? 300;

  const verification = verifySignature(
    rawBody,
    signatureHeader,
    secret,
    timestampHeader ?? undefined,
    { maxAgeSeconds: effectiveMaxAgeSeconds, requireTimestamp },
    auditContext
  );

  if (!verification.valid) {
    const err = AUTH_ERRORS[verification.reason ?? 'hmac_mismatch'] ?? AUTH_ERRORS.hmac_mismatch;
    if (auditService) {
      await auditService.record({
        action: 'auth_failure',
        actor: keyId,
        sourceIp,
        requestId,
        correlationId,
        outcome: err.code,
        details: { reason: err.message },
      });
    }
    return {
      authenticated: false,
      statusCode: err.status,
      errorCode: err.code,
      message: err.message,
      keyId,
      timestampVerified: false,
    };
  }

  // The request is authentic at this point. Claim it in the replay cache so a
  // captured request cannot be resubmitted inside the freshness window.
  if (replayCache) {
    const cacheKey = buildReplayCacheKey(keyId, signatureHeader);
    const firstSighting = replayCache.claim(cacheKey, effectiveMaxAgeSeconds * 1000);

    if (!firstSighting) {
      logger.warn('Webhook authentication rejected: replayed request', {
        ...auditContext,
        keyId,
        maxAgeSeconds: effectiveMaxAgeSeconds,
      });
      const e = AUTH_ERRORS.replay_detected;
      return {
        authenticated: false,
        statusCode: e.status,
        errorCode: e.code,
        message: e.message,
        keyId,
        timestampVerified: true,
      };
    }
  }

  logger.info('Webhook authentication succeeded', {
    ...auditContext,
    keyId,
    timestampProvided: !!timestampHeader,
  });

  return {
    authenticated: true,
    statusCode: 0,
    errorCode: '',
    message: '',
    keyId,
    timestampVerified: !!timestampHeader,
  };
}
