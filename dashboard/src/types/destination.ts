/**
 * Notification destination configuration types (issue #1107).
 *
 * Secrets (webhook signing secrets, API keys, bot tokens) are never returned
 * to the browser in plaintext. The API reports only whether a secret is set
 * and, optionally, its last four characters; a new value is sent only when
 * the user explicitly replaces it.
 */

export type DestinationProvider = 'webhook' | 'discord' | 'email' | 'telegram';

export type DestinationConnectionStatus = 'connected' | 'not_configured' | 'error' | 'disabled';

/** Server-side view of a secret field: presence only, never the value. */
export interface SecretFieldState {
  isSet: boolean;
  /** Last four characters, for recognition only. */
  last4?: string;
}

export interface DestinationFieldDefinition {
  key: string;
  label: string;
  type: 'url' | 'email' | 'text';
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface NotificationDestination {
  id: string;
  provider: DestinationProvider;
  displayName: string;
  enabled: boolean;
  status: DestinationConnectionStatus;
  /** Non-secret settings, keyed by field key. */
  settings: Record<string, string>;
  /** Secret settings, keyed by field key. */
  secrets: Record<string, SecretFieldState>;
  /** Most recent configuration or delivery error reported by the listener. */
  lastError?: string | null;
  /** Epoch milliseconds of the last test notification. */
  lastTestedAt?: number | null;
}

/**
 * Update payload. `secrets` contains only fields the user replaced; omitted
 * secrets are left unchanged server-side, and an empty string clears one.
 */
export interface DestinationUpdate {
  enabled: boolean;
  settings: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface TestNotificationResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

/** Field-level validation errors keyed by field key (`_form` for global). */
export type DestinationValidationErrors = Record<string, string>;
