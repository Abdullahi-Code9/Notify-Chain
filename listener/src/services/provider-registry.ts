import {
  NotificationProvider,
  ProviderCapability,
  ProviderMetadata,
  NotificationFormat,
  DeliveryPayload,
  DeliveryResult,
} from '../types/provider-capabilities';
import { validatePayloadLimits } from './providers/payload-limits';
import logger from '../utils/logger';

/**
 * Circuit breaker states.
 *
 * - `closed`    — normal operation; failures are counted.
 * - `open`      — requests are blocked; the provider is considered unhealthy.
 * - `half-open` — a limited number of recovery attempts are allowed.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Configuration for a single provider's circuit breaker.
 */
export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. Default: 5. */
  failureThreshold: number;
  /** Time in ms the circuit stays open before allowing a recovery attempt. Default: 30_000. */
  resetTimeoutMs: number;
  /** Successful recovery attempts required in half-open before closing. Default: 1. */
  successThreshold: number;
}

const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 1,
};

/**
 * Per-provider circuit breaker. Tracks consecutive failures and transitions
 * between `closed`, `open` and `half-open` states. Instances are independent
 * so one unhealthy provider never affects another.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;

  constructor(
    private readonly providerId: string,
    private readonly options: CircuitBreakerOptions = DEFAULT_CIRCUIT_OPTIONS,
  ) {}

  /** Current circuit state, accounting for elapsed reset timeout. */
  getState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.transitionTo('half-open');
    }
    return this.state;
  }

  /** Returns `true` when a request may be attempted. */
  canAttempt(): boolean {
    return this.getState() !== 'open';
  }

  /** Record a successful delivery. */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.options.successThreshold) {
        this.reset();
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  /** Record a failed delivery, opening the circuit when the threshold is reached. */
  recordFailure(): void {
    if (this.state === 'half-open') {
      // A failed recovery attempt re-opens the circuit immediately.
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.open();
    }
  }

  /** Force the circuit back to a healthy closed state. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = 0;
    this.transitionTo('closed');
  }

  private open(): void {
    this.openedAt = Date.now();
    this.consecutiveSuccesses = 0;
    this.transitionTo('open');
  }

  private transitionTo(next: CircuitState): void {
    if (this.state === next) {
      return;
    }
    logger.warn('CircuitBreaker: state transition', {
      providerId: this.providerId,
      from: this.state,
      to: next,
      consecutiveFailures: this.consecutiveFailures,
    });
    this.state = next;
  }
}

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
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly circuitOptions: CircuitBreakerOptions;

  constructor(circuitOptions: Partial<CircuitBreakerOptions> = {}) {
    this.circuitOptions = { ...DEFAULT_CIRCUIT_OPTIONS, ...circuitOptions };
  }

  /**
   * Retrieve (creating if necessary) the circuit breaker for a provider.
   * Each provider id gets its own independent breaker instance.
   */
  getCircuitBreaker(providerId: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(providerId, this.circuitOptions);
      this.circuitBreakers.set(providerId, breaker);
    }
    return breaker;
  }

  /**
   * Current circuit state for a provider (defaults to `closed` when unknown).
   */
  getCircuitState(providerId: string): CircuitState {
    return this.circuitBreakers.get(providerId)?.getState() ?? 'closed';
  }

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
      this.circuitBreakers.delete(providerId);
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
   * Returns a provider's declared capabilities, preferring an explicit
   * `getCapabilities()` implementation and falling back to `metadata`.
   *
   * This keeps the orchestrator decoupled from concrete provider classes:
   * adding a provider only requires the capabilities to be reachable via one
   * of these two entry points.
   */
  private capabilitiesOf(provider: NotificationProvider): ProviderMetadata {
    return provider.getCapabilities ? provider.getCapabilities() : provider.metadata;
  }

  /**
   * Deliver a notification through the provider registered for `providerId`.
   *
   * Resolves with a `DeliveryResult` describing whether delivery succeeded
   * and which requested features (if any) had to be degraded.
   *
   * Returns `success: false` with `errorCode: 'UNSUPPORTED_FORMAT'` when the
   * caller requests a format the provider does not support.
   *
   * Returns `success: false` with `errorCode: 'PAYLOAD_LIMIT_EXCEEDED'` when the
   * payload exceeds a limit declared by the provider; the provider is not called.
   *
   * Resolves with `success: false` (no rejection) when no provider is
   * registered for `providerId`.
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

    // Validate format preference when explicitly supplied.
    if (payload.formatPreference !== undefined) {
      const isValid = Object.values(NotificationFormat).includes(payload.formatPreference as NotificationFormat);
      if (!isValid) {
        const errorMessage = `Invalid formatPreference "${payload.formatPreference}" — not a recognised NotificationFormat value`;
        logger.warn('ProviderRegistry: delivery rejected — unrecognised format', {
          requestId: payload.requestId,
          providerId,
          formatPreference: payload.formatPreference,
        });
        return {
          success: false,
          degradedCapabilities: [],
          errorMessage,
          errorCode: 'UNSUPPORTED_FORMAT',
        };
      }

      if (!provider.supportsFormat(payload.formatPreference)) {
        const supported = [...provider.metadata.supportedFormats].join(', ');
        const errorMessage =
          `Provider "${providerId}" does not support format "${payload.formatPreference}". ` +
          `Supported formats: [${supported}]`;
        logger.warn('ProviderRegistry: delivery rejected — unsupported format for provider', {
          requestId: payload.requestId,
          providerId,
          formatPreference: payload.formatPreference,
          supportedFormats: supported,
        });
        return {
          success: false,
          degradedCapabilities: [],
          errorMessage,
          errorCode: 'UNSUPPORTED_FORMAT',
        };
      }
    }

    // Circuit breaker gate — block requests while the provider is unhealthy.
    const breaker = this.getCircuitBreaker(providerId);
    if (!breaker.canAttempt()) {
      const errorMessage = `Provider "${providerId}" is temporarily unavailable (circuit open)`;
      logger.warn('ProviderRegistry: delivery blocked — circuit open', {
        requestId: payload.requestId,
        providerId,
        state: breaker.getState(),
    // Enforce provider-specific payload limits before dispatch.
    const { payloadLimits } = this.capabilitiesOf(provider);
    const limitResult = validatePayloadLimits(payload.payload, payloadLimits);
    if (!limitResult.valid) {
      const errorMessage =
        `Provider "${providerId}" rejected the payload: ` +
        limitResult.violations.map((violation) => violation.message).join('; ');
      logger.warn('ProviderRegistry: delivery rejected — payload exceeds provider limits', {
        requestId: payload.requestId,
        providerId,
        violations: limitResult.violations,
      });
      return {
        success: false,
        degradedCapabilities: [],
        errorMessage,
        errorCode: 'PROVIDER_CIRCUIT_OPEN',
        errorCode: 'PAYLOAD_LIMIT_EXCEEDED',
      };
    }

    logger.debug('ProviderRegistry: dispatching delivery', {
      requestId: payload.requestId,
      providerId,
      targetRecipient: payload.targetRecipient,
      formatPreference: payload.formatPreference ?? provider.metadata.defaultFormat,
      circuitState: breaker.getState(),
    });

    let result: DeliveryResult;
    try {
      result = await provider.deliver(payload);
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }

    if (result.success) {
      breaker.recordSuccess();
    } else {
      breaker.recordFailure();
    }

    return result;
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
