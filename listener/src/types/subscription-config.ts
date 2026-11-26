/**
 * Versioned subscription configuration types.
 *
 * A subscription has a configuration that may change over time (event types,
 * channels, active flag, provider options). Rather than mutating a single
 * record, every change produces a new, immutable, monotonically-increasing
 * version so that historical configurations can be inspected and processed
 * events can be tied to the exact version that was active when they ran.
 */

/** The configurable settings of a notification subscription. */
export interface SubscriptionConfigSettings {
  /** Event types / notification categories this subscription listens to. */
  eventTypes: string[];
  /** Channels (destinations) this subscription delivers to. */
  channels: string[];
  /** Whether the subscription is active. */
  active: boolean;
  /** Optional provider-specific options (forward compatible). */
  options: Record<string, unknown>;
}

/** The settings applied when a subscription is first created. */
export const DEFAULT_SUBSCRIPTION_CONFIG_SETTINGS: SubscriptionConfigSettings = {
  eventTypes: [],
  channels: [],
  active: true,
  options: {},
};

/** A partial update applied on top of the current settings. */
export type SubscriptionConfigPatch = Partial<Omit<SubscriptionConfigSettings, 'options'>> & {
  options?: Record<string, unknown>;
};

/** An immutable, versioned snapshot of a subscription configuration. */
export interface SubscriptionConfigVersion {
  /** The subscription this snapshot belongs to. */
  subscriptionId: string;
  /** Monotonically increasing version number, starting at 1. */
  version: number;
  /** The settings captured by this version (deeply frozen). */
  settings: Readonly<SubscriptionConfigSettings>;
  /** Epoch-ms timestamp at which this version was recorded. */
  createdAt: number;
  /** The actor that produced this version, when tracked. */
  actor?: string;
  /** Human-readable summary of the change (`created` / `updated`). */
  changeSummary: string;
  /** Top-level setting keys that differ from the previous version. */
  changedKeys: string[];
  /** The previous version's settings, or `null` for the first version. */
  previousSettings: Readonly<SubscriptionConfigSettings> | null;
}

/**
 * A processed event, linked to the subscription config version that was active
 * when the event was processed. The link is immutable: later config updates do
 * not alter it.
 */
export interface ProcessedEventConfigLink {
  eventId: string;
  subscriptionId: string;
  contractAddress?: string;
  /** The active subscription config version at processing time. */
  configVersion: number;
  processedAt: number;
}
