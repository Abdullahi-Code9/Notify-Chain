// MockNotificationProvider.ts
// A simple mock implementation of NotificationProvider for unit testing.

import { NotificationProvider, ProviderMetadata, ProviderCapability, DeliveryPayload, DeliveryResult } from '../../types/provider-capabilities';

/**
 * Options to control the mock provider's behavior.
 */
export interface MockProviderOptions {
  /**
   * Should the delivery be considered successful?
   * If false, the provider will return a failure result.
   */
  succeed?: boolean;
  /**
   * Simulated latency in milliseconds before resolving.
   */
  delayMs?: number;
  /**
   * Optional error message for failed deliveries.
   */
  errorMessage?: string;
  /**
   * Set of capabilities this mock advertises.
   */
  capabilities?: Set<ProviderCapability>;
}

export class MockNotificationProvider implements NotificationProvider {
  readonly metadata: ProviderMetadata;
  private readonly options: MockProviderOptions;

  constructor(id: string, name: string, version: string = '1.0.0', options: MockProviderOptions = {}) {
    this.metadata = {
      id,
      name,
      version,
      capabilities: options.capabilities ?? new Set(),
    };
    this.options = options;
  }

  hasCapability(capability: ProviderCapability): boolean {
    return this.metadata.capabilities.has(capability);
  }

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const { delayMs = 0, succeed = true, errorMessage = 'Mock delivery failure' } = this.options;

    // Simulate async delay if requested
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Determine degraded capabilities based on requested features
    const degraded: ProviderCapability[] = [];
    if (payload.requestedFeatures) {
      for (const feature of payload.requestedFeatures) {
        if (!this.hasCapability(feature)) {
          degraded.push(feature);
        }
      }
    }

    if (succeed) {
      return {
        success: true,
        degradedCapabilities: degraded,
      };
    }

    return {
      success: false,
      degradedCapabilities: degraded,
      errorMessage,
    };
  }
}
