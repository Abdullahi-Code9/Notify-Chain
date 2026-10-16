/**
 * Provider Capability Declaration System
 *
 * Providers declare which optional features they support by including
 * values from this enum in their `capabilities` set. The pipeline
 * queries these capabilities at runtime and degrades gracefully when a
 * requested feature is not supported.
 */
export enum ProviderCapability {
  RICH_FORMATTING = 'RICH_FORMATTING',
  ATTACHMENTS = 'ATTACHMENTS',
  MESSAGE_UPDATES = 'MESSAGE_UPDATES',
  THREADING = 'THREADING',
  INTERACTIVE_COMPONENTS = 'INTERACTIVE_COMPONENTS',
  NATIVE_SCHEDULING = 'NATIVE_SCHEDULING',
}

/**
 * Metadata that describes a provider and the features it supports.
 */
export interface ProviderMetadata {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
}

export interface DeliveryPayload {
  payload: Record<string, unknown>;
  targetRecipient: string;
  notificationType: string;
  requestedFeatures?: Set<ProviderCapability>;
  requestId?: string;
}

export interface DeliveryResult {
  success: boolean;
  degradedCapabilities: ProviderCapability[];
  errorMessage?: string;

  /** Provider-assigned identifier, when available. */
  providerMessageId?: string;

  /** Small structured response subset; persistence applies an allowlist. */
  providerResponse?: Record<string, unknown>;

  /** Stable provider/transport error code, when available. */
  errorCode?: string;

  /** HTTP response status, when available. */
  statusCode?: number;
}

/**
 * Diagnostic health status for a notification provider.
 */
export type ProviderHealthStatus = 'ok' | 'degraded' | 'error' | 'not_configured';

export interface ProviderHealthResult {
  providerId: string;
  providerName: string;
  status: ProviderHealthStatus;
  latencyMs?: number;
  /** Sanitized error or diagnostic message with credentials redacted. */
  detail?: string;
  checkedAt: string;
}

/**
 * Contract that every notification provider must implement.
 */
export interface NotificationProvider {
  readonly metadata: ProviderMetadata;

  hasCapability(capability: ProviderCapability): boolean;

  deliver(payload: DeliveryPayload): Promise<DeliveryResult>;

  /**
   * Independently check the reachability and health of this notification provider.
   * Invariant: Must sanitize any external failure message to prevent credential exposure.
   */
  checkHealth?(targetRecipient?: string): Promise<ProviderHealthResult>;
}