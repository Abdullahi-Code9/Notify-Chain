/**
 * SubscriptionConfigStore — versioned subscription configurations.
 *
 * Responsibilities:
 * - Record an immutable, monotonically-increasing snapshot of a subscription's
 *   configuration every time it is created or updated.
 * - Never mutate or overwrite historical snapshots.
 * - Link every processed event to the config version that was active when the
 *   event was processed; the link is immutable across later config updates.
 * - Expose query methods to inspect the current config and the full history.
 *
 * Storage is in-memory, mirroring the existing `PreferenceStore` /
 * `SubscriptionService` pattern used for off-chain subscription state.
 */

import {
  DEFAULT_SUBSCRIPTION_CONFIG_SETTINGS,
  ProcessedEventConfigLink,
  SubscriptionConfigPatch,
  SubscriptionConfigSettings,
  SubscriptionConfigVersion,
} from '../types/subscription-config';
import logger from '../utils/logger';

export interface SubscriptionConfigStoreOptions {
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SubscriptionConfigChangeOptions {
  /** Actor responsible for the change, when known. */
  actor?: string;
}

/** Deep-freeze a settings object so snapshots cannot be mutated in place. */
function freezeSettings(settings: SubscriptionConfigSettings): Readonly<SubscriptionConfigSettings> {
  Object.freeze(settings.eventTypes);
  Object.freeze(settings.channels);
  Object.freeze(settings.options);
  return Object.freeze(settings);
}

/** Structural clone so callers cannot mutate stored snapshots via aliasing. */
function cloneSettings(settings: SubscriptionConfigSettings): SubscriptionConfigSettings {
  return {
    eventTypes: [...settings.eventTypes],
    channels: [...settings.channels],
    active: settings.active,
    options: { ...settings.options },
  };
}

function normalizeSettings(settings: SubscriptionConfigSettings): SubscriptionConfigSettings {
  return {
    eventTypes: [...(settings.eventTypes ?? [])],
    channels: [...(settings.channels ?? [])],
    active: settings.active ?? true,
    options: { ...(settings.options ?? {}) },
  };
}

function diffKeys(
  previous: SubscriptionConfigSettings | null,
  next: SubscriptionConfigSettings
): string[] {
  if (!previous) {
    return Object.keys(next);
  }
  const changed: string[] = [];
  (Object.keys(next) as Array<keyof SubscriptionConfigSettings>).forEach((key) => {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changed.push(key);
    }
  });
  return changed;
}

export class SubscriptionConfigStore {
  private readonly history = new Map<string, SubscriptionConfigVersion[]>();
  private readonly processedEvents = new Map<string, ProcessedEventConfigLink>();
  private readonly now: () => number;

