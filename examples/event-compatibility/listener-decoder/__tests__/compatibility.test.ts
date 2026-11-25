/**
 * Compatibility Test Suite
 *
 * Validates that the event decoder handles both v1 and v2 events correctly,
 * ensuring backward compatibility during schema evolution.
 */

import {
  decodeNotificationCreated,
  decodeBatch,
  normalizeToV2,
  isV2Notification,
  validateEventVersion,
  getEventStats,
  type DecodedEvent,
  type NotificationV1,
  type NotificationV2,
} from '../src/event-decoder';

// Import fixtures
import v1Event from '../fixtures/v1-notification-created.json';
import v2Event from '../fixtures/v2-notification-created.json';
import mixedStream from '../fixtures/mixed-stream.json';

describe('Event Compatibility - V1 Events', () => {
  it('should decode v1 event with correct structure', () => {
    const notification = decodeNotificationCreated(v1Event as DecodedEvent);

    expect(notification.version).toBe(1);
    expect(notification.creator).toBe(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
    );
    expect(notification.notificationId).toBe(
      '0101010101010101010101010101010101010101010101010101010101010101'
    );
    expect(notification.message).toBe('Test notification v1 - legacy format');
  });

  it('should handle v1 events without throwing on missing v2 fields', () => {
    expect(() => {
      decodeNotificationCreated(v1Event as DecodedEvent);
    }).not.toThrow();
  });

  it('should mark v1 notification correctly', () => {
    const notification = decodeNotificationCreated(v1Event as DecodedEvent);
    expect(isV2Notification(notification)).toBe(false);
  });

  it('should validate v1 event version correctly', () => {
    expect(validateEventVersion(v1Event as DecodedEvent, 1)).toBe(true);
    expect(validateEventVersion(v1Event as DecodedEvent, 2)).toBe(false);
  });
});

describe('Event Compatibility - V2 Events', () => {
  it('should decode v2 event with all enhanced fields', () => {
    const notification = decodeNotificationCreated(
      v2Event as DecodedEvent
    ) as NotificationV2;

    expect(notification.version).toBe(2);
    expect(notification.creator).toBe(
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC5'
    );
    expect(notification.notificationId).toBe(
      '0202020202020202020202020202020202020202020202020202020202020202'
    );
    expect(notification.message).toBe('Test notification v2 - enhanced format');
    expect(notification.priority).toBe('high');
    expect(notification.category).toBe('alert');
    expect(notification.retryCount).toBe(0);
  });

  it('should extract priority from topic[3] in v2 events', () => {
    const notification = decodeNotificationCreated(
      v2Event as DecodedEvent
    ) as NotificationV2;
    expect(notification.priority).toBe('high');
  });

  it('should mark v2 notification correctly', () => {
    const notification = decodeNotificationCreated(v2Event as DecodedEvent);
    expect(isV2Notification(notification)).toBe(true);
  });

  it('should validate v2 event version correctly', () => {
    expect(validateEventVersion(v2Event as DecodedEvent, 2)).toBe(true);
    expect(validateEventVersion(v2Event as DecodedEvent, 1)).toBe(false);
  });
});

describe('Event Compatibility - Mixed Stream', () => {
  it('should process mixed v1/v2 stream without errors', () => {
    const notifications = decodeBatch(mixedStream as DecodedEvent[]);

    expect(notifications).toHaveLength(5);
    expect(notifications.filter((n) => n.version === 1)).toHaveLength(2);
    expect(notifications.filter((n) => n.version === 2)).toHaveLength(3);
  });

  it('should maintain correct order when processing mixed stream', () => {
    const notifications = decodeBatch(mixedStream as DecodedEvent[]);

    expect(notifications[0].message).toContain('First notification');
    expect(notifications[1].message).toContain('Second notification');
    expect(notifications[2].message).toContain('Third notification');
    expect(notifications[3].message).toContain('Fourth notification');
    expect(notifications[4].message).toContain('Fifth notification');
  });

  it('should correctly identify version distribution in mixed stream', () => {
    const stats = getEventStats(mixedStream as DecodedEvent[]);

    expect(stats.total).toBe(5);
    expect(stats.v1Count).toBe(2);
    expect(stats.v2Count).toBe(3);
    expect(stats.unknownCount).toBe(0);
  });
});

