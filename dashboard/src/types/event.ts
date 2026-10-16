/**
 * Lifecycle status of a scheduled notification, derived from on-chain events.
 *
 * - `active`   – notification is scheduled and has not yet expired or been revoked.
 * - `expired`  – the notification's TTL elapsed and it was reaped on-chain
 *                (NotificationExpired event received).
 * - `revoked`  – the notification was explicitly revoked before its TTL elapsed
 *                (NotificationRevoked event received).
 *
 * Non-notification events (group lifecycle, admin, financial) carry `undefined`.
 */
export type NotificationLifecycleStatus = 'active' | 'expired' | 'revoked';

/**
 * The set of event names that represent a notification status transition.
 * Receiving one of these events means the notification identified by
 * `relatedNotificationId` has moved to the corresponding `notificationStatus`.
 */
export const NOTIFICATION_STATUS_EVENTS: Record<string, NotificationLifecycleStatus> = {
  notification_scheduled: 'active',
  notification_expired: 'expired',
  notification_revoked: 'revoked',
  // Issue #372: subscription preference updates produce their own event type.
  // subscription_updated is not a lifecycle transition (no status to hydrate)
  // but registering it here ensures the dashboard recognises the event name
  // and can filter/display it correctly.
};

/**
 * The set of recognised subscription-related event names.
 * Unlike notification lifecycle events these do not carry a status value —
 * they are emitted purely to signal that a user's preference record changed.
 */
export const SUBSCRIPTION_EVENT_NAMES = ['subscription_updated'] as const;

export type SubscriptionEventName = (typeof SUBSCRIPTION_EVENT_NAMES)[number];

export interface BlockchainEvent {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: string[];
  value: string;
  txHash?: string;
  receivedAt: number;
  /**
   * Lifecycle status of this notification. Populated for notification lifecycle
   * events (`notification_scheduled`, `notification_expired`,
   * `notification_revoked`). Undefined for all other event types including
   * `subscription_updated`.
   */
  notificationStatus?: NotificationLifecycleStatus;
  /**
   * For status-transition events (`notification_expired`, `notification_revoked`),
   * the `eventId` of the originating `notification_scheduled` event whose status
   * this event updates. Used by the cache-invalidation layer to patch the
   * matching cached entry in-place.
   */
  relatedNotificationId?: string;
  /** Whether the user has seen/read this notification. Default: false */
  read?: boolean;
}

/**
 * UI filter status for the notification search bar.
 *
 * - `all`    – show all notifications regardless of read state.
 * - `read`   – show only notifications the user has already seen.
 * - `unread` – show only notifications the user has not yet seen.
 */
export type NotificationStatus = 'all' | 'read' | 'unread';
/** Read/unread filter used by the notification search UI. */
/** Read/unread filter for Event Explorer notification lists (not delivery status). */
export type NotificationReadFilter = 'all' | 'read' | 'unread';

/**
 * Sort options for the notification list (#495).
 *
 * - `newest`          – most recently received first (default)
 * - `oldest`          – earliest received first
 * - `priority`        – events with the highest scheduling priority first
 * - `delivery_status` – group by delivery status (active → expired → revoked → undefined)
 */
export type NotificationSortOption = 'newest' | 'oldest' | 'priority' | 'delivery_status';

export interface EventFilters {
  search: string;
  contractAddress: string;
  eventType: string;
  status: NotificationReadFilter;
  dateFrom: string; // ISO date string "YYYY-MM-DD" or ""
  dateTo: string; // ISO date string "YYYY-MM-DD" or ""
  txHash?: string;
  /** Active sort order for the notification list (#495). Defaults to "newest". */
  sortBy?: NotificationSortOption;
}
