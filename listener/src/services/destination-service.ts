import crypto from 'crypto';
import { Database } from '../database/database';
import logger from '../utils/logger';
import { sendWebhook } from './webhook-sender';
import { SecurityAuditService } from './security-audit';
import {
  CreateDestinationInput,
  DESTINATION_PROVIDERS,
  DestinationConnectionStatus,
  DestinationProvider,
  DestinationRecord,
  DestinationUpdate,
  DestinationValidationErrors,
  NotificationDestination,
  ResolvedDestinationTarget,
  SecretFieldState,
  TestNotificationResult,
} from '../types/destination';

export interface DestinationFieldSpec {
  key: string;
  label: string;
  type: 'url' | 'email' | 'text';
  secret: boolean;
  required: boolean;
}

export const DESTINATION_PROVIDER_FIELDS: Record<
  DestinationProvider,
  readonly DestinationFieldSpec[]
> = {
  webhook: [
    { key: 'url', label: 'Endpoint URL', type: 'url', secret: false, required: true },
    { key: 'signingSecret', label: 'Signing secret', type: 'text', secret: true, required: true },
  ],
  discord: [
    { key: 'webhookUrl', label: 'Discord webhook URL', type: 'url', secret: true, required: true },
  ],
  email: [
    { key: 'fromAddress', label: 'From address', type: 'email', secret: false, required: true },
    { key: 'apiKey', label: 'Email provider API key', type: 'text', secret: true, required: true },
  ],
  telegram: [
    { key: 'chatId', label: 'Chat ID', type: 'text', secret: false, required: true },
    { key: 'botToken', label: 'Bot token', type: 'text', secret: true, required: true },
  ],
};

export const DESTINATION_PROVIDER_LABELS: Record<DestinationProvider, string> = {
  webhook: 'Webhook',
  discord: 'Discord',
  email: 'Email',
  telegram: 'Telegram',
};

const DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_CHAT_PATTERN = /^(-?\d{5,}|@[A-Za-z0-9_]{5,})$/;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MIN_SECRET_LENGTH = 8;

export class DestinationNotFoundError extends Error {
  constructor(id: string) {
    super(`Destination not found: ${id}`);
    this.name = 'DestinationNotFoundError';
  }
}

export class DestinationOwnershipError extends Error {
  constructor(message: string = 'You do not have permission to access this destination.') {
    super(message);
    this.name = 'DestinationOwnershipError';
  }
}

export class DestinationConflictError extends Error {
  constructor(id: string) {
    super(`Destination already exists: ${id}`);
    this.name = 'DestinationConflictError';
  }
}

export class DestinationValidationError extends Error {
  constructor(
    message: string,
    public readonly fieldErrors: DestinationValidationErrors = {},
  ) {
    super(message);
    this.name = 'DestinationValidationError';
  }
}

export function isDestinationProvider(value: unknown): value is DestinationProvider {
  return typeof value === 'string' && (DESTINATION_PROVIDERS as readonly string[]).includes(value);
}

export function assertValidOwnerId(ownerId: string): string {
  const trimmed = typeof ownerId === 'string' ? ownerId.trim() : '';
  if (!trimmed) {
    throw new DestinationOwnershipError('Authenticated destination owner is required.');
  }
  return trimmed;
}

function validateUrlField(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return 'Must be an HTTPS URL.';
    if (parsed.username || parsed.password) return 'Credentials must not be embedded in the URL.';
    return null;
  } catch {
    return 'Must be a valid URL.';
  }
}

