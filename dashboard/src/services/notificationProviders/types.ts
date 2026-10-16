/**
 * Notification Provider Types and Abstractions
 *
 * This module defines the core interfaces and types for the notification provider system.
 * It provides a common abstraction that allows different delivery channels (email, Discord,
 * console, webhooks, etc.) to be implemented without modifying the core event-processing pipeline.
 */

import type { BlockchainEvent } from '../../types/event';

/**
 * Provider status codes
 */
export enum ProviderStatus {
  Success = 'success',
  Failure = 'failure',
  Retry = 'retry',
  Skipped = 'skipped',
}

/**
 * Result of a provider send operation
 */
export interface ProviderSendResult {
  /** Overall status of the send operation */
  status: ProviderStatus;

  /** Human-readable message describing the result */
  message: string;

  /** Optional error details if status is failure */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };

  /** Optional metadata about the send operation */
  metadata?: {
    /** Time taken to send in milliseconds */
    durationMs?: number;
    /** Delivery identifier (e.g., message ID, email ID) */
    deliveryId?: string;
    /** Number of retry attempts made */
    retryAttempts?: number;
    /** Custom provider-specific data */
    [key: string]: unknown;
  };
}

/**
 * Provider configuration options
 */
export interface ProviderConfig {
  /** Whether the provider is enabled */
  enabled: boolean;

  /** Maximum number of retry attempts */
  maxRetries?: number;

  /** Timeout in milliseconds for send operations */
  timeoutMs?: number;

  /** Custom provider-specific configuration */
  [key: string]: unknown;
}

/**
 * Core notification provider interface
 *
 * All notification providers must implement this interface to be compatible
 * with the notification system. This ensures consistent error handling,
 * configuration management, and extensibility.
 *
 * @example
 * ```typescript
 * class EmailProvider implements NotificationProvider {
 *   getName() { return 'EmailProvider'; }
 *   isAvailable() { return this.config.enabled; }
 *   async send(event) { ... }
 *   async sendBatch(events) { ... }
 * }
 * ```
 */
export interface NotificationProvider {
  /**
   * Get the provider's unique identifier
   * @returns Provider name (e.g., 'EmailProvider', 'DiscordProvider')
   */
  getName(): string;

  /**
   * Check if the provider is configured and available for use
   * @returns true if the provider can be used, false otherwise
   */
  isAvailable(): boolean;

  /**
   * Send a single notification for a blockchain event
   *
   * Implementations should:
   * - Return a ProviderSendResult with appropriate status
   * - Handle transient errors gracefully
   * - Include metadata about the delivery attempt
   * - Throw only in truly exceptional cases (e.g., configuration errors)
   *
   * @param event The blockchain event to notify about
   * @returns Promise resolving to the send result
   */
  send(event: BlockchainEvent): Promise<ProviderSendResult>;

  /**
   * Send notifications for multiple blockchain events (optional optimization)
   *
   * Implementations may override this for batch efficiency. Default behavior
   * is to call send() for each event individually.
   *
   * @param events Array of blockchain events to notify about
   * @returns Promise resolving to array of send results (one per event)
   */
  sendBatch?(events: BlockchainEvent[]): Promise<ProviderSendResult[]>;

  /**
   * Get provider configuration
   * @returns Current provider configuration
   */
  getConfig(): ProviderConfig;

  /**
   * Update provider configuration
   * @param config Partial configuration to merge with existing config
   */
  updateConfig(config: Partial<ProviderConfig>): void;

  /**
   * Health check - verify provider connectivity and configuration
   *
   * Implementations should perform lightweight checks like:
   * - Connectivity to external services
   * - Configuration validity
   * - Required environment variables
   *
   * @returns Promise resolving to health check result
   */
  healthCheck?(): Promise<{ healthy: boolean; reason?: string }>;

  /**
   * Cleanup and resource management
   *
   * Called when the provider is being unregistered or the application is shutting down.
   */
  dispose?(): Promise<void>;
}

/**
 * Provider manager for orchestrating multiple providers
 */
export interface NotificationProviderManager {
  /**
   * Register a provider
   */
  register(provider: NotificationProvider): void;

  /**
   * Unregister a provider by name
   */
  unregister(name: string): void;

  /**
   * Get a registered provider by name
   */
  getProvider(name: string): NotificationProvider | undefined;

  /**
   * Get all registered providers
   */
  getAllProviders(): NotificationProvider[];

  /**
   * Send notification through all available providers
   */
  sendAll(event: BlockchainEvent): Promise<Map<string, ProviderSendResult>>;

  /**
   * Send notification through specific providers
   */
  send(
    event: BlockchainEvent,
    providerNames?: string[]
  ): Promise<Map<string, ProviderSendResult>>;
}

/**
 * Provider failure handler
 */
export type ProviderFailureHandler = (
  provider: NotificationProvider,
  event: BlockchainEvent,
  result: ProviderSendResult
) => Promise<void> | void;

/**
 * Provider success handler
 */
export type ProviderSuccessHandler = (
  provider: NotificationProvider,
  event: BlockchainEvent,
  result: ProviderSendResult
) => Promise<void> | void;
