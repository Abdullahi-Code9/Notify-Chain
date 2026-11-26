/**
 * Notification & webhook destination domain types.
 *
 * Every destination record is explicitly bound to an owning account (`ownerId`).
 * Plaintext secrets are stored server-side only and are never returned to API
 * callers; public responses expose only presence and optional last-4 metadata.
 */

export type DestinationProvider = 'webhook' | 'discord' | 'email' | 'telegram';

export const DESTINATION_PROVIDERS: readonly DestinationProvider[] = [
  'webhook',
  'discord',
  'email',
  'telegram',
] as const;

export type DestinationConnectionStatus = 'connected' | 'not_configured' | 'error' | 'disabled';

/** Server-side view of a secret field: presence only, never the raw secret. */
export interface SecretFieldState {
  isSet: boolean;
  /** Last four characters, for operator recognition only. */
  last4?: string;
}

/** Internal persisted record, including raw secret values. */
export interface DestinationRecord {
  id: string;
  ownerId: string;
  provider: DestinationProvider;
  displayName: string;
  enabled: boolean;
  status: DestinationConnectionStatus;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  lastError: string | null;
  lastTestedAt: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Public API view returned to authenticated destination owners. */
export interface NotificationDestination {
  id: string;
  ownerId: string;
  provider: DestinationProvider;
  displayName: string;
  enabled: boolean;
  status: DestinationConnectionStatus;
  settings: Record<string, string>;
  secrets: Record<string, SecretFieldState>;
  lastError?: string | null;
  lastTestedAt?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDestinationInput {
  id?: string;
  provider: DestinationProvider;
  displayName?: string;
  enabled?: boolean;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
  /**
   * Optional caller-supplied ownerId. Rejected server-side if it does not match
   * the authenticated principal to prevent cross-account creation.
   */
  ownerId?: string;
}

export interface DestinationUpdate {
  displayName?: string;
  enabled: boolean;
  settings: Record<string, string>;
  secrets?: Record<string, string>;
  /**
   * Optional caller-supplied ownerId. Rejected server-side if it differs from
   * the authenticated owner to prevent ownership hijacking/reassignment.
   */
  ownerId?: string;
}

export interface TestNotificationResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

export type DestinationValidationErrors = Record<string, string>;

/** Resolved server-side delivery target for scheduling or dispatching. */
export interface ResolvedDestinationTarget {
  id: string;
  ownerId: string;
  provider: DestinationProvider;
  enabled: boolean;
  status: DestinationConnectionStatus;
  targetRecipient: string;
  signingSecret?: string;
}
