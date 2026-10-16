/**
 * Centralized Event Type Presentation Mapping
 * Resolves Issue #611 — Add Event Type Presentation Mapping
 */

export interface EventTypePresentation {
  /** Human-readable display label */
  label: string;
  /** Primary CSS badge class */
  badgeClass: string;
  /** Alternative kind/category badge class */
  kindBadgeClass: string;
  /** Category or event family */
  category: 'Group' | 'Admin' | 'Financial' | 'Notification' | 'System' | 'Debug' | 'General';
  /** Human-readable event kind label */
  kindLabel: string;
  /** Primary color indicator */
  color: 'green' | 'blue' | 'purple' | 'red' | 'yellow' | 'orange' | 'gray';
  /** Representative icon or symbol */
  icon: string;
  /** Detailed description of the event type */
  description: string;
}

export const UNKNOWN_EVENT_TYPE_PRESENTATION: EventTypePresentation = {
  label: 'Unknown Event',
  badgeClass: 'event-card__badge--default',
  kindBadgeClass: 'event-explorer__badge--default',
  category: 'General',
  kindLabel: 'Unknown',
  color: 'gray',
  icon: '⚡',
  description: 'Generic blockchain event payload with no specific presentation mapping.',
};

export const EVENT_TYPE_PRESENTATIONS: Record<string, EventTypePresentation> = {
  TaskCreated: {
    label: 'Task Created',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'green',
    icon: '📝',
    description: 'Emitted when a new task or work item is instantiated.',
  },
  WorkSubmitted: {
    label: 'Work Submitted',
    badgeClass: 'event-card__badge--blue',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'blue',
    icon: '📤',
    description: 'Emitted when a worker submits completed work.',
  },
  SubmissionApproved: {
    label: 'Submission Approved',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'green',
    icon: '✅',
    description: 'Emitted when submitted work passes validation and is approved.',
  },
  SubmissionRejected: {
    label: 'Submission Rejected',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'red',
    icon: '❌',
    description: 'Emitted when submitted work fails review and is rejected.',
  },
  TaskCancelled: {
    label: 'Task Cancelled',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'red',
    icon: '🚫',
    description: 'Emitted when an active task is aborted before completion.',
  },
  DisputeRaised: {
    label: 'Dispute Raised',
    badgeClass: 'event-card__badge--yellow',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Admin',
    kindLabel: 'Contract',
    color: 'yellow',
    icon: '⚠️',
    description: 'Emitted when a party opens a formal dispute resolution process.',
  },
  AutoshareCreated: {
    label: 'AutoShare Created',
    badgeClass: 'event-card__badge--purple',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Group',
    kindLabel: 'Contract',
    color: 'purple',
    icon: '👥',
    description: 'Emitted when a new AutoShare group is registered on-chain.',
  },
  AutoshareUpdated: {
    label: 'AutoShare Updated',
    badgeClass: 'event-card__badge--purple',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Group',
    kindLabel: 'Contract',
    color: 'purple',
    icon: '🔄',
    description: 'Emitted when an AutoShare group membership list is updated.',
  },
  GroupDeactivated: {
    label: 'Group Deactivated',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Group',
    kindLabel: 'Contract',
    color: 'red',
    icon: '⏸️',
    description: 'Emitted when an AutoShare group is paused or deactivated.',
  },
  GroupActivated: {
    label: 'Group Activated',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Group',
    kindLabel: 'Contract',
    color: 'green',
    icon: '▶️',
    description: 'Emitted when a deactivated AutoShare group is reactivated.',
  },
  Withdrawal: {
    label: 'Withdrawal',
    badgeClass: 'event-card__badge--orange',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Financial',
    kindLabel: 'Financial',
    color: 'orange',
    icon: '💸',
    description: 'Emitted when collected protocol fees or funds are withdrawn.',
  },
  NotificationScheduled: {
    label: 'Notification Scheduled',
    badgeClass: 'event-card__badge--blue',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'blue',
    icon: '📅',
    description: 'Emitted when a notification is scheduled for future delivery.',
  },
  NotificationExpired: {
    label: 'Notification Expired',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'red',
    icon: '⌛',
    description: 'Emitted when a notification exceeds its designated lifetime.',
  },
  ScheduledNotificationCancelled: {
    label: 'Scheduled Cancelled',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'red',
    icon: '🛑',
    description: 'Emitted when a scheduled notification is cancelled prior to expiry.',
  },
  NotificationDelivered: {
    label: 'Notification Delivered',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'green',
    icon: '📬',
    description: 'Emitted when delivery to recipient is confirmed.',
  },
  NotificationAcknowledged: {
    label: 'Notification Acknowledged',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'green',
    icon: '👁️',
    description: 'Emitted when the recipient explicitly acknowledges receipt.',
  },
  BatchNotificationsCreated: {
    label: 'Batch Notifications Created',
    badgeClass: 'event-card__badge--purple',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'purple',
    icon: '📦',
    description: 'Emitted when a batch of notifications is registered in a single transaction.',
  },
  AuditRecordAppended: {
    label: 'Audit Record Appended',
    badgeClass: 'event-card__badge--purple',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Admin',
    kindLabel: 'System',
    color: 'purple',
    icon: '📜',
    description: 'Emitted when a new entry is logged into the on-chain audit record.',
  },
  ContractPaused: {
    label: 'Contract Paused',
    badgeClass: 'event-card__badge--red',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Admin',
    kindLabel: 'System',
    color: 'red',
    icon: '⏸️',
    description: 'Emitted when administrative emergency pause is engaged.',
  },
  ContractUnpaused: {
    label: 'Contract Unpaused',
    badgeClass: 'event-card__badge--green',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'Admin',
    kindLabel: 'System',
    color: 'green',
    icon: '▶️',
    description: 'Emitted when administrative pause is lifted.',
  },
  contract: {
    label: 'Contract Event',
    badgeClass: 'event-card__badge--blue',
    kindBadgeClass: 'event-explorer__badge--blue',
    category: 'Notification',
    kindLabel: 'Contract',
    color: 'blue',
    icon: '⚙️',
    description: 'Standard smart contract execution event.',
  },
  system: {
    label: 'System Event',
    badgeClass: 'event-card__badge--purple',
    kindBadgeClass: 'event-explorer__badge--purple',
    category: 'System',
    kindLabel: 'System',
    color: 'purple',
    icon: '🖥️',
    description: 'System lifecycle and operational event.',
  },
  debug: {
    label: 'Debug Event',
    badgeClass: 'event-card__badge--default',
    kindBadgeClass: 'event-explorer__badge--default',
    category: 'Debug',
    kindLabel: 'Debug',
    color: 'gray',
    icon: '🔍',
    description: 'Diagnostic or debug trace message.',
  },
};