  constructor(options: SubscriptionConfigStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------------------
  // Configuration lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the initial (version 1) configuration for a subscription.
   * Throws when a configuration already exists — use {@link updateConfig}.
   */
  createConfig(
    subscriptionId: string,
    settings: Partial<SubscriptionConfigSettings> = {},
    options: SubscriptionConfigChangeOptions = {}
  ): SubscriptionConfigVersion {
    this.assertValidSubscriptionId(subscriptionId);
    const existing = this.history.get(subscriptionId);
    if (existing && existing.length > 0) {
      throw new Error(
        `Subscription config for "${subscriptionId}" already exists; use updateConfig() to add a new version`
      );
    }

    const merged = normalizeSettings({ ...DEFAULT_SUBSCRIPTION_CONFIG_SETTINGS, ...settings });
    return this.appendVersion(subscriptionId, merged, null, 'created', options.actor);
  }

  /**
   * Apply a partial update, producing the next version. Creating a
   * configuration implicitly when none exists (acting as version 1).
   */
  updateConfig(
    subscriptionId: string,
    patch: SubscriptionConfigPatch,
    options: SubscriptionConfigChangeOptions = {}
  ): SubscriptionConfigVersion {
    this.assertValidSubscriptionId(subscriptionId);
    const current = this.getCurrentConfig(subscriptionId);
    const base = current ? current.settings : DEFAULT_SUBSCRIPTION_CONFIG_SETTINGS;

    const merged = normalizeSettings({
      eventTypes: patch.eventTypes ?? base.eventTypes,
      channels: patch.channels ?? base.channels,
      active: patch.active ?? base.active,
      options: { ...base.options, ...(patch.options ?? {}) },
    });

    return this.appendVersion(subscriptionId, merged, base, current ? 'updated' : 'created', options.actor);
  }

  private appendVersion(
    subscriptionId: string,
    settings: SubscriptionConfigSettings,
    previousSettings: Readonly<SubscriptionConfigSettings> | null,
    changeSummary: string,
    actor?: string
  ): SubscriptionConfigVersion {
    const list = this.history.get(subscriptionId) ?? [];
    const version = list.length + 1;

    const record: SubscriptionConfigVersion = Object.freeze({
      subscriptionId,
      version,
      settings: freezeSettings(cloneSettings(settings)),
      createdAt: this.now(),
      actor,
      changeSummary,
      changedKeys: diffKeys(previousSettings, settings),
      previousSettings,
    });

    list.push(record);
    this.history.set(subscriptionId, list);

    logger.info('Subscription config version recorded', {
      subscriptionId,
      version,
      changeSummary,
      actor,
      changedKeys: record.changedKeys,
    });

    return record;
  }

  // ---------------------------------------------------------------------------
  // Configuration queries
  // ---------------------------------------------------------------------------

  /** Returns the latest configuration version, or `null` when none exists. */
  getCurrentConfig(subscriptionId: string): SubscriptionConfigVersion | null {
    const list = this.history.get(subscriptionId);
    if (!list || list.length === 0) {
      return null;
    }
    return list[list.length - 1];
  }

  /** Returns the current version number, or `null` when no config exists. */
  getCurrentVersionNumber(subscriptionId: string): number | null {
    return this.getCurrentConfig(subscriptionId)?.version ?? null;
  }

  /** Returns a specific historical version, or `null` when it does not exist. */
  getConfigVersion(subscriptionId: string, version: number): SubscriptionConfigVersion | null {
    const list = this.history.get(subscriptionId);
    if (!list) {
      return null;
    }
    return list.find((record) => record.version === version) ?? null;
  }

  /**
   * Returns the full, ascending version history for a subscription. The
   * returned array is a fresh copy so callers cannot mutate stored history.
   */
  listConfigVersions(subscriptionId: string): SubscriptionConfigVersion[] {
    return [...(this.history.get(subscriptionId) ?? [])];
  }

  // ---------------------------------------------------------------------------
  // Processed-event linking
  // ---------------------------------------------------------------------------

  /**
   * Record a processed event against the config version active right now.
   * The resulting link is frozen and never rewritten by later config updates.
   */
  recordProcessedEvent(
    subscriptionId: string,
    eventId: string,
    options: { contractAddress?: string } = {}
  ): ProcessedEventConfigLink {
    this.assertValidSubscriptionId(subscriptionId);
    if (!eventId || eventId.trim().length === 0) {
      throw new Error('eventId is required');
    }

    const configVersion = this.getCurrentVersionNumber(subscriptionId) ?? 0;
    const link: ProcessedEventConfigLink = Object.freeze({
      eventId,
      subscriptionId,
      contractAddress: options.contractAddress,
      configVersion,
      processedAt: this.now(),
    });

    this.processedEvents.set(eventId, link);

    logger.info('Processed event linked to subscription config version', {
      subscriptionId,
      eventId,
      configVersion,
    });

    return link;
  }

  /** Returns the immutable config link for a processed event, if recorded. */
  getProcessedEvent(eventId: string): ProcessedEventConfigLink | null {
    return this.processedEvents.get(eventId) ?? null;
  }

  /** Lists processed events recorded for a subscription, oldest first. */
  listProcessedEvents(subscriptionId: string): ProcessedEventConfigLink[] {
    return [...this.processedEvents.values()].filter(
      (link) => link.subscriptionId === subscriptionId
    );
  }

  /** Removes all stored configs and processed-event links (for testing). */
  clear(): void {
    this.history.clear();
    this.processedEvents.clear();
  }

  private assertValidSubscriptionId(subscriptionId: string): void {
    if (!subscriptionId || subscriptionId.trim().length === 0) {
      throw new Error('subscriptionId is required');
    }
  }
}

export const subscriptionConfigStore = new SubscriptionConfigStore();