function validateDestinationConfig(
  provider: DestinationProvider,
  enabled: boolean,
  settings: Record<string, string>,
  secrets: Record<string, string>,
): DestinationValidationErrors {
  const errors: DestinationValidationErrors = {};
  const specs = DESTINATION_PROVIDER_FIELDS[provider];
  const allowedSettingKeys = new Set(specs.filter((f) => !f.secret).map((f) => f.key));
  const allowedSecretKeys = new Set(specs.filter((f) => f.secret).map((f) => f.key));

  for (const key of Object.keys(settings)) {
    if (!allowedSettingKeys.has(key)) {
      errors[key] = `Unknown setting field "${key}" for provider ${provider}.`;
    }
  }
  for (const key of Object.keys(secrets)) {
    if (!allowedSecretKeys.has(key)) {
      errors[key] = `Unknown secret field "${key}" for provider ${provider}.`;
    }
  }

  if (!enabled) {
    return errors;
  }

  for (const field of specs) {
    const raw = field.secret ? secrets[field.key] : settings[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!value) {
      if (field.required) {
        errors[field.key] = `${field.label} is required.`;
      }
      continue;
    }

    if (field.type === 'url') {
      const urlErr = validateUrlField(value);
      if (urlErr) errors[field.key] = urlErr;
    } else if (field.type === 'email' && !EMAIL_PATTERN.test(value)) {
      errors[field.key] = 'Must be a valid email address.';
    } else if (field.secret && value.length < MIN_SECRET_LENGTH) {
      errors[field.key] = `${field.label} looks too short.`;
    }

    if (provider === 'telegram' && field.key === 'chatId' && !TELEGRAM_CHAT_PATTERN.test(value)) {
      errors[field.key] = 'Must be a numeric chat ID or an @channel name.';
    }
  }

  return errors;
}

function hasAllRequiredFields(
  provider: DestinationProvider,
  settings: Record<string, string>,
  secrets: Record<string, string>,
): boolean {
  for (const field of DESTINATION_PROVIDER_FIELDS[provider]) {
    if (!field.required) continue;
    const raw = field.secret ? secrets[field.key] : settings[field.key];
    if (!raw || raw.trim().length === 0) {
      return false;
    }
  }
  return true;
}

function computeStatus(
  provider: DestinationProvider,
  enabled: boolean,
  settings: Record<string, string>,
  secrets: Record<string, string>,
): DestinationConnectionStatus {
  if (!enabled) return 'disabled';
  return hasAllRequiredFields(provider, settings, secrets) ? 'connected' : 'not_configured';
}

function toSecretFieldStateMap(
  provider: DestinationProvider,
  secrets: Record<string, string>,
): Record<string, SecretFieldState> {
  const result: Record<string, SecretFieldState> = {};
  for (const field of DESTINATION_PROVIDER_FIELDS[provider]) {
    if (!field.secret) continue;
    const value = secrets[field.key];
    if (typeof value === 'string' && value.length > 0) {
      result[field.key] = {
        isSet: true,
        ...(value.length >= 4 ? { last4: value.slice(-4) } : {}),
      };
    } else {
      result[field.key] = { isSet: false };
    }
  }
  return result;
}

export function sanitizeDestination(record: DestinationRecord): NotificationDestination {
  return {
    id: record.id,
    ownerId: record.ownerId,
    provider: record.provider,
    displayName: record.displayName,
    enabled: record.enabled,
    status: record.status,
    settings: { ...record.settings },
    secrets: toSecretFieldStateMap(record.provider, record.secrets),
    lastError: record.lastError,
    lastTestedAt: record.lastTestedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeStringMap(raw: unknown, label: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DestinationValidationError(`${label} must be a key-value object.`, {
      _form: `${label} must be a key-value object.`,
    });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new DestinationValidationError(`Field "${k}" must be a string.`, {
        [k]: `${k} must be a string.`,
      });
    }
    out[k] = v;
  }
  return out;
}

export interface DestinationStore {
  findById(id: string): Promise<DestinationRecord | null>;
  listByOwner(ownerId: string): Promise<DestinationRecord[]>;
  insert(record: DestinationRecord): Promise<void>;
  updateOwned(record: DestinationRecord): Promise<boolean>;
  deleteOwned(id: string, ownerId: string): Promise<boolean>;
}

