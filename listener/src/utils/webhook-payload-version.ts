/**
 * Webhook payload versioning contract.
 *
 * Every outbound webhook body carries an explicit `schemaVersion` field and
 * every request carries the `x-notifychain-payload-version` header, so an
 * external consumer can identify the payload schema it is receiving without
 * having to introspect the body heuristically.
 *
 * Note: this is distinct from `version` in `notification-version.ts`, which
 * versions the *internal* notification protocol stored in the database. The
 * webhook contract is a separate, consumer-facing surface and therefore gets
 * its own explicit identifier.
 *
 * ## Compatibility rules
 *
 * Versions use a `MAJOR.MINOR` scheme:
 *
 *   - **MAJOR** is bumped for any breaking change — a removed field, a rename,
 *     a change of type, or a change of meaning for an existing field. A new
 *     major version is *not* compatible with the previous one.
 *   - **MINOR** is bumped for additive, backward-compatible changes (new
 *     optional fields, new enum members). Consumers MUST ignore fields they do
 *     not recognise, so a minor bump never breaks an existing consumer.
 *
 * Consumers MUST reject a payload whose MAJOR version they do not support, and
 * SHOULD log-and-continue on an unknown MINOR version within a supported MAJOR.
 * Producers always emit `CURRENT_WEBHOOK_PAYLOAD_VERSION` by default; pinning an
 * older supported version is allowed for a migration window.
 */

/** Payload field that carries the webhook contract schema version. */
export const WEBHOOK_PAYLOAD_VERSION_FIELD = 'schemaVersion';

/** HTTP request header that carries the webhook contract schema version. */
export const WEBHOOK_PAYLOAD_VERSION_HEADER = 'x-notifychain-payload-version';

/** The schema version emitted by default for every outbound webhook payload. */
export const CURRENT_WEBHOOK_PAYLOAD_VERSION = '1.0';

/** Every payload version this listener can emit and whose contract is documented. */
export const SUPPORTED_WEBHOOK_PAYLOAD_VERSIONS = ['1.0'] as const;

export type WebhookPayloadVersion = (typeof SUPPORTED_WEBHOOK_PAYLOAD_VERSIONS)[number];

export interface ParsedWebhookPayloadVersion {
  major: number;
  minor: number;
}

export type WebhookPayloadVersionStatus = 'active' | 'deprecated';

/**
 * Machine-readable description of a single webhook payload version.
 *
 * `requiredFields` are the fields a consumer may rely on being present for
 * every payload of this version; `optionalFields` may be omitted. This is the
 * contract used by {@link validateWebhookPayloadForVersion} and by the
 * regression tests that guard representative payloads.
 */
export interface WebhookPayloadVersionSpec {
  version: WebhookPayloadVersion;
  status: WebhookPayloadVersionStatus;
  /** ISO-8601 date the version was introduced. */
  releasedAt: string;
  /** Fields guaranteed to be present in every payload of this version. */
  requiredFields: readonly string[];
  /** Fields that may be present but are not guaranteed. */
  optionalFields: readonly string[];
}

/**
 * The documented webhook payload version registry.
 *
 * Add a new entry here when the payload contract changes. Never mutate an
 * existing entry's `requiredFields` in a way that removes a field — that is a
 * breaking change and requires a new MAJOR version.
 */
export const WEBHOOK_PAYLOAD_VERSIONS: Readonly<
  Record<WebhookPayloadVersion, WebhookPayloadVersionSpec>
> = {
  '1.0': {
    version: '1.0',
    status: 'active',
    releasedAt: '2026-07-26',
    // `schemaVersion` is always present because the delivery layer stamps it.
    requiredFields: [WEBHOOK_PAYLOAD_VERSION_FIELD],
    optionalFields: [
      'eventId',
      'contractAddress',
      'notificationType',
      'message',
      'events',
      'occurredAt',
    ],
  },
};

/**
 * Parse a `MAJOR.MINOR` version string (or a bare integer major, e.g. `1`,
 * which is treated as `1.0`). Returns `null` for anything unparseable.
 */
export function parseWebhookPayloadVersion(
  value: unknown,
): ParsedWebhookPayloadVersion | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return null;
    return { major: value, minor: 0 };
  }

  if (typeof value !== 'string') return null;

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;

  const major = Number.parseInt(match[1], 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;

  return { major, minor };
}

