/**
 * Example: How to schedule notifications
 *
 * This file demonstrates various ways to schedule notifications
 * for future delivery using the NotificationAPI
 */

import { NotificationAPI } from '../services/notification-api';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { initializeDatabase } from '../database/database';
import { NotificationType } from '../types/scheduled-notification';
import logger from '../utils/logger';

async function examples() {
  // Initialize database and API
  const db = await initializeDatabase('./data/notifications.db');
  const repository = new ScheduledNotificationRepository(db);
  const api = new NotificationAPI(repository);

  // ====================================================================
  // Example 1: Schedule a Discord notification for 1 hour from now
  // ====================================================================
  const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);

  const notification1 = await api.scheduleDiscordNotification(
    'https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN',
    {
      content: 'This notification was scheduled 1 hour ago!',
      embeds: [
        {
          title: 'Scheduled Notification',
          description: 'Successfully delivered',
          color: 0x00ff00,
          timestamp: new Date().toISOString(),
        },
      ],
    },
    oneHourLater
  );

  logger.info('Scheduled notification created', { id: notification1 });

  // ====================================================================
  // Example 2: Schedule a high-priority notification for tomorrow 9 AM
  // ====================================================================
  const tomorrow9AM = new Date();
  tomorrow9AM.setDate(tomorrow9AM.getDate() + 1);
  tomorrow9AM.setHours(9, 0, 0, 0);

  const notification2 = await api.scheduleNotification({
    payload: {
      event: {
        id: 'evt_12345',
        contractAddress: 'CXXXXXXX',
        eventName: 'task_completed',
      },
      contractConfig: {
        address: 'CXXXXXXX',
        events: ['task_completed'],
      },
    },
    notificationType: NotificationType.DISCORD,
    targetRecipient: 'https://discord.com/api/webhooks/...',
    executeAt: tomorrow9AM,
    priority: 1, // High priority (1-10, lower = higher)
    maxRetries: 5,
    metadata: {
      source: 'scheduled_task',
      userId: 'user_123',
    },
  });

  logger.info('High-priority notification scheduled', { executeAt: tomorrow9AM });

  // ====================================================================
  // Example 3: Schedule multiple notifications (batch scheduling)
  // ====================================================================
  const scheduleIds: number[] = [];

  for (let i = 1; i <= 5; i++) {
    const executeAt = new Date(Date.now() + i * 15 * 60 * 1000); // Every 15 minutes

    const id = await api.scheduleDiscordNotification(
      'https://discord.com/api/webhooks/...',
      { content: `Reminder ${i} of 5` },
      executeAt,
      { priority: 5 }
    );

    scheduleIds.push(id);
  }

  logger.info('Batch reminder notifications scheduled', { count: scheduleIds.length });

  // ====================================================================
  // Example 4: Cancel a scheduled notification
  // ====================================================================
  const cancelled = await api.cancelNotification(notification1);
  logger.info('Notification cancellation result', { id: notification1, cancelled });

  // ====================================================================
  // Example 5: Check notification status
  // ====================================================================
  const notification = await api.getNotification(notification2);

  if (notification) {
    logger.info('Notification details', {
      id: notification.id,
      status: notification.status,
      executeAt: notification.executeAt,
      retryCount: notification.retryCount,
      createdAt: notification.createdAt,
    });
  }

  // ====================================================================
  // Example 6: Get scheduler statistics
  // ====================================================================
  const stats = await api.getStatistics();
  logger.info('Scheduler statistics', { ...stats });

  // ====================================================================
  // Example 7: Schedule notification based on blockchain event
  // ====================================================================
  async function scheduleEventNotification(event: any, delayMinutes: number) {
    const executeAt = new Date(Date.now() + delayMinutes * 60 * 1000);

    return await api.scheduleNotification({
      payload: {
        event,
        contractConfig: {
          address: event.contractAddress,
          events: ['*'],
        },
      },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://discord.com/api/webhooks/...',
      executeAt,
      eventId: event.id,
      contractAddress: event.contractAddress,
      metadata: {
        source: 'blockchain_event',
        eventType: event.type,
      },
    });
  }

  // Usage:
  const mockEvent = {
    id: 'evt_98765',
    contractAddress: 'CXXXXXXX',
    type: 'contract',
    eventName: 'payment_received',
  };

  const scheduledEventNotification = await scheduleEventNotification(mockEvent, 30);
  logger.info('Event notification scheduled', {
    id: scheduledEventNotification,
    delayMinutes: 30,
  });

  // ====================================================================
  // Example 8: Schedule with custom retry configuration
  // ====================================================================
  const criticalNotification = await api.scheduleNotification({
    payload: { message: 'Critical system alert' },
    notificationType: NotificationType.DISCORD,
    targetRecipient: 'https://discord.com/api/webhooks/...',
    executeAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    maxRetries: 10, // Retry up to 10 times
    priority: 1, // Highest priority
    metadata: {
      severity: 'critical',
      alertType: 'system',
    },
  });

  logger.info('Critical notification scheduled', { id: criticalNotification });

  // Clean up
  await db.close();
}

// Run examples
if (require.main === module) {
  examples()
    .then(() => {
      logger.info('Examples completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Examples failed', { error });
      process.exit(1);
    });
}

export { examples };