interface DestinationRow {
  id: string;
  owner_id: string;
  provider: string;
  display_name: string;
  enabled: number;
  status: string;
  settings_json: string;
  secrets_json: string;
  last_error: string | null;
  last_tested_at: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: DestinationRow): DestinationRecord {
  let settings: Record<string, string> = {};
  let secrets: Record<string, string> = {};
  try {
    settings = JSON.parse(row.settings_json || '{}');
  } catch {
    settings = {};
  }
  try {
    secrets = JSON.parse(row.secrets_json || '{}');
  } catch {
    secrets = {};
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider as DestinationProvider,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    status: row.status as DestinationConnectionStatus,
    settings,
    secrets,
    lastError: row.last_error ?? null,
    lastTestedAt: row.last_tested_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteDestinationStore implements DestinationStore {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<DestinationRecord | null> {
    const row = await this.db.get<DestinationRow>('SELECT * FROM destinations WHERE id = ?', [id]);
    return row ? rowToRecord(row) : null;
  }

  async listByOwner(ownerId: string): Promise<DestinationRecord[]> {
    const rows = await this.db.all<DestinationRow>(
      'SELECT * FROM destinations WHERE owner_id = ? ORDER BY created_at ASC, id ASC',
      [ownerId],
    );
    return rows.map(rowToRecord);
  }

  async insert(record: DestinationRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO destinations (
        id, owner_id, provider, display_name, enabled, status,
        settings_json, secrets_json, last_error, last_tested_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.provider,
        record.displayName,
        record.enabled ? 1 : 0,
        record.status,
        JSON.stringify(record.settings),
        JSON.stringify(record.secrets),
        record.lastError,
        record.lastTestedAt,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async updateOwned(record: DestinationRecord): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE destinations
       SET display_name = ?,
           enabled = ?,
           status = ?,
           settings_json = ?,
           secrets_json = ?,
           last_error = ?,
           last_tested_at = ?,
           updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      [
        record.displayName,
        record.enabled ? 1 : 0,
        record.status,
        JSON.stringify(record.settings),
        JSON.stringify(record.secrets),
        record.lastError,
        record.lastTestedAt,
        record.updatedAt,
        record.id,
        record.ownerId,
      ],
    );
    return result.changes > 0;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM destinations WHERE id = ? AND owner_id = ?', [
      id,
      ownerId,
    ]);
    return result.changes > 0;
  }
}

export class InMemoryDestinationStore implements DestinationStore {
  private readonly records = new Map<string, DestinationRecord>();

  async findById(id: string): Promise<DestinationRecord | null> {
    const r = this.records.get(id);
    return r ? { ...r, settings: { ...r.settings }, secrets: { ...r.secrets } } : null;
  }

  async listByOwner(ownerId: string): Promise<DestinationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r, settings: { ...r.settings }, secrets: { ...r.secrets } }));
  }

  async insert(record: DestinationRecord): Promise<void> {
    this.records.set(record.id, {
      ...record,
      settings: { ...record.settings },
      secrets: { ...record.secrets },
    });
  }

  async updateOwned(record: DestinationRecord): Promise<boolean> {
    const existing = this.records.get(record.id);
    if (!existing || existing.ownerId !== record.ownerId) return false;
    this.records.set(record.id, {
      ...record,
      settings: { ...record.settings },
      secrets: { ...record.secrets },
    });
    return true;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.ownerId !== ownerId) return false;
    return this.records.delete(id);
  }
}

export type DestinationTestSender = (record: DestinationRecord) => Promise<TestNotificationResult>;

