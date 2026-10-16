/**
 * Notification Provider Manager
 *
 * Manages registration, discovery, and orchestration of multiple notification providers.
 * Handles failures consistently and provides a unified interface for sending notifications
 * through multiple delivery channels.
 */

import type {
  NotificationProvider,
  NotificationProviderManager,
  ProviderSendResult,
  ProviderFailureHandler,
  ProviderSuccessHandler,
} from './types';
import type { BlockchainEvent } from '../../types/event';

export class ProviderManager implements NotificationProviderManager {
  private providers: Map<string, NotificationProvider> = new Map();
  private failureHandlers: ProviderFailureHandler[] = [];
  private successHandlers: ProviderSuccessHandler[] = [];

  /**
   * Register a provider
   */
  register(provider: NotificationProvider): void {
    const name = provider.getName();

    if (this.providers.has(name)) {
      console.warn(`Provider "${name}" is already registered. Replacing existing provider.`);
    }

    this.providers.set(name, provider);
    console.log(`Provider "${name}" registered successfully.`);
  }

  /**
   * Unregister a provider by name
   */
  async unregister(name: string): Promise<void> {
    const provider = this.providers.get(name);

    if (!provider) {
      console.warn(`Provider "${name}" is not registered.`);
      return;
    }

    // Call cleanup if available
    if (provider.dispose) {
      try {
        await provider.dispose();
      } catch (error) {
        console.error(`Error disposing provider "${name}":`, error);
      }
    }

    this.providers.delete(name);
    console.log(`Provider "${name}" unregistered.`);
  }

  /**
   * Get a registered provider by name
   */
  getProvider(name: string): NotificationProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): NotificationProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all available (enabled) providers
   */
  getAvailableProviders(): NotificationProvider[] {
    return this.getAllProviders().filter((p) => p.isAvailable());
  }

  /**
   * Register a failure handler
   */
  onFailure(handler: ProviderFailureHandler): void {
    this.failureHandlers.push(handler);
  }

  /**
   * Register a success handler
   */
  onSuccess(handler: ProviderSuccessHandler): void {
    this.successHandlers.push(handler);
  }

  /**
   * Send notification through all available providers
   */
  async sendAll(event: BlockchainEvent): Promise<Map<string, ProviderSendResult>> {
    const availableProviders = this.getAvailableProviders();
    return this.send(
      event,
      availableProviders.map((p) => p.getName())
    );
  }

  /**
   * Send notification through specific providers
   *
   * If no provider names are specified, sends through all available providers.
   * Collects results from all providers and handles failures consistently.
   */
  async send(
    event: BlockchainEvent,
    providerNames?: string[]
  ): Promise<Map<string, ProviderSendResult>> {
    const results = new Map<string, ProviderSendResult>();
    const targetProviders = providerNames
      ? providerNames
          .map((name) => this.getProvider(name))
          .filter((p) => p !== undefined) as NotificationProvider[]
      : this.getAvailableProviders();

    // Send through all providers concurrently
    const sendPromises = targetProviders.map(async (provider) => {
      try {
        const result = await this.sendWithTimeout(provider, event);
        results.set(provider.getName(), result);

        // Call success handlers
        if (result.status === 'success') {
          await this.callSuccessHandlers(provider, event, result);
        } else {
          await this.callFailureHandlers(provider, event, result);
        }
      } catch (error) {
        const result: ProviderSendResult = {
          status: 'failure',
          message: `Unexpected error sending notification: ${error instanceof Error ? error.message : String(error)}`,
          error: {
            code: 'UNEXPECTED_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        };

        results.set(provider.getName(), result);
        await this.callFailureHandlers(provider, event, result);
      }
    });

    await Promise.all(sendPromises);
    return results;
  }

  /**
   * Send with timeout protection
   */
  private async sendWithTimeout(
    provider: NotificationProvider,
    event: BlockchainEvent
  ): Promise<ProviderSendResult> {
    const config = provider.getConfig();
    const timeoutMs = config.timeoutMs ?? 30000; // 30s default

    const timeoutPromise = new Promise<ProviderSendResult>((resolve) => {
      setTimeout(() => {
        resolve({
          status: 'failure',
          message: `Provider "${provider.getName()}" timed out after ${timeoutMs}ms`,
          error: {
            code: 'TIMEOUT',
            message: `Operation exceeded ${timeoutMs}ms`,
          },
        });
      }, timeoutMs);
    });

    return Promise.race([provider.send(event), timeoutPromise]);
  }

  /**
   * Call all success handlers
   */
  private async callSuccessHandlers(
    provider: NotificationProvider,
    event: BlockchainEvent,
    result: ProviderSendResult
  ): Promise<void> {
    for (const handler of this.successHandlers) {
      try {
        await handler(provider, event, result);
      } catch (error) {
        console.error(
          `Error in success handler for provider "${provider.getName()}":`,
          error
        );
      }
    }
  }

  /**
   * Call all failure handlers
   */
  private async callFailureHandlers(
    provider: NotificationProvider,
    event: BlockchainEvent,
    result: ProviderSendResult
  ): Promise<void> {
    for (const handler of this.failureHandlers) {
      try {
        await handler(provider, event, result);
      } catch (error) {
        console.error(
          `Error in failure handler for provider "${provider.getName()}":`,
          error
        );
      }
    }
  }

  /**
   * Get health status of all providers
   */
  async getHealthStatus(): Promise<Map<string, { healthy: boolean; reason?: string }>> {
    const health = new Map<string, { healthy: boolean; reason?: string }>();

    for (const provider of this.getAllProviders()) {
      if (provider.healthCheck) {
        try {
          const result = await provider.healthCheck();
          health.set(provider.getName(), result);
        } catch (error) {
          health.set(provider.getName(), {
            healthy: false,
            reason: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      } else {
        // If no health check, report available status
        health.set(provider.getName(), {
          healthy: provider.isAvailable(),
          reason: provider.isAvailable() ? 'Provider is available' : 'Provider is disabled',
        });
      }
    }

    return health;
  }

  /**
   * Cleanup all providers
   */
  async disposeAll(): Promise<void> {
    const providerNames = Array.from(this.providers.keys());
    for (const name of providerNames) {
      await this.unregister(name);
    }
  }
}

/**
 * Create and configure a provider manager with default setup
 */
export function createProviderManager(): ProviderManager {
  return new ProviderManager();
}
