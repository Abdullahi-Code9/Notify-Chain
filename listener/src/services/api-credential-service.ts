/**
 * Scoped API credential service (#988)
 *
 * Issues, verifies and revokes integration API keys that carry explicit
 * permission scopes.
 *
 * Secret handling
 * ---------------
 * - Keys have the form `nck_<16 hex id>_<43 char base64url secret>`. The id is
 *   a lookup handle; only the secret is sensitive.
 * - The secret is stored solely as an scrypt hash (memory-hard KDF from Node's
 *   crypto module) with a per-credential random salt, so a leaked store does
 *   not yield usable keys.
 * - The full key is returned only from `create()`. Every other read returns
 *   the public `ApiCredential` view, which has no secret or hash field.
 *
 * Because scrypt is deliberately expensive, a successful verification is
 * cached briefly under a SHA-256 of the presented key. Revocation clears the
 * cache entry immediately.
 */

import crypto from 'crypto';
import { promisify } from 'util';
import {
  isApiScope,
  type ApiCredential,
  type ApiCredentialRecord,
  type ApiScope,
  type CreateApiCredentialInput,
  type CreatedApiCredential,
} from '../types/api-credential';
import { fingerprintCredential } from '../utils/request-actor';

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const API_KEY_PREFIX = 'nck';
const API_KEY_PATTERN = /^nck_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const DEFAULT_VERIFY_CACHE_TTL_MS = 60_000;
export const MAX_CREDENTIAL_NAME_LENGTH = 100;

/** Pluggable persistence. The default keeps records in process memory. */
export interface ApiCredentialStore {
  get(id: string): ApiCredentialRecord | undefined;
  list(): ApiCredentialRecord[];
  save(record: ApiCredentialRecord): void;
}

export class InMemoryApiCredentialStore implements ApiCredentialStore {
  private readonly records = new Map<string, ApiCredentialRecord>();

  get(id: string): ApiCredentialRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record, scopes: [...record.scopes] } : undefined;
  }

  list(): ApiCredentialRecord[] {
    return [...this.records.values()].map((r) => ({ ...r, scopes: [...r.scopes] }));
  }

  save(record: ApiCredentialRecord): void {
    this.records.set(record.id, { ...record, scopes: [...record.scopes] });
  }
}

/**
 * Per-client usage accounting (#989)
 *
 * Records API consumption against a non-reversible client identifier so
 * operators can understand usage without ever persisting credential secrets.
 *
 * Identity
 * --------
 * - The client identifier is derived from the credential id (a public lookup
 *   handle) via `fingerprintCredential`, or from an already-fingerprinted
 *   actor string. Raw API keys / secrets are never accepted or stored.
 * - `fingerprintClient` is the single choke point that normalises any input
 *   into a stable, non-reversible identifier.
 *
 * Aggregation
 * -----------
 * - `record()` appends a usage event (client, route, timestamp).
 * - `getClientUsage()` / `getRouteUsage()` / `getUsageInWindow()` expose
 *   aggregations that are deterministic and therefore testable.
 */
export interface UsageEvent {
  /** Non-reversible client identifier (never a raw secret). */
  clientId: string;
  /** Route or logical operation the request targeted. */
  route: string;
  /** ISO timestamp of the request. */
  at: string;
}

