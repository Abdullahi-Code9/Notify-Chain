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
 * Format options a notification destination can render.
 *
 * - `plain_text` — plain unformatted text; every channel must support this.
 * - `markdown`   — Markdown-formatted text (bold, italic, code, etc.).
 * - `embed`      — Rich embed/card objects (e.g. Discord embeds).
 * - `json`       — Structured JSON payload (typically for webhooks).
 * - `html`       — HTML-formatted text (for email-style channels).
 */
export enum NotificationFormat {
  PLAIN_TEXT = 'plain_text',
  MARKDOWN = 'markdown',
  EMBED = 'embed',
  JSON = 'json',
  HTML = 'html',
}

/**
 * An explicit format preference attached to a single delivery.
 *
 * When present in `DeliveryPayload.formatPreference`, the registry validates
 * it against the target provider's `supportedFormats`.  When absent, the
 * provider's `defaultFormat` is used implicitly.
 */
export type FormatPreference = NotificationFormat;

/**
 * Metadata that describes a provider and the features it supports.
 */
export interface ProviderMetadata {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  /**
   * The complete set of `NotificationFormat` values this provider can render.
   * Must include at least one entry; `plain_text` is universally safe.
   */
  readonly supportedFormats: ReadonlySet<NotificationFormat>;
  /**
   * The format used when no explicit `formatPreference` is supplied.
   * Must be a member of `supportedFormats`.
   */
  readonly defaultFormat: NotificationFormat;
}

export interface DeliveryPayload {
  payload: Record<string, unknown>;
  targetRecipient: string;
  notificationType: string;
  requestedFeatures?: Set<ProviderCapability>;
  requestId?: string;
  /**
   * The format in which this notification should be rendered.
   *
   * When supplied, `ProviderRegistry.deliver` validates it against the
   * target provider's `supportedFormats` and returns a `UNSUPPORTED_FORMAT`
   * error result without calling the provider when the format is unsupported.
   * When omitted, the provider's `defaultFormat` is used implicitly.
   */
  formatPreference?: FormatPreference;
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

  /**
   * Returns `true` when the given format is listed in `metadata.supportedFormats`.
   */
  supportsFormat(format: NotificationFormat): boolean;

  deliver(payload: DeliveryPayload): Promise<DeliveryResult>;

  /**
   * Independently check the reachability and health of this notification provider.
   * Invariant: Must sanitize any external failure message to prevent credential exposure.
   */
  checkHealth?(targetRecipient?: string): Promise<ProviderHealthResult>;
}