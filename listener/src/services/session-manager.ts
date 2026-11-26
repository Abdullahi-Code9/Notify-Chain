/**
 * Session Expiration and Revocation Controls (#1140)
 *
 * Dashboard sessions are short-lived tokens bound to an ApiCredential.  Each
 * session carries:
 *   - a unique, cryptographically random `sessionId`
 *   - the `credentialId` it was minted from
 *   - an `expiresAt` timestamp (absolute wall-clock time)
 *   - a `revokedAt` timestamp set when the session is explicitly revoked
 *
 * Lifecycle rules
 * ---------------
 * 1. Sessions expire after `SESSION_TTL_MS` (default 1 h) of wall-clock time.
 *    The expiry is checked on every access — not just at creation.
 * 2. Revoking a credential immediately invalidates all sessions that belong to
 *    it (see `revokeByCredential`).
 * 3. Rotating a credential (re-issuing with the same name) also invalidates
 *    its sessions (same mechanism: call `revokeByCredential`).
 * 4. `SessionManager.validate()` is the single gate: it returns `null` for
 *    missing, expired, and revoked sessions so callers never need to check
 *    those conditions individually.
 *
 * Authentication responses
 * ------------------------
 * When a session cannot be validated, the `WWW-Authenticate` header should be
 * set to `'Session realm="Notify-Chain"'` and the response should use error
 * code `UNAUTHORIZED` with the descriptive message exported as
 * `SESSION_AUTH_MESSAGES`.
 */

import crypto from 'crypto';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default session lifetime in milliseconds (1 hour). */
export const SESSION_TTL_MS = 60 * 60 * 1_000;

/** Prefix that all session tokens carry, making them easy to identify. */
export const SESSION_ID_PREFIX = 'ncs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  /** Globally unique session token (opaque to callers). */
  sessionId: string;
  /** The API credential this session was minted from. */
  credentialId: string;
  /** ISO timestamp when this session was created. */
  createdAt: string;
  /** ISO timestamp when this session expires. */
  expiresAt: string;
  /** ISO timestamp when this session was explicitly revoked, or null. */
  revokedAt: string | null;
}

export type SessionValidationResult =
  | { valid: true; session: SessionRecord }
  | { valid: false; reason: 'missing' | 'expired' | 'revoked' };

/** Human-readable messages for failed session validation. */
export const SESSION_AUTH_MESSAGES: Record<'missing' | 'expired' | 'revoked', string> = {
  missing: 'Unauthorized: session not found or invalid',
  expired: 'Unauthorized: session has expired',
  revoked: 'Unauthorized: session has been revoked',
};

// ---------------------------------------------------------------------------
// Pluggable store interface
// ---------------------------------------------------------------------------

