import {
  NotificationProvider,
  ProviderCapability,
  DeliveryPayload,
  DeliveryResult,
} from '../types/provider-capabilities';
import logger from '../utils/logger';

/**
 * Central registry for `NotificationProvider` implementations.
 *
 * The pipeline depends only on this registry — it never imports a concrete
 * provider class directly. This makes it easy to add, replace, or mock
 * providers without touching the scheduler or any other pipeline code.
 *
 * Usage:
 * ```ts
 * const registry = new ProviderRegistry();
 * registry.register(new DiscordNotificationProvider(config));
 * registry.register(new WebhookNotificationProvider());
 *
 * // In the scheduler:
 * const result = await registry.deliver('discord', payload);
 * ```
 *
 * The registry key is `provider.metadata.id`, which must match the
 * `NotificationType` string used in `ScheduledNotification.notificationType`.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, NotificationProvider>();

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a provider. Overwrites any previously registered provider
   * with the same `metadata.id`.
   */
  register(provider: NotificationProvider): this {
    const { id, name } = provider.metadata;
    if (this.providers.has(id)) {
      logger.warn('ProviderRegistry: overwriting existing provider', { id, name });
    }
    this.providers.set(id, provider);
    logger.info('ProviderRegistry: provider registered', {
      id,
      name,
      capabilities: [...provider.metadata.capabilities],
    });
    return this;
  }

  /**
   * Deregister a provider by its `metadata.id`.
   * Returns `true` if the provider was found and removed, `false` otherwise.
   */
  unregister(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    if (removed) {
      logger.info('ProviderRegistry: provider removed', { id: providerId });
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a provider by its `metadata.id`.
   * Returns `undefined` when no provider is registered for that id.
   */
  get(providerId: string): NotificationProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Returns `true` when a provider is registered for the given id.
   */
  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /**
   * List all registered provider ids.
   */
  listIds(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Returns all providers that declare support for the given capability.
   * Useful for feature-based routing ("which providers can send attachments?").
   */
  findByCapability(capability: ProviderCapability): NotificationProvider[] {
    return [...this.providers.values()].filter((p) => p.hasCapability(capability));
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  /**
   * Deliver a notification through the provider registered for `providerId`.
   *
   * Resolves with a `DeliveryResult` describing whether delivery succeeded
   * and which requested features (if any) had to be degraded.
   *
   * Rejects with an `Error` when no provider is registered for `providerId` —
   * the caller is responsible for checking `has()` first or catching the error.
   */
  async deliver(providerId: string, payload: DeliveryPayload): Promise<DeliveryResult> {
    const provider = this.providers.get(providerId);

    if (!provider) {
      const errorMessage = `No provider registered for type "${providerId}". Registered types: [${this.listIds().join(', ')}]`;
      logger.error('ProviderRegistry: delivery failed — unknown provider', {
        requestId: payload.requestId,
        providerId,
        registered: this.listIds(),
      });
      return {
        success: false,
        degradedCapabilities: [],
        errorMessage,
      };
    }

    logger.debug('ProviderRegistry: dispatching delivery', {
      requestId: payload.requestId,
      providerId,
      targetRecipient: payload.targetRecipient,
    });

    return provider.deliver(payload);
  }
}

/**
 * Module-level singleton registry.
 *
 * Import this in the scheduler and anywhere else that needs to dispatch
 * notifications. Populate it during application boot before starting the
 * scheduler.
 */
let _registry: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!_registry) {
    _registry = new ProviderRegistry();
  }
  return _registry;
}

/**
 * Replace the module-level registry. Primarily for testing.
 */
export function setProviderRegistry(registry: ProviderRegistry): void {
  _registry = registry;
}

/**
 * Reset the singleton back to `null`. Useful in test teardowns.
 */
export function resetProviderRegistry(): void {
  _registry = null;
}
