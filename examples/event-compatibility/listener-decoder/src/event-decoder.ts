/**
 * Event Decoder for Backward-Compatible Schema Evolution
 *
 * Demonstrates how to decode events that may arrive in multiple schema versions
 * within the same event stream. This pattern enables zero-downtime upgrades
 * where the contract emits v2 events while old listeners still expect v1.
 */

export interface NotificationV1 {
  version: 1;
  creator: string;
  notificationId: string;
  message: string;
  // Fields below have default values when missing in v1 events
  priority?: string;
  category?: string;
  retryCount?: number;
}

export interface NotificationV2 {
  version: 2;
  creator: string;
  notificationId: string;
  message: string;
  priority: string;
  category: string;
  retryCount: number;
}

export type Notification = NotificationV1 | NotificationV2;

/**
 * Raw event structure from Stellar RPC getEvents endpoint.
 * Topics are indexed fields; value contains the data payload.
 */
export interface RawEvent {
  type: string;
  contractId: string;
  id: string;
  pagingToken: string;
  ledger: number;
  ledgerClosedAt: string;
  topics: Array<{ _value: string }>;
  value: {
    xdr: string;
  };
}

/**
 * Decoded event structure after XDR parsing.
 */
export interface DecodedEvent {
  eventName: string;
  topics: string[];
  data: {
    payload_version?: number;
    message?: string;
    retry_count?: number;
    category?: string;
    [key: string]: any;
  };
}

/**
 * Decode a notification event with automatic version detection.
 *
 * @param event - Raw event from Stellar RPC
 * @returns Notification object with version-specific fields populated
 *
 * @throws Error if the event structure is invalid or missing required fields
 *
 * @example
 * // v1 event (3 topics, no priority)
 * const notif = decodeNotificationCreated(v1Event);
 * console.log(notif.version); // 1
 * console.log(notif.priority); // undefined (or default if applied)
 *
 * @example
 * // v2 event (4 topics, includes priority)
 * const notif = decodeNotificationCreated(v2Event);
 * console.log(notif.version); // 2
 * console.log(notif.priority); // "high"
 */
export function decodeNotificationCreated(event: DecodedEvent): Notification {
  const { topics, data } = event;

  // Validate minimum required fields (common to both versions)
  if (topics.length < 3) {
    throw new Error(
      `Invalid event structure: expected at least 3 topics, got ${topics.length}`
    );
  }

  if (!data.message) {
    throw new Error('Missing required field: message');
  }

  // Extract common fields
  // topics[0] is the event name (automatically added by Soroban)
  const creator = topics[1];
  const notificationId = topics[2];
  const message = data.message;

  // Detect version from payload or topic count
  const payloadVersion = data.payload_version ?? 1;
  const hasV2Topics = topics.length >= 4;

  // V2 path: if payload declares v2 OR we have 4+ topics
  if (payloadVersion === 2 || hasV2Topics) {
    const priority = topics[3] ?? 'medium'; // Default if somehow missing
    const category = data.category ?? 'general';
    const retryCount = data.retry_count ?? 0;

    return {
      version: 2,
      creator,
      notificationId,
      message,
      priority,
      category,
      retryCount,
    } as NotificationV2;
  }

  // V1 path: minimal fields only
  return {
    version: 1,
    creator,
    notificationId,
    message,
  } as NotificationV1;
}

/**
 * Type guard to check if a notification is v2.
 */
export function isV2Notification(notif: Notification): notif is NotificationV2 {
  return notif.version === 2;
}

/**
 * Normalize a notification to v2 format by filling in defaults for missing fields.
 * Useful when downstream code expects a uniform interface.
 */
export function normalizeToV2(notif: Notification): NotificationV2 {
  if (isV2Notification(notif)) {
    return notif;
  }

  // Upgrade v1 to v2 with sensible defaults
  return {
    version: 2,
    creator: notif.creator,
    notificationId: notif.notificationId,
    message: notif.message,
    priority: 'medium', // Default priority for legacy events
    category: 'general', // Default category
    retryCount: 0, // Assume first attempt for legacy
  };
}

/**
 * Batch decoder for processing event streams with mixed versions.
 *
 * @param events - Array of raw events from getEvents
 * @returns Array of decoded notifications with version info
 *
 * @example
 * const notifications = decodeBatch(rawEvents);
 * const v2Count = notifications.filter(n => n.version === 2).length;
 * console.log(`Processed ${v2Count} v2 events out of ${notifications.length} total`);
 */
export function decodeBatch(events: DecodedEvent[]): Notification[] {
  const results: Notification[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < events.length; i++) {
    try {
      const decoded = decodeNotificationCreated(events[i]);
      results.push(decoded);
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (errors.length > 0) {
    console.warn(`Failed to decode ${errors.length} events:`, errors);
  }

  return results;
}

/**
 * Validation helper: check if an event matches the expected schema version.
 *
 * @param event - Decoded event to validate
 * @param expectedVersion - Version number to check against
 * @returns true if the event matches the expected version
 */
export function validateEventVersion(
  event: DecodedEvent,
  expectedVersion: number
): boolean {
  const version = event.data.payload_version ?? 1;
  return version === expectedVersion;
}

/**
 * Extract event statistics from a batch for monitoring/debugging.
 */
export function getEventStats(events: DecodedEvent[]): {
  total: number;
  v1Count: number;
  v2Count: number;
  unknownCount: number;
} {
  let v1Count = 0;
  let v2Count = 0;
  let unknownCount = 0;

  for (const event of events) {
    const version = event.data.payload_version ?? 1;
    if (version === 1) {
      v1Count++;
    } else if (version === 2) {
      v2Count++;
    } else {
      unknownCount++;
    }
  }

  return {
    total: events.length,
    v1Count,
    v2Count,
    unknownCount,
  };
}