describe('Event Compatibility - Normalization', () => {
  it('should normalize v1 to v2 with default values', () => {
    const v1Notification = decodeNotificationCreated(
      v1Event as DecodedEvent
    ) as NotificationV1;
    const normalized = normalizeToV2(v1Notification);

    expect(normalized.version).toBe(2);
    expect(normalized.priority).toBe('medium'); // Default
    expect(normalized.category).toBe('general'); // Default
    expect(normalized.retryCount).toBe(0); // Default
    expect(normalized.message).toBe(v1Notification.message); // Preserved
  });

  it('should pass through v2 unchanged during normalization', () => {
    const v2Notification = decodeNotificationCreated(
      v2Event as DecodedEvent
    ) as NotificationV2;
    const normalized = normalizeToV2(v2Notification);

    expect(normalized).toEqual(v2Notification);
  });

  it('should allow downstream code to work with uniform v2 interface', () => {
    const v1Notification = decodeNotificationCreated(
      v1Event as DecodedEvent
    ) as NotificationV1;
    const v2Notification = decodeNotificationCreated(
      v2Event as DecodedEvent
    ) as NotificationV2;

    const normalized1 = normalizeToV2(v1Notification);
    const normalized2 = normalizeToV2(v2Notification);

    // Both now have the same shape
    expect(normalized1.priority).toBeDefined();
    expect(normalized2.priority).toBeDefined();
    expect(normalized1.category).toBeDefined();
    expect(normalized2.category).toBeDefined();
  });
});

describe('Event Compatibility - Error Handling', () => {
  it('should throw on missing required topics', () => {
    const invalidEvent = {
      eventName: 'NotifCrtd',
      topics: ['NotifCrtd', 'GAAAA...'], // Only 2 topics, need at least 3
      data: { message: 'Test' },
    };

    expect(() => {
      decodeNotificationCreated(invalidEvent as DecodedEvent);
    }).toThrow('expected at least 3 topics');
  });

  it('should throw on missing required message field', () => {
    const invalidEvent = {
      eventName: 'NotifCrtd',
      topics: ['NotifCrtd', 'GAAAA...', 'notif-123'],
      data: {}, // Missing message
    };

    expect(() => {
      decodeNotificationCreated(invalidEvent as DecodedEvent);
    }).toThrow('Missing required field: message');
  });

  it('should collect errors when batch processing with invalid events', () => {
    const mixedWithError = [
      v1Event,
      {
        eventName: 'NotifCrtd',
        topics: ['NotifCrtd'], // Invalid: too few topics
        data: { message: 'Test' },
      },
      v2Event,
    ];

    // Should not throw, but log warnings
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    const notifications = decodeBatch(mixedWithError as DecodedEvent[]);

    expect(notifications).toHaveLength(2); // Only valid ones
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decode'),
      expect.any(Array)
    );

    consoleSpy.mockRestore();
  });
});

describe('Event Compatibility - Realistic Scenarios', () => {
  it('should handle gradual migration where v2 contract emits v1-compatible events', () => {
    // Simulate a v2 contract that still emits v1-shaped events for legacy consumers
    const v2ContractV1Event = {
      eventName: 'NotifCrtd',
      topics: [
        'NotifCrtd',
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        '0101010101010101010101010101010101010101010101010101010101010101',
      ],
      data: {
        payload_version: 1, // Explicitly marked as v1
        message: 'Legacy consumer compatibility event',
      },
    };

    const notification = decodeNotificationCreated(
      v2ContractV1Event as DecodedEvent
    );
    expect(notification.version).toBe(1);
  });

  it('should handle rollback scenario where v2 listener receives v1 events after downgrade', () => {
    // A listener built for v2 should gracefully handle v1 events
    const notifications = decodeBatch([
      v2Event as DecodedEvent,
      v1Event as DecodedEvent, // Older event appears after upgrade
      v2Event as DecodedEvent,
    ]);

    expect(notifications).toHaveLength(3);
    expect(notifications[0].version).toBe(2);
    expect(notifications[1].version).toBe(1);
    expect(notifications[2].version).toBe(2);
  });

  it('should process events from parallel contract instances with different versions', () => {
    // Two contract instances: one still on v1, another upgraded to v2
    const parallelStream = [
      { ...v1Event, contractId: 'contract-instance-A' },
      { ...v2Event, contractId: 'contract-instance-B' },
      { ...v1Event, contractId: 'contract-instance-A' },
      { ...v2Event, contractId: 'contract-instance-B' },
    ];

    const notifications = decodeBatch(
      parallelStream as unknown as DecodedEvent[]
    );

    expect(notifications).toHaveLength(4);
    const v1Count = notifications.filter((n) => n.version === 1).length;
    const v2Count = notifications.filter((n) => n.version === 2).length;

    expect(v1Count).toBe(2);
    expect(v2Count).toBe(2);
  });
});

describe('Event Compatibility - Performance', () => {
  it('should handle large batches efficiently', () => {
    const largeBatch: DecodedEvent[] = [];
    for (let i = 0; i < 1000; i++) {
      largeBatch.push(
        i % 2 === 0
          ? (v1Event as DecodedEvent)
          : (v2Event as DecodedEvent)
      );
    }

    const start = Date.now();
    const notifications = decodeBatch(largeBatch);
    const duration = Date.now() - start;

    expect(notifications).toHaveLength(1000);
    expect(duration).toBeLessThan(1000); // Should process 1000 events in under 1 second
  });
});
