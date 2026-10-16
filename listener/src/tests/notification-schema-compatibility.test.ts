/**
 * Notification Schema Compatibility Tests (#702)
 *
 * Verifies that changes to notification payload structures do not unintentionally
 * break supported consumers (Discord, Webhooks, Email, SMS, off-chain indexers).
 *
 * Acceptance Criteria:
 * - Representative payloads across all notification types are tested.
 * - Required fields (targetRecipient, payload, executeAt, notificationType) are validated.
 * - Compatibility failures and schema violations are reported clearly.
 * - Tests run automatically in CI.
 */

import { NotificationType, NotificationStatus, ScheduledNotification } from '../types/scheduled-notification';
import { ensureNotificationVersion, CURRENT_NOTIFICATION_VERSION } from '../utils/notification-version';
import { validatePayloadSize } from '../utils/payload-size-validator';
import { validateNotificationMetadata } from '../utils/metadata-validator';
import { BatchValidator } from '../utils/batch-validator';

describe('Notification Schema Compatibility (#702)', () => {
  describe('Representative Consumer Payloads', () => {
    it('supports Discord webhook notification payload format', () => {
      const discordPayload = {
        version: CURRENT_NOTIFICATION_VERSION,
        content: 'New event detected on contract C123',
        embeds: [
          {
            title: 'AutoShare Group Created',
            description: 'Group 0xabcdef was created by G1234',
            color: 0x5865f2,
            fields: [
              { name: 'Priority', value: 'High', inline: true },
              { name: 'Usage Count', value: '100', inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const versioned = ensureNotificationVersion(discordPayload);
      expect(versioned.version).toBe(CURRENT_NOTIFICATION_VERSION);
      expect(() => validatePayloadSize(versioned)).not.toThrow();
      expect(versioned).toHaveProperty('content');
      expect(versioned).toHaveProperty('embeds');
    });

    it('supports Generic Webhook notification payload format with headers & metadata', () => {
      const webhookPayload = {
        version: CURRENT_NOTIFICATION_VERSION,
        event: 'autoshare.created',
        id: 'evt_998877',
        timestamp: 1724000000,
        data: {
          groupId: '0x11223344',
          creator: 'GDG...XYZ',
          usages: 50,
        },
      };

      const versioned = ensureNotificationVersion(webhookPayload);
      expect(versioned.version).toBe(CURRENT_NOTIFICATION_VERSION);
      expect(() => validatePayloadSize(versioned)).not.toThrow();

      // Test metadata validation
      const metadata = {
        source: 'notify-chain-contract',
        eventType: 'autoshare.created',
        correlationId: 'req_123',
      };
      expect(() => validateNotificationMetadata(metadata)).not.toThrow();
    });

    it('supports Email notification payload format', () => {
      const emailPayload = {
        version: CURRENT_NOTIFICATION_VERSION,
        subject: 'Notification from NotifyChain',
        html: '<p>You received a new notification regarding your balance.</p>',
        text: 'You received a new notification regarding your balance.',
        from: 'no-reply@notifychain.io',
      };

      const versioned = ensureNotificationVersion(emailPayload);
      expect(versioned.version).toBe(CURRENT_NOTIFICATION_VERSION);
      expect(() => validatePayloadSize(versioned)).not.toThrow();
      expect(versioned).toHaveProperty('subject');
      expect(versioned).toHaveProperty('html');
    });

    it('supports SMS notification payload format', () => {
      const smsPayload = {
        version: CURRENT_NOTIFICATION_VERSION,
        body: 'Alert: Contract paused by admin at block 12345.',
      };

      const versioned = ensureNotificationVersion(smsPayload);
      expect(versioned.version).toBe(CURRENT_NOTIFICATION_VERSION);
      expect(() => validatePayloadSize(versioned)).not.toThrow();
      expect(versioned).toHaveProperty('body');
    });
  });

  describe('Backward and Forward Schema Compatibility', () => {
    it('automatically stamps CURRENT_NOTIFICATION_VERSION for legacy unversioned payloads', () => {
      const legacyPayload = {
        message: 'Legacy notification without explicit version field',
        channel: 'discord',
      };

      const upgraded = ensureNotificationVersion(legacyPayload);
      expect(upgraded.version).toBe(CURRENT_NOTIFICATION_VERSION);
      expect(upgraded.message).toBe(legacyPayload.message);
    });

    it('rejects unsupported future version payloads with clear error', () => {
      const futurePayload = {
        version: CURRENT_NOTIFICATION_VERSION + 1,
        message: 'Future notification format',
      };

      expect(() => ensureNotificationVersion(futurePayload)).toThrow(
        `Unsupported notification version ${CURRENT_NOTIFICATION_VERSION + 1}; current is ${CURRENT_NOTIFICATION_VERSION}`
      );
    });

    it('rejects invalid non-integer versions with descriptive message', () => {
      expect(() => ensureNotificationVersion({ version: 'invalid' as any })).toThrow(
        /Unsupported notification version: invalid/
      );
      expect(() => ensureNotificationVersion({ version: -1 })).toThrow(
        /Unsupported notification version/
      );
    });
  });

  describe('Batch Payload Schema Validation Compatibility', () => {
    it('validates batch format compatible with multiple recipient channels', () => {
      const batch = [
        {
          id: 'item_1',
          recipient: 'https://discord.com/api/webhooks/1/2',
          channel: 'discord' as const,
          message: 'Discord message',
        },
        {
          id: 'item_2',
          recipient: 'https://webhook.site/abc',
          channel: 'webhook' as const,
          message: 'Webhook payload',
        },
        {
          id: 'item_3',
          recipient: 'alice@example.com',
          channel: 'email' as const,
          message: 'Email content',
        },
      ];

      const result = BatchValidator.validateBatch(batch);
      expect(result.isValid).toBe(true);
      expect(result.processedCount).toBe(3);
      expect(result.errors).toHaveLength(0);
    });

    it('reports clear error details when required fields are missing in batch payload', () => {
      const invalidBatch = [
        {
          id: 'item_1',
          // missing recipient
          channel: 'discord',
          message: 'Message without recipient',
        },
      ];

      const result = BatchValidator.validateBatch(invalidBatch);
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_FIELD' && e.field === 'recipient')).toBe(true);
    });
  });
});