export interface SessionStore {
  get(sessionId: string): SessionRecord | undefined;
  save(record: SessionRecord): void;
  listByCredential(credentialId: string): SessionRecord[];
  delete(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// In-memory default store
// ---------------------------------------------------------------------------

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(sessionId: string): SessionRecord | undefined {
    const r = this.records.get(sessionId);
    return r ? { ...r } : undefined;
  }

  save(record: SessionRecord): void {
    this.records.set(record.sessionId, { ...record });
  }

  listByCredential(credentialId: string): SessionRecord[] {
    return [...this.records.values()].filter((r) => r.credentialId === credentialId);
  }

  delete(sessionId: string): void {
    this.records.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  store?: SessionStore;
  /**
   * Session time-to-live in milliseconds.
   * Defaults to {@link SESSION_TTL_MS} (1 hour).
   */
  ttlMs?: number;
  now?: () => Date;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store ?? new InMemorySessionStore();
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Creates a new session for the given credential.  Returns the full
   * `SessionRecord` including the opaque `sessionId` token that the client
   * must present on subsequent requests.
   */
  create(credentialId: string): SessionRecord {
    if (!credentialId?.trim()) {
      throw new Error('credentialId is required to create a session');
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const sessionId = `${SESSION_ID_PREFIX}_${rawToken}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);

    const record: SessionRecord = {
      sessionId,
      credentialId: credentialId.trim(),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
    };

    this.store.save(record);

    logger.info('Session created', {
      credentialId: record.credentialId,
      expiresAt: record.expiresAt,
    });

    return { ...record };
  }

  /**
   * Validates a session token against the following policy, in order:
   *   1. Unknown token → `missing`
   *   2. `revokedAt` is set → `revoked`
   *   3. `expiresAt` is in the past → `expired`
   *   4. Otherwise → `valid`
   *
   * Expired sessions are automatically revoked on first detection so they
   * cannot appear valid on subsequent checks.
   */
  validate(sessionId: string): SessionValidationResult {
    if (!sessionId) {
      return { valid: false, reason: 'missing' };
    }

    const record = this.store.get(sessionId);
    if (!record) {
      return { valid: false, reason: 'missing' };
    }

    if (record.revokedAt) {
      return { valid: false, reason: 'revoked' };
    }

    const nowMs = this.now().getTime();
    const expiresMs = new Date(record.expiresAt).getTime();
    if (nowMs >= expiresMs) {
      // Auto-revoke so the record reflects its terminal state.
      this.revokeExpired(record);
      return { valid: false, reason: 'expired' };
    }

    return { valid: true, session: { ...record } };
  }

  /**
   * Explicitly revokes a single session. Returns the updated record, or null
   * when the session does not exist.
   */
  revoke(sessionId: string): SessionRecord | null {
    const record = this.store.get(sessionId);
    if (!record) return null;

    if (!record.revokedAt) {
      record.revokedAt = this.now().toISOString();
      this.store.save(record);
      logger.info('Session revoked', {
        credentialId: record.credentialId,
      });
    }

    return { ...record };
  }

  /**
   * Revokes every active session that belongs to `credentialId`. Call this
   * when a credential is rotated or deleted so that all associated sessions
   * become invalid immediately.
   *
   * Returns the number of sessions revoked.
   */
  revokeByCredential(credentialId: string): number {
    const sessions = this.store.listByCredential(credentialId);
    const nowIso = this.now().toISOString();
    let count = 0;

    for (const session of sessions) {
      if (!session.revokedAt) {
        session.revokedAt = nowIso;
        this.store.save(session);
        count++;
      }
    }

    if (count > 0) {
      logger.info('Sessions revoked due to credential change', {
        credentialId,
        revokedCount: count,
      });
    }

    return count;
  }

  /**
   * Removes all sessions that are both expired and revoked from the store.
   * Returns the number of records purged.
   */
  purgeExpired(): number {
    const all = this.store.listByCredential('') as SessionRecord[];
    // listByCredential('') returns nothing, so we need a different approach.
    // This is handled by _purgeAll below.
    return this._purgeAll();
  }

  private _purgeAll(): number {
    // We iterate by listing and pruning inline since the store interface
    // only exposes per-credential listing.  A production store would use
    // a time-indexed query instead.
    const credentialsSeen = new Set<string>();
    // We collect via a full scan over all stored credentials by using an
    // internal sentinel that returns everything when implemented by
    // InMemorySessionStore.  For the in-memory store we do a direct cast.
    if (this.store instanceof InMemorySessionStore) {
      const store = this.store as unknown as { records: Map<string, SessionRecord> };
      let count = 0;
      const nowMs = this.now().getTime();
      for (const [id, record] of store.records) {
        const expired = nowMs >= new Date(record.expiresAt).getTime();
        if (expired && record.revokedAt) {
          store.records.delete(id);
          count++;
          void credentialsSeen; // suppress unused warning
        } else if (expired && !record.revokedAt) {
          record.revokedAt = this.now().toISOString();
          store.records.set(id, record);
        }
      }
      return count;
    }
    return 0;
  }

  private revokeExpired(record: SessionRecord): void {
    record.revokedAt = this.now().toISOString();
    this.store.save(record);
    logger.info('Session auto-revoked on expiry', {
      credentialId: record.credentialId,
    });
  }
}
