import type { ActivityEvent, ActivityFeedResponse, ActivityType } from '../types/activity';
import { getEventsApiBaseUrl } from '../config/eventsApiUrl';

const BASE_URL = getEventsApiBaseUrl();

export async function fetchActivityFeed(
  page: number = 1,
  pageSize: number = 20,
): Promise<ActivityFeedResponse> {
  const response = await fetch(`${BASE_URL}/api/activity?page=${page}&pageSize=${pageSize}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch activity feed: ${response.status}`);
  }
  return response.json();
}

export async function markActivityAsRead(eventId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/activity/${eventId}/read`, {
    method: 'PUT',
  });
  if (!response.ok) {
    throw new Error(`Failed to mark activity as read: ${response.status}`);
  }
}

// Mock data generator for when API is not available
export function generateMockActivityEvents(count: number = 50): ActivityEvent[] {
  const types: ActivityType[] = [
    'notification_sent',
    'notification_failed',
    'notification_retried',
    'contract_event_received',
    'preference_updated',
    'template_created',
    'template_updated',
    'webhook_received',
  ];

  const messages: Record<ActivityType, string> = {
    notification_sent: 'Notification sent successfully',
    notification_failed: 'Notification delivery failed',
    notification_retried: 'Retrying notification delivery',
    contract_event_received: 'New contract event received',
    preference_updated: 'User preferences updated',
    template_created: 'New notification template created',
    template_updated: 'Notification template updated',
    webhook_received: 'Webhook received and processed',
  };

  const events: ActivityEvent[] = [];

  for (let i = 0; i < count; i++) {
    const type = types[Math.floor(Math.random() * types.length)];
    events.push({
      id: `activity-${Date.now()}-${i}`,
      type,
      timestamp: Date.now() - i * 60000, // 1 minute apart
      metadata: {
        notificationId: type.startsWith('notification_')
          ? Math.floor(Math.random() * 1000)
          : undefined,
        channel: type.startsWith('notification_')
          ? ['discord', 'email', 'slack'][Math.floor(Math.random() * 3)]
          : undefined,
        contractAddress:
          type === 'contract_event_received'
            ? `0x${Math.random().toString(16).substring(2, 42)}`
            : undefined,
        eventName:
          type === 'contract_event_received'
            ? ['Transfer', 'Mint', 'Burn'][Math.floor(Math.random() * 3)]
            : undefined,
        userId:
          type === 'preference_updated' ? `user-${Math.floor(Math.random() * 100)}` : undefined,
        templateId: type.startsWith('template_')
          ? `template-${Math.floor(Math.random() * 50)}`
          : undefined,
        webhookId:
          type === 'webhook_received' ? `webhook-${Math.floor(Math.random() * 20)}` : undefined,
      },
      message: messages[type],
      read: i > 10, // Mark first 10 as unread
    });
  }

  return events;
}
