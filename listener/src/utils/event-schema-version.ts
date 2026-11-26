/**
 * Contract event schema versioning (issue #1122).
 *
 * The contract encodes an event's schema version in its name (topic[0]):
 *   - `contract_paused`            → v1 (unsuffixed names are always v1)
 *   - `notification_scheduled_v2`  → v2
 *
 * Keeping v1 names unchanged means no existing event's topics or payload
 * moved. See docs/EVENT_SCHEMA_VERSIONING.md for the full rules.
 */

/** Schema version every unsuffixed event name implies. */
export const DEFAULT_EVENT_SCHEMA_VERSION = 1;

/**
 * Event schema versions this listener can process. Must be kept in sync
 * with `EVENT_SCHEMA_VERSION` in `contract/.../base/events.rs`.
 */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

export interface EventSchemaVersionInfo {
  /** Event name without any `_v<N>` suffix (`null` when the name is unknown). */
  baseEventName: string | null;
  /** Schema version of the event. */
  schemaVersion: number;
  /** True when the version came from an explicit `_v<N>` suffix. */
  explicit: boolean;
}

const VERSIONED_NAME = /^(.+)_v([1-9]\d{0,5})$/;

/**
 * Derives the schema version from an event name. Never throws: a missing
 * name yields the default version so the event follows the v1 path.
 */
export function parseEventSchemaVersion(eventName: string | null | undefined): EventSchemaVersionInfo {
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return { baseEventName: null, schemaVersion: DEFAULT_EVENT_SCHEMA_VERSION, explicit: false };
  }

  const match = VERSIONED_NAME.exec(eventName);
  if (!match) {
    return { baseEventName: eventName, schemaVersion: DEFAULT_EVENT_SCHEMA_VERSION, explicit: false };
  }

  return { baseEventName: match[1], schemaVersion: Number(match[2]), explicit: true };
}

export function isSupportedEventSchemaVersion(version: number): boolean {
  return SUPPORTED_EVENT_SCHEMA_VERSIONS.has(version);
}