/**
 * Compare two version identifiers.
 *
 * @returns `-1` when `a < b`, `0` when equal, `1` when `a > b`.
 * @throws Error when either version cannot be parsed.
 */
export function compareWebhookPayloadVersions(a: unknown, b: unknown): number {
  const parsedA = parseWebhookPayloadVersion(a);
  const parsedB = parseWebhookPayloadVersion(b);

  if (!parsedA || !parsedB) {
    throw new Error(
      `Cannot compare invalid webhook payload versions: "${String(a)}" vs "${String(b)}"`,
    );
  }

  if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
  return 0;
}

/**
 * True when this listener can emit the given payload version.
 *
 * A version is supported when its exact `MAJOR.MINOR` string is registered in
 * {@link WEBHOOK_PAYLOAD_VERSIONS}.
 */
export function isSupportedWebhookPayloadVersion(value: unknown): boolean {
  const parsed = parseWebhookPayloadVersion(value);
  if (!parsed) return false;
  return Object.prototype.hasOwnProperty.call(
    WEBHOOK_PAYLOAD_VERSIONS,
    `${parsed.major}.${parsed.minor}`,
  );
}

export interface StampedWebhookPayload {
  payload: Record<string, any>;
  headers: Record<string, string>;
}

/**
 * Attach the webhook contract version to an outbound payload and return the
 * request headers that advertise it.
 *
 * @param payload - The JSON body about to be delivered.
 * @param version - Version to stamp. Defaults to the current version. Passing
 *                  an unsupported version throws so a misconfiguration fails
 *                  loudly instead of emitting an undocumented contract.
 * @returns A new payload (never mutates the input) and the version header.
 */
export function stampWebhookPayloadVersion(
  payload: Record<string, any>,
  version: string = CURRENT_WEBHOOK_PAYLOAD_VERSION,
): StampedWebhookPayload {
  if (!isSupportedWebhookPayloadVersion(version)) {
    throw new Error(
      `Unsupported webhook payload version "${version}". ` +
        `Supported versions: ${SUPPORTED_WEBHOOK_PAYLOAD_VERSIONS.join(', ')}.`,
    );
  }

  const parsed = parseWebhookPayloadVersion(version)!;
  const canonical = `${parsed.major}.${parsed.minor}`;

  return {
    payload: { ...payload, [WEBHOOK_PAYLOAD_VERSION_FIELD]: canonical },
    headers: { [WEBHOOK_PAYLOAD_VERSION_HEADER]: canonical },
  };
}

export interface PayloadVersionValidationResult {
  valid: boolean;
  /** Version that was validated, when parseable. */
  version?: string;
  /** Required fields (per the registry) that were absent from the payload. */
  missingFields: string[];
  /** Fields present in the payload but not part of the documented contract. */
  unknownFields: string[];
  errors: string[];
}

/**
 * Validate a payload body against the documented contract for `version`.
 *
 * This powers the regression tests that pin representative payloads: a
 * breaking change to a documented shape will make these assertions fail.
 */
export function validateWebhookPayloadForVersion(
  payload: Record<string, any>,
  version: string = CURRENT_WEBHOOK_PAYLOAD_VERSION,
): PayloadVersionValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];
  const unknownFields: string[] = [];

  const parsed = parseWebhookPayloadVersion(version);
  if (!parsed) {
    return {
      valid: false,
      missingFields,
      unknownFields,
      errors: [`Invalid webhook payload version "${version}".`],
    };
  }

  const canonical = `${parsed.major}.${parsed.minor}` as WebhookPayloadVersion;
  const spec = WEBHOOK_PAYLOAD_VERSIONS[canonical as WebhookPayloadVersion];

  if (!spec) {
    return {
      valid: false,
      version: canonical,
      missingFields,
      unknownFields,
      errors: [`No documented contract for webhook payload version "${canonical}".`],
    };
  }

  for (const field of spec.requiredFields) {
    if (payload[field] === undefined || payload[field] === null) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    errors.push(
      `Payload for version ${canonical} is missing required field(s): ${missingFields.join(', ')}.`,
    );
  }

  const documented = new Set<string>([
    ...spec.requiredFields,
    ...spec.optionalFields,
  ]);
  for (const key of Object.keys(payload)) {
    if (!documented.has(key)) unknownFields.push(key);
  }

  return {
    valid: errors.length === 0,
    version: canonical,
    missingFields,
    unknownFields,
    errors,
  };
}
