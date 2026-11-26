/**
 * Tests for SessionManager (#1140)
 *
 * Covers:
 *   - Session creation and structure
 *   - Expiry enforcement (server-side)
 *   - Explicit revocation
 *   - Credential-level revocation (all sessions for a credential)
 *   - Clear auth responses for each failure reason
 */

import {
  SessionManager,
  InMemorySessionStore,
  SESSION_TTL_MS,
  SESSION_ID_PREFIX,
  SESSION_AUTH_MESSAGES,
} from './session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(overrides: { ttlMs?: number; now?: () => Date } = {}): SessionManager {
  return new SessionManager({
    store: new InMemorySessionStore(),
    ttlMs: overrides.ttlMs ?? SESSION_TTL_MS,
    now: overrides.now,
  });
}

const BASE_TIME = new Date('2026-11-23T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe('SessionManager.create()', () => {
  it('returns a session with the correct credentialId', () => {
    const mgr = makeManager();
    const session = mgr.create('cred-abc');
    expect(session.credentialId).toBe('cred-abc');
  });

  it('assigns a unique session id with the expected prefix', () => {
    const mgr = makeManager();
    const a = mgr.create('cred-1');
    const b = mgr.create('cred-1');
    expect(a.sessionId).toMatch(new RegExp(`^${SESSION_ID_PREFIX}_`));
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('sets expiresAt to now + ttlMs', () => {
    const mgr = makeManager({ now: () => BASE_TIME });
    const session = mgr.create('cred-x');
    const expected = new Date(BASE_TIME.getTime() + SESSION_TTL_MS);
    expect(session.expiresAt).toBe(expected.toISOString());
  });

  it('starts with revokedAt = null', () => {
    const mgr = makeManager();
    const session = mgr.create('cred-y');
    expect(session.revokedAt).toBeNull();
  });

  it('throws when credentialId is empty', () => {
    const mgr = makeManager();
    expect(() => mgr.create('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation — valid
// ---------------------------------------------------------------------------

describe('SessionManager.validate() — valid session', () => {
  it('returns valid: true for a fresh session', () => {
    const mgr = makeManager({ now: () => BASE_TIME });
    const session = mgr.create('cred-1');
    const result = mgr.validate(session.sessionId);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.session.credentialId).toBe('cred-1');
    }
  });

  it('returns valid: true when called just before expiry', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('cred-2');
    tick = BASE_TIME.getTime() + SESSION_TTL_MS - 1;
    expect(mgr.validate(session.sessionId).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation — expired
// ---------------------------------------------------------------------------

describe('SessionManager.validate() — expired session', () => {
  it('returns valid: false with reason "expired" after TTL elapses', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('cred-3');

    // Advance clock past TTL
    tick += SESSION_TTL_MS + 1;
    const result = mgr.validate(session.sessionId);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('provides the correct auth message for "expired"', () => {
    expect(SESSION_AUTH_MESSAGES.expired).toContain('expired');
  });

  it('auto-revokes the session on expiry detection so subsequent checks are consistent', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('cred-4');
    tick += SESSION_TTL_MS + 1000;

    // First check: reason is 'expired'
    const first = mgr.validate(session.sessionId);
    expect(first.valid).toBe(false);
    if (!first.valid) expect(first.reason).toBe('expired');

    // Second check: now 'revoked' (auto-revoked)
    const second = mgr.validate(session.sessionId);
    expect(second.valid).toBe(false);
    if (!second.valid) expect(second.reason).toBe('revoked');
  });

  it('expired sessions cannot access a protected endpoint (simulate gate check)', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('cred-access');
    tick += SESSION_TTL_MS + 5000;
    // Gate: validate before allowing access
    const result = mgr.validate(session.sessionId);
    expect(result.valid).toBe(false);
    // Guard would return 401 here — session cannot proceed
  });
});

// ---------------------------------------------------------------------------
// Validation — missing
// ---------------------------------------------------------------------------

describe('SessionManager.validate() — missing session', () => {
  it('returns valid: false with reason "missing" for an unknown token', () => {
    const mgr = makeManager();
    const result = mgr.validate('ncs_nonexistent');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing');
  });

  it('returns valid: false with reason "missing" for an empty string', () => {
    const mgr = makeManager();
    const result = mgr.validate('');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing');
  });

  it('provides the correct auth message for "missing"', () => {
    expect(SESSION_AUTH_MESSAGES.missing).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Explicit revocation
// ---------------------------------------------------------------------------

describe('SessionManager.revoke()', () => {
  it('invalidates the session so validate returns revoked', () => {
    const mgr = makeManager({ now: () => BASE_TIME });
    const session = mgr.create('cred-rev');
    mgr.revoke(session.sessionId);
    const result = mgr.validate(session.sessionId);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('revoked');
  });

  it('returns the updated record with revokedAt set', () => {
    const mgr = makeManager({ now: () => BASE_TIME });
    const session = mgr.create('cred-rev2');
    const updated = mgr.revoke(session.sessionId);
    expect(updated).not.toBeNull();
    expect(updated!.revokedAt).toBe(BASE_TIME.toISOString());
  });

  it('returns null for an unknown session id', () => {
    const mgr = makeManager();
    expect(mgr.revoke('ncs_unknown')).toBeNull();
  });

  it('is idempotent — revoking twice keeps the first revokedAt', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('cred-idem');
    const first = mgr.revoke(session.sessionId)!;
    tick += 60_000;
    const second = mgr.revoke(session.sessionId)!;
    expect(first.revokedAt).toBe(second.revokedAt);
  });

  it('provides the correct auth message for "revoked"', () => {
    expect(SESSION_AUTH_MESSAGES.revoked).toContain('revoked');
  });
});

// ---------------------------------------------------------------------------
// Credential-level revocation
// ---------------------------------------------------------------------------

describe('SessionManager.revokeByCredential()', () => {
  it('revokes all active sessions for the credential', () => {
    const mgr = makeManager({ now: () => BASE_TIME });
    const s1 = mgr.create('cred-bulk');
    const s2 = mgr.create('cred-bulk');
    const s3 = mgr.create('other-cred');

    const count = mgr.revokeByCredential('cred-bulk');
    expect(count).toBe(2);

    expect(mgr.validate(s1.sessionId).valid).toBe(false);
    expect(mgr.validate(s2.sessionId).valid).toBe(false);
    // Session for a different credential is unaffected
    expect(mgr.validate(s3.sessionId).valid).toBe(true);
  });

  it('returns 0 when the credential has no active sessions', () => {
    const mgr = makeManager();
    expect(mgr.revokeByCredential('no-such-cred')).toBe(0);
  });

  it('credential change triggers session invalidation', () => {
    // Simulates: operator rotates a credential → all existing sessions die
    const mgr = makeManager({ now: () => BASE_TIME });
    const session = mgr.create('old-cred');
    expect(mgr.validate(session.sessionId).valid).toBe(true);

    // "Credential rotation" → revoke all sessions for old credential
    mgr.revokeByCredential('old-cred');

    const result = mgr.validate(session.sessionId);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle documentation
// ---------------------------------------------------------------------------

describe('Session lifecycle rules', () => {
  it('a session follows the documented states: active → expired → revoked', () => {
    let tick = BASE_TIME.getTime();
    const mgr = makeManager({ now: () => new Date(tick) });
    const session = mgr.create('lifecycle-cred');

    // Active
    expect(mgr.validate(session.sessionId).valid).toBe(true);

    // Expired
    tick += SESSION_TTL_MS + 1;
    const expiredResult = mgr.validate(session.sessionId);
    expect(expiredResult.valid).toBe(false);
    if (!expiredResult.valid) expect(expiredResult.reason).toBe('expired');

    // Auto-revoked on subsequent access
    const revokedResult = mgr.validate(session.sessionId);
    expect(revokedResult.valid).toBe(false);
    if (!revokedResult.valid) expect(revokedResult.reason).toBe('revoked');
  });
});
