export type NotificationCategory = 'discord' | string;

/**
 * A time-of-day boundary expressed as "HH:mm" in 24-hour format (e.g. "22:30").
 */
export type TimeOfDay = string;

/**
 * Days of the week on which a delivery window is active.
 * Uses lowercase three-letter abbreviations.
 */
export type DeliveryDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * User-specific quiet hours during which notifications should be delayed.
 * `start` and `end` are interpreted in the user's configured timezone.
 * If `start` is later than `end`, the quiet period spans midnight.
 */
export interface QuietHours {
  enabled: boolean;
  /** Start of the quiet period, inclusive ("HH:mm"). */
  start: TimeOfDay;
  /** End of the quiet period, exclusive ("HH:mm"). */
  end: TimeOfDay;
}

/**
 * Timezone-aware delivery window describing when notifications may be sent.
 * `timezone` is an IANA timezone identifier (e.g. "America/New_York").
 */
export interface DeliveryWindow {
  enabled: boolean;
  /** Days on which delivery is permitted. Empty means every day. */
  days: DeliveryDay[];
  /** Start of the delivery window, inclusive ("HH:mm"). */
  start: TimeOfDay;
  /** End of the delivery window, exclusive ("HH:mm"). */
  end: TimeOfDay;
  /** IANA timezone identifier used to evaluate the window. */
  timezone: string;
}

export interface UserPreferences {
  userId: string;
  /** Map of notification category → enabled flag */
  categories: Record<NotificationCategory, boolean>;
  /** Optional user-specific quiet hours. */
  quietHours?: QuietHours;
  /** Optional timezone-aware delivery window. */
  deliveryWindow?: DeliveryWindow;
  updatedAt: number;
}

export interface PreferencesUpdateInput {
  categories: Record<NotificationCategory, boolean>;
  /** Optional quiet hours configuration to apply. */
  quietHours?: QuietHours;
  /** Optional delivery window configuration to apply. */
  deliveryWindow?: DeliveryWindow;
}