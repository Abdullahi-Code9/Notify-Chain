/**
 * Notification preference types — mirrors the Soroban contract types (Issue #178)
 */

export type DeliveryChannel = "Wallet" | "Email" | "InApp";

export type NotificationCategory =
  | "Payment"
  | "GroupMembership"
  | "GroupStatus"
  | "SystemAlerts"
  | "General";

export interface ChannelPreference {
  channel: DeliveryChannel;
  enabled: boolean;
}

export interface CategoryPreference {
  category: NotificationCategory;
  enabled: boolean;
}

/**
 * Quiet hours configuration (Issue #1227).
 *
 * Quiet hours are expressed as minutes since local midnight so that they are
 * independent of any particular date. A window may wrap around midnight
 * (e.g. start 22:00 = 1320, end 07:00 = 420).
 */
export interface QuietHours {
  enabled: boolean;
  /** Minutes since local midnight when quiet hours begin (0-1439). */
  start_minutes: number;
  /** Minutes since local midnight when quiet hours end (0-1439). */
  end_minutes: number;
  /** IANA timezone identifier, e.g. "America/New_York". Defaults to UTC. */
  timezone: string;
}

/**
 * Delivery window configuration (Issue #1227).
 *
 * Notifications are only delivered inside the active delivery window. Events
 * received outside the window are preserved and delivered once it reopens.
 */
export interface DeliveryWindow {
  enabled: boolean;
  /** Minutes since local midnight when the delivery window opens (0-1439). */
  start_minutes: number;
  /** Minutes since local midnight when the delivery window closes (0-1439). */
  end_minutes: number;
  /** IANA timezone identifier, e.g. "Europe/London". Defaults to UTC. */
  timezone: string;
}

export interface RecipientPreferences {
  recipient: string; // Stellar public key
  channels: ChannelPreference[];
  categories: CategoryPreference[];
  quiet_hours: QuietHours;
  delivery_window: DeliveryWindow;
  updated_at: number; // Unix timestamp (ledger time)
}

/** Human-readable labels for the UI */
export const CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  Wallet: "Wallet Notifications",
  Email: "Email Notifications",
  InApp: "In-App Notifications",
};

export const CHANNEL_DESCRIPTIONS: Record<DeliveryChannel, string> = {
  Wallet: "On-chain events delivered directly to your connected wallet",
  Email: "Receive notifications at your verified email address",
  InApp: "Push notifications inside the Notify-Chain dashboard",
};

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  Payment: "Payment Events",
  GroupMembership: "Group Membership",
  GroupStatus: "Group Status",
  SystemAlerts: "System Alerts",
  General: "General",
};

export const CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  Payment: "Payments received, sent, or subscription top-ups",
  GroupMembership: "Members added or removed from your groups",
  GroupStatus: "Groups activated or deactivated",
  SystemAlerts: "Contract paused, admin transfers, and critical alerts",
  General: "All other platform notifications",
};

/** Default quiet hours: disabled, 22:00-07:00 UTC. */
export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start_minutes: 22 * 60,
  end_minutes: 7 * 60,
  timezone: "UTC",
};

/** Default delivery window: disabled, all day UTC. */
export const DEFAULT_DELIVERY_WINDOW: DeliveryWindow = {
  enabled: false,
  start_minutes: 0,
  end_minutes: 24 * 60 - 1,
  timezone: "UTC",
};

/** Default all-enabled preferences (mirrors contract defaults) */
export const DEFAULT_PREFERENCES: Omit<RecipientPreferences, "recipient" | "updated_at"> = {
  channels: [
    { channel: "Wallet", enabled: true },
    { channel: "Email", enabled: true },
    { channel: "InApp", enabled: true },
  ],
  categories: [
    { category: "Payment", enabled: true },
    { category: "GroupMembership", enabled: true },
    { category: "GroupStatus", enabled: true },
    { category: "SystemAlerts", enabled: true },
    { category: "General", enabled: true },
  ],
  quiet_hours: DEFAULT_QUIET_HOURS,
  delivery_window: DEFAULT_DELIVERY_WINDOW,
};