export interface ClientUsageSummary {
  clientId: string;
  total: number;
  routes: Record<string, number>;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface RouteUsageSummary {
  route: string;
  total: number;
  clients: Record<string, number>;
}

export interface UsageWindow {
  from?: Date | string;
  to?: Date | string;
}

export interface UsageAccountingOptions {
  now?: () => Date;
  /** Optional cap on retained events to bound memory in long-lived processes. */
  maxEvents?: number;
}

const DEFAULT_MAX_USAGE_EVENTS = 100_000;

/**
 * Normalises any client identity into a non-reversible identifier.
 *
 * Accepts either an already-fingerprinted actor string (returned unchanged) or
 * a credential id, which is hashed via `fingerprintCredential`. Raw API keys
 * are rejected outright so secrets can never reach the store.
 */
export function fingerprintClient(identity: string): string {
  if (!identity) {
    throw new Error('client identity is required');
  }
  if (looksLikeScopedApiKey(identity)) {
    throw new Error('raw API keys must not be used as client identifiers');
  }
  return fingerprintCredential(identity);
}

function toMs(value: Date | string | undefined): number | null {
  if (value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export class UsageAccountingService {
  private readonly events: UsageEvent[] = [];
  private readonly now: () => Date;
  private readonly maxEvents: number;

  constructor(options: UsageAccountingOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_USAGE_EVENTS;
  }

  /**
   * Records a request for a client. The `clientIdentity` may be a credential
   * id or an already-fingerprinted actor; it is normalised via
   * `fingerprintClient` so no secret material is ever stored.
   */
  record(clientIdentity: string, route: string, at?: Date | string): UsageEvent {
    const clientId = fingerprintClient(clientIdentity);
    const timestamp = at === undefined ? this.now().toISOString() : new Date(at).toISOString();
    const event: UsageEvent = { clientId, route, at: timestamp };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return { ...event };
  }

  /** All recorded events, optionally filtered to a time window. */
  list(window: UsageWindow = {}): UsageEvent[] {
    const from = toMs(window.from);
    const to = toMs(window.to);
    return this.events
      .filter((e) => {
        const ms = Date.parse(e.at);
        if (from !== null && ms < from) return false;
        if (to !== null && ms > to) return false;
        return true;
      })
      .map((e) => ({ ...e }));
  }

  /** Aggregates usage per client, optionally within a time window. */
  getClientUsage(window: UsageWindow = {}): ClientUsageSummary[] {
    const byClient = new Map<string, ClientUsageSummary>();
    for (const event of this.list(window)) {
      let summary = byClient.get(event.clientId);
      if (!summary) {
        summary = {
          clientId: event.clientId,
          total: 0,
          routes: {},
          firstUsedAt: event.at,
          lastUsedAt: event.at,
        };
        byClient.set(event.clientId, summary);
      }
      summary.total += 1;
      summary.routes[event.route] = (summary.routes[event.route] ?? 0) + 1;
      if (event.at < (summary.firstUsedAt ?? event.at)) summary.firstUsedAt = event.at;
      if (event.at > (summary.lastUsedAt ?? event.at)) summary.lastUsedAt = event.at;
    }
    return [...byClient.values()].sort((a, b) => a.clientId.localeCompare(b.clientId));
  }

  /** Aggregates usage per route, optionally within a time window. */
  getRouteUsage(window: UsageWindow = {}): RouteUsageSummary[] {
    const byRoute = new Map<string, RouteUsageSummary>();
    for (const event of this.list(window)) {
      let summary = byRoute.get(event.route);
      if (!summary) {
        summary = { route: event.route, total: 0, clients: {} };
        byRoute.set(event.route, summary);
      }
      summary.total += 1;
      summary.clients[event.clientId] = (summary.clients[event.clientId] ?? 0) + 1;
    }
    return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
  }

  /** Convenience: usage for a single client, or null when unseen. */
  getUsageForClient(clientIdentity: string, window: UsageWindow = {}): ClientUsageSummary | null {
    const clientId = fingerprintClient(clientIdentity);
    return this.getClientUsage(window).find((s) => s.clientId === clientId) ?? null;
  }

  /** Total number of recorded events (optionally within a window). */
  count(window: UsageWindow = {}): number {
    return this.list(window).length;
  }

  /** Clears all recorded events. */
  reset(): void {
    this.events.length = 0;
  }
}

export class CredentialValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'CredentialValidationError';
  }
}

export interface ApiCredentialServiceOptions {
  store?: ApiCredentialStore;
  verifyCacheTtlMs?: number;
  now?: () => Date;
  /** Optional usage accounting sink; when provided, verifications are attributed. */
  usage?: UsageAccountingService;
}

export function parseApiKey(value: string): { id: string; secret: string } | null {
  const match = API_KEY_PATTERN.exec(value);
  return match ? { id: match[1], secret: match[2] } : null;
}

export function looksLikeScopedApiKey(value: string): boolean {
  return value.startsWith(`${API_KEY_PREFIX}_`);
}

async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(secret, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function secretMatches(secret: string, encoded: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = encoded.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const derived = await scryptAsync(secret, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function toPublic(record: ApiCredentialRecord): ApiCredential {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    keyPrefix: `${API_KEY_PREFIX}_${record.id}`,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

export function validateCreateCredentialInput(input: unknown): CreateApiCredentialInput {
  const issues: Array<{ field: string; message: string }> = [];
  const body = (input ?? {}) as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    issues.push({ field: 'name', message: 'name is required' });
  } else if (name.length > MAX_CREDENTIAL_NAME_LENGTH) {
    issues.push({
      field: 'name',
      message: `name must be at most ${MAX_CREDENTIAL_NAME_LENGTH} characters`,
    });
  }

  const scopes: ApiScope[] = [];
  if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
    issues.push({ field: 'scopes', message: 'scopes must be a non-empty array' });
  } else {
    for (const scope of body.scopes) {
      if (!isApiScope(scope)) {
        issues.push({ field: 'scopes', message: `unknown scope: ${String(scope)}` });
      } else if (!scopes.includes(scope)) {
        scopes.push(scope);
      }
    }
  }

  if (issues.length > 0) {
    throw new CredentialValidationError('Invalid credential request', issues);
  }
  return { name, scopes };
}

export class ApiCredentialService {
  private readonly store: ApiCredentialStore;
  private readonly verifyCacheTtlMs: number;
  private readonly now: () => Date;
  private readonly usage: UsageAccountingService | null;
  /** sha256(presented key) → { credential id, expiry } for recently verified keys. */
  private readonly verifyCache = new Map<string, { id: string; expiresAt: number }>();
  /** Burns equivalent scrypt work for unknown ids so timing does not reveal them. */
  private dummyHash: Promise<string> | null = null;

  constructor(options: ApiCredentialServiceOptions = {}) {
    this.store = options.store ?? new InMemoryApiCredentialStore();
    this.verifyCacheTtlMs = options.verifyCacheTtlMs ?? DEFAULT_VERIFY_CACHE_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.usage = options.usage ?? null;
  }

  /** Exposes the usage sink (if configured) for callers that need to read it. */
  getUsageAccounting(): UsageAccountingService | null {
    return this.usage;
  }

  /** Issues a new credential. The returned `apiKey` is never retrievable again. */
  async create(input: CreateApiCredentialInput): Promise<CreatedApiCredential> {
    const { name, scopes } = validateCreateCredentialInput(input);
    let id = crypto.randomBytes(8).toString('hex');
    while (this.store.get(id)) id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');

    const record: ApiCredentialRecord = {
      id,
      name,
      scopes,
      secretHash: await hashSecret(secret),
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.store.save(record);

    return { ...toPublic(record), apiKey: `${API_KEY_PREFIX}_${id}_${secret}` };
  }

  list(): ApiCredential[] {
    return this.store.list().map(toPublic);
  }

  get(id: string): ApiCredential | null {
    const record = this.store.get(id);
    return record ? toPublic(record) : null;
  }

  /** Revokes a credential. Returns the updated view, or null when unknown. */
  revoke(id: string): ApiCredential | null {
    const record = this.store.get(id);
    if (!record) return null;
    if (!record.revokedAt) {
      record.revokedAt = this.now().toISOString();
      this.store.save(record);
    }
    for (const [key, entry] of this.verifyCache) {
      if (entry.id === id) this.verifyCache.delete(key);
    }
    return toPublic(record);
  }

  /** True when at least one non-revoked credential exists. */
  hasActiveCredentials(): boolean {
    return this.store.list().some((r) => !r.revokedAt);
  }

  /**
   * Resolves a presented API key to its credential. Returns null for
   * malformed, unknown, revoked, or mismatching keys.
   */
  async verify(apiKey: string, route?: string): Promise<ApiCredential | null> {
    const parsed = parseApiKey(apiKey);
    if (!parsed) return null;

    const cacheKey = crypto.createHash('sha256').update(apiKey).digest('base64url');
    const cached = this.verifyCache.get(cacheKey);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt > nowMs && cached.id === parsed.id) {
      return this.touch(parsed.id, route);
    }
    if (cached) this.verifyCache.delete(cacheKey);

    const record = this.store.get(parsed.id);
    if (!record) {
      this.dummyHash ??= hashSecret('dummy-secret-for-timing');
      await secretMatches(parsed.secret, await this.dummyHash);
      return null;
    }

    const matches = await secretMatches(parsed.secret, record.secretHash);
    if (!matches || record.revokedAt) return null;

    this.verifyCache.set(cacheKey, { id: record.id, expiresAt: nowMs + this.verifyCacheTtlMs });
    return this.touch(record.id, route);
  }

  private touch(id: string, route?: string): ApiCredential | null {
    const record = this.store.get(id);
    if (!record || record.revokedAt) return null;
    record.lastUsedAt = this.now().toISOString();
    this.store.save(record);
    if (this.usage && route) {
      // Attribute to the credential id (a public handle), never the secret.
      this.usage.record(record.id, route);
    }
    return toPublic(record);
  }
}
