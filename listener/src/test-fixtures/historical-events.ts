/**
 * Historical Event Fixtures
 * 
 * Representative event payloads from different schema versions for compatibility testing.
 * These fixtures ensure that changes to event structures do not unintentionally break
 * listener decoders or external consumers.
 * 
 * Each fixture represents a real event shape that external consumers depend on.
 * Tests validate that current decoders can still parse these historical formats.
 */

/**
 * Schema version 1 event fixtures
 * Initial versioned notification payloads (2026-07-26)
 */
export const HISTORICAL_EVENTS_V1 = {
  /**
   * NotificationScheduled event - initial version
   * Topics: [creator, category, priority]
   * Data: { notification_id, payload_version }
   */
  notificationScheduled: {
    version: 1,
    eventName: 'NotificationScheduled',
    topics: [
      'creator_address_GABC123',  // creator Address
      '3',  // Notification category (u32)
      '1',  // Medium priority (u32)
    ],
    data: {
      notification_id: 'aabbccdd00112233445566778899aabbccddee ff00112233445566',  // BytesN<32>
      payload_version: 1,
    },
    description: 'Initial notification scheduling event with version 1 payload',
  },

  /**
   * AutoshareCreated event - initial version
   * Topics: [creator, category, priority]
   * Data: { id }
   */
  autoshareCreated: {
    version: 1,
    eventName: 'AutoshareCreated',
    topics: [
      'creator_address_GABC456',  // creator Address
      '0',  // Group category (u32)
      '0',  // Low priority (u32)
    ],
    data: {
      id: '1122334455667788990011223344556677889900112233445566778899001122',  // BytesN<32>
    },
    description: 'Group creation event with category and priority topics',
  },

  /**
   * NotificationExpired event - initial version
   * Topics: [notification_id, category, priority]
   * Data: { } (single-value format)
   */
  notificationExpired: {
    version: 1,
    eventName: 'NotificationExpired',
    topics: [
      'notif_id_aabbccdd00112233445566778899aabbccddee',  // notification_id BytesN<32>
      '3',  // Notification category (u32)
      '1',  // Medium priority (u32)
    ],
    data: {},
    description: 'Notification expiration event (single-value format)',
  },

  /**
   * NotificationRevoked event - initial version with revocation support
   * Topics: [notification_id, category, priority]
   * Data: { revoker, revoked_at, reason }
   */
  notificationRevoked: {
    version: 1,
    eventName: 'NotificationRevoked',
    topics: [
      'notif_id_xyz123',
      '3',  // Notification category
      '2',  // High priority
    ],
    data: {
      revoker: 'revoker_address_GXYZ789',
      revoked_at: 1722000000,  // u64 timestamp
      reason: 'User requested cancellation',
    },
    description: 'Notification revocation event with reason field',
  },

  /**
   * BatchNotificationsCreated event
   * Topics: [creator, category, priority]
   * Data: { count, ids }
   */
  batchNotificationsCreated: {
    version: 1,
    eventName: 'BatchNotificationsCreated',
    topics: [
      'creator_address_GBATCH1',
      '3',  // Notification category
      '1',  // Medium priority
    ],
    data: {
      count: 3,
      ids: [
        'batch_id_1_aabbccdd',
        'batch_id_2_eeff0011',
        'batch_id_3_22334455',
      ],
    },
    description: 'Batch notification creation event with multiple IDs',
  },
};

/**
 * Placeholder for future schema versions
 * As the schema evolves, add new version sections here with appropriate fixtures
 */
export const HISTORICAL_EVENTS_V2 = {
  // Future: Add v2 fixtures when schema changes occur
};

/**
 * All historical event fixtures organized by version
 */
export const ALL_HISTORICAL_EVENTS = {
  v1: HISTORICAL_EVENTS_V1,
  v2: HISTORICAL_EVENTS_V2,
};

/**
 * Critical events that must maintain backward compatibility
 * These are high-priority events that external consumers depend on
 */
export const CRITICAL_EVENTS = [
  'NotificationScheduled',
  'NotificationRevoked',
  'NotificationExpired',
  'AutoshareCreated',
  'BatchNotificationsCreated',
];