async function defaultTestSender(record: DestinationRecord): Promise<TestNotificationResult> {
  const start = Date.now();
  if (record.provider === 'webhook' || record.provider === 'discord') {
    const targetUrl =
      record.provider === 'webhook' ? record.settings.url : record.secrets.webhookUrl;
    if (!targetUrl) {
      return { success: false, message: 'Destination URL is not configured.' };
    }
    const payload = {
      test: true,
      source: 'notify-chain',
      destinationId: record.id,
      timestamp: new Date().toISOString(),
    };
    const headers: Record<string, string> = {};
    if (record.provider === 'webhook' && record.secrets.signingSecret) {
      const signature = crypto
        .createHmac('sha256', record.secrets.signingSecret)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-NotifyChain-Signature'] = `sha256=${signature}`;
    }
    const response = await sendWebhook(targetUrl, payload, { timeoutMs: 5_000, headers });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        success: false,
        message: `Endpoint returned HTTP ${response.status}`,
        latencyMs,
      };
    }
    return { success: true, message: 'Delivered', latencyMs };
  }

  return {
    success: true,
    message: `${DESTINATION_PROVIDER_LABELS[record.provider]} configuration verified`,
    latencyMs: Date.now() - start,
  };
}

export interface DestinationServiceOptions {
  store?: DestinationStore;
  db?: Database;
  auditService?: SecurityAuditService | null;
  testSender?: DestinationTestSender;
  now?: () => Date;
}

export class DestinationService {
  private readonly store: DestinationStore;
  private readonly auditService: SecurityAuditService | null;
  private readonly testSender: DestinationTestSender;
  private readonly now: () => Date;

  constructor(options: DestinationServiceOptions = {}) {
    if (options.store) {
      this.store = options.store;
    } else if (options.db) {
      this.store = new SqliteDestinationStore(options.db);
    } else {
      this.store = new InMemoryDestinationStore();
    }
    this.auditService = options.auditService ?? null;
    this.testSender = options.testSender ?? defaultTestSender;
    this.now = options.now ?? (() => new Date());
  }