/**
 * Looks up a catalogued presentation, matching the key case-insensitively.
 * Returns `undefined` when the event type is not part of the known catalog.
 */
function findKnownPresentation(eventType: string): EventTypePresentation | undefined {
  // Exact match first
  if (EVENT_TYPE_PRESENTATIONS[eventType]) {
    return EVENT_TYPE_PRESENTATIONS[eventType];
  }

  // Case-insensitive match check
  const lowerKey = eventType.toLowerCase();
  for (const [key, mapping] of Object.entries(EVENT_TYPE_PRESENTATIONS)) {
    if (key.toLowerCase() === lowerKey) {
      return mapping;
    }
  }

  return undefined;
}

/**
 * Returns true only when the event type has a dedicated presentation mapping.
 *
 * Unknown event types (new contracts, or a listener that is ahead of the
 * dashboard build) resolve to `false` so callers can render an explicit
 * fallback that keeps the raw payload inspectable (issue #612).
 */
export function isKnownEventType(eventType?: string | null): boolean {
  if (!eventType) {
    return false;
  }

  return findKnownPresentation(eventType) !== undefined;
}

/**
 * Returns centralized presentation metadata for any given event type or event name.
 * Uses a safe fallback if the event type is unsupported or missing.
 */
export function getEventTypePresentation(eventType?: string | null): EventTypePresentation {
  if (!eventType) {
    return UNKNOWN_EVENT_TYPE_PRESENTATION;
  }

  const known = findKnownPresentation(eventType);
  if (known) {
    return known;
  }

  // Safe fallback: keep the raw event type as the label so an unknown event
  // remains identifiable while the badge falls back to neutral styling.
  return {
    ...UNKNOWN_EVENT_TYPE_PRESENTATION,
    label: eventType,
  };
}

/**
 * Helper to retrieve event badge class for EventCard / list components.
 */
export function getEventBadgeClass(name?: string | null): string {
  return getEventTypePresentation(name).badgeClass;
}

/**
 * Helper to retrieve kind badge class for EventExplorer components.
 */
export function getEventKindClass(type?: string | null): string {
  return getEventTypePresentation(type).kindBadgeClass;
}

/**
 * Helper to retrieve human readable kind label for EventExplorer components.
 */
export function getEventKindLabel(type?: string | null): string {
  return getEventTypePresentation(type).kindLabel;
}
