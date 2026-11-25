// MockNotificationProvider.ts
// A simple mock implementation of NotificationProvider for unit testing.

import { NotificationProvider, ProviderMetadata, ProviderCapability, NotificationFormat, DeliveryPayload, DeliveryResult } from '../../types/provider-capabilities';

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
  /**
   * Set of notification formats this mock advertises. Defaults to `plain_text`.
   */
  supportedFormats?: Set<NotificationFormat>;
  /**
   * Default format for this mock. Defaults to `plain_text`.
   */
  defaultFormat?: NotificationFormat;
}

export class MockNotificationProvider implements NotificationProvider {
  readonly metadata: ProviderMetadata;
  private readonly options: MockProviderOptions;

  constructor(id: string, name: string, version: string = '1.0.0', options: MockProviderOptions = {}) {
    const supportedFormats = options.supportedFormats ?? new Set([NotificationFormat.PLAIN_TEXT]);
    const defaultFormat = options.defaultFormat ?? NotificationFormat.PLAIN_TEXT;
    this.metadata = {
      id,
      name,
      version,
      capabilities: options.capabilities ?? new Set(),
      supportedFormats,
      defaultFormat,
    };
    this.options = options;
  }

  hasCapability(capability: ProviderCapability): boolean {
    return this.metadata.capabilities.has(capability);
  }

  supportsFormat(format: NotificationFormat): boolean {
    return this.metadata.supportedFormats.has(format);
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