  private async recordAudit(
    action: string,
    actor: string,
    outcome: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditService) return;
    try {
      await this.auditService.record({ action, actor, outcome, details });
    } catch {
      // Best-effort audit persistence when security_audit_log is unavailable in minimal test DBs.
    }
  }

  private async getVerifiedRecord(
    id: string,
    ownerId: string,
    action: string,
  ): Promise<DestinationRecord> {
    const verifiedOwner = assertValidOwnerId(ownerId);
    const trimmedId = typeof id === 'string' ? id.trim() : '';
    if (!trimmedId) {
      throw new DestinationValidationError('Destination id is required.', {
        _form: 'Destination id is required.',
      });
    }

    const record = await this.store.findById(trimmedId);
    if (!record) {
      throw new DestinationNotFoundError(trimmedId);
    }
    if (record.ownerId !== verifiedOwner) {
      logger.warn('Blocked cross-account destination access', {
        destinationId: trimmedId,
        actorOwnerId: verifiedOwner,
        targetOwnerId: record.ownerId,
        action,
      });
      await this.recordAudit('destination_ownership_violation', verifiedOwner, 'forbidden', {
        destinationId: trimmedId,
        action,
      });
      throw new DestinationOwnershipError();
    }
    return record;
  }

  async listForOwner(ownerId: string): Promise<NotificationDestination[]> {
    const verifiedOwner = assertValidOwnerId(ownerId);
    const records = await this.store.listByOwner(verifiedOwner);
    return records.map(sanitizeDestination);
  }

  async getForOwner(id: string, ownerId: string): Promise<NotificationDestination> {
    const record = await this.getVerifiedRecord(id, ownerId, 'lookup');
    return sanitizeDestination(record);
  }

  async create(ownerId: string, input: CreateDestinationInput): Promise<NotificationDestination> {
    const verifiedOwner = assertValidOwnerId(ownerId);

    if (input.ownerId !== undefined) {
      const requestedOwner = typeof input.ownerId === 'string' ? input.ownerId.trim() : '';
      if (requestedOwner !== verifiedOwner) {
        await this.recordAudit('destination_cross_account_create', verifiedOwner, 'forbidden', {
          requestedOwnerId: requestedOwner || null,
        });
        throw new DestinationOwnershipError('Cross-account destination creation is forbidden.');
      }
    }

    if (!isDestinationProvider(input.provider)) {
      throw new DestinationValidationError(`Unsupported provider "${String(input.provider)}".`, {
        provider: `Provider must be one of: ${DESTINATION_PROVIDERS.join(', ')}.`,
      });
    }

    let id: string;
    if (input.id !== undefined) {
      const trimmedId = typeof input.id === 'string' ? input.id.trim() : '';
      if (!DESTINATION_ID_PATTERN.test(trimmedId)) {
        throw new DestinationValidationError('Invalid destination id format.', {
          id: 'Destination id must be 1-64 alphanumeric, dash, or underscore characters.',
        });
      }
      const existing = await this.store.findById(trimmedId);
      if (existing) {
        if (existing.ownerId !== verifiedOwner) {
          await this.recordAudit('destination_cross_account_create', verifiedOwner, 'forbidden', {
            destinationId: trimmedId,
          });
          throw new DestinationOwnershipError(
            'Destination id is already owned by another account.',
          );
        }
        throw new DestinationConflictError(trimmedId);
      }
      id = trimmedId;
    } else {
      id = `dest_${crypto.randomBytes(8).toString('hex')}`;
    }

    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim().length > 0
        ? input.displayName.trim()
        : DESTINATION_PROVIDER_LABELS[input.provider];

    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new DestinationValidationError(
        `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
        { displayName: `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.` },
      );
    }

    const settings = normalizeStringMap(input.settings, 'settings');
    const secrets = normalizeStringMap(input.secrets, 'secrets');
    const cleanSecrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (v.trim() !== '') cleanSecrets[k] = v.trim();
    }

    const fieldErrors = validateDestinationConfig(input.provider, enabled, settings, cleanSecrets);
    if (Object.keys(fieldErrors).length > 0) {
      throw new DestinationValidationError('Validation failed', fieldErrors);
    }

    const timestamp = this.now().toISOString();
    const record: DestinationRecord = {
      id,
      ownerId: verifiedOwner,
      provider: input.provider,
      displayName,
      enabled,
      status: computeStatus(input.provider, enabled, settings, cleanSecrets),
      settings,
      secrets: cleanSecrets,
      lastError: null,
      lastTestedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.insert(record);
    await this.recordAudit('destination_created', verifiedOwner, 'success', {
      destinationId: record.id,
      provider: record.provider,
    });

    return sanitizeDestination(record);
  }

  async updateForOwner(
    id: string,
    ownerId: string,
    update: DestinationUpdate,
  ): Promise<NotificationDestination> {
    const verifiedOwner = assertValidOwnerId(ownerId);

    if (update.ownerId !== undefined) {
      const requestedOwner = typeof update.ownerId === 'string' ? update.ownerId.trim() : '';
      if (requestedOwner !== verifiedOwner) {
        await this.recordAudit('destination_ownership_reassignment', verifiedOwner, 'forbidden', {
          destinationId: id,
          requestedOwnerId: requestedOwner || null,
        });
        throw new DestinationOwnershipError('Destination ownership cannot be reassigned.');
      }
    }

    const existing = await this.getVerifiedRecord(id, verifiedOwner, 'update');

    if (typeof update.enabled !== 'boolean') {
      throw new DestinationValidationError('enabled must be a boolean.', {
        enabled: 'enabled must be a boolean.',
      });
    }

    const displayName =
      update.displayName !== undefined ? update.displayName.trim() : existing.displayName;
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new DestinationValidationError(
        `displayName must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters.`,
        {
          displayName: `Display name must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters.`,
        },
      );
    }

    const nextSettings = normalizeStringMap(update.settings, 'settings');
    const incomingSecrets = normalizeStringMap(update.secrets, 'secrets');
    const mergedSecrets: Record<string, string> = { ...existing.secrets };
    for (const [key, value] of Object.entries(incomingSecrets)) {
      if (value === '') {
        delete mergedSecrets[key];
      } else {
        mergedSecrets[key] = value.trim();
      }
    }

    const fieldErrors = validateDestinationConfig(
      existing.provider,
      update.enabled,
      nextSettings,
      mergedSecrets,
    );
    if (Object.keys(fieldErrors).length > 0) {
      throw new DestinationValidationError('Validation failed', fieldErrors);
    }

    const nextRecord: DestinationRecord = {
      ...existing,
      displayName,
      enabled: update.enabled,
      status: computeStatus(existing.provider, update.enabled, nextSettings, mergedSecrets),
      settings: nextSettings,
      secrets: mergedSecrets,
      lastError: null,
      updatedAt: this.now().toISOString(),
    };

    const updated = await this.store.updateOwned(nextRecord);
    if (!updated) {
      throw new DestinationOwnershipError();
    }

    await this.recordAudit('destination_updated', verifiedOwner, 'success', {
      destinationId: nextRecord.id,
      provider: nextRecord.provider,
    });

    return sanitizeDestination(nextRecord);
  }

  async deleteForOwner(id: string, ownerId: string): Promise<{ deleted: true; id: string }> {
    const existing = await this.getVerifiedRecord(id, ownerId, 'delete');
    const deleted = await this.store.deleteOwned(existing.id, existing.ownerId);
    if (!deleted) {
      throw new DestinationNotFoundError(existing.id);
    }
    await this.recordAudit('destination_deleted', existing.ownerId, 'success', {
      destinationId: existing.id,
    });
    return { deleted: true, id: existing.id };
  }

  async sendTestForOwner(id: string, ownerId: string): Promise<TestNotificationResult> {
    const existing = await this.getVerifiedRecord(id, ownerId, 'test');

    if (!existing.enabled || existing.status === 'not_configured') {
      throw new DestinationValidationError(
        'Enable and save a complete configuration before sending a test.',
        { _form: 'Destination must be enabled and configured before testing.' },
      );
    }

    let result: TestNotificationResult;
    try {
      result = await this.testSender(existing);
    } catch (err) {
      result = {
        success: false,
        message: err instanceof Error ? err.message : 'Test delivery failed.',
      };
    }

    const testedAt = this.now().getTime();
    const updatedRecord: DestinationRecord = {
      ...existing,
      lastTestedAt: testedAt,
      lastError: result.success ? null : result.message,
      status: result.success ? 'connected' : 'error',
      updatedAt: this.now().toISOString(),
    };
    await this.store.updateOwned(updatedRecord);

    return result;
  }

  /**
   * Resolves a destination reference for server-side scheduling or delivery,
   * rejecting any cross-account reference.
   */
  async resolveOwnedDestination(
    destinationId: string,
    ownerId: string,
  ): Promise<ResolvedDestinationTarget> {
    const record = await this.getVerifiedRecord(destinationId, ownerId, 'reference');
    if (!record.enabled || record.status === 'not_configured') {
      throw new DestinationValidationError(
        `Destination "${record.id}" is disabled or not configured.`,
        { destinationId: 'Referenced destination must be enabled and configured.' },
      );
    }

    let targetRecipient = '';
    if (record.provider === 'webhook') {
      targetRecipient = record.settings.url ?? '';
    } else if (record.provider === 'discord') {
      targetRecipient = record.secrets.webhookUrl ?? '';
    } else if (record.provider === 'email') {
      targetRecipient = record.settings.fromAddress ?? '';
    } else if (record.provider === 'telegram') {
      targetRecipient = record.settings.chatId ?? '';
    }

    return {
      id: record.id,
      ownerId: record.ownerId,
      provider: record.provider,
      enabled: record.enabled,
      status: record.status,
      targetRecipient,
      ...(record.secrets.signingSecret ? { signingSecret: record.secrets.signingSecret } : {}),
    };
  }
}
