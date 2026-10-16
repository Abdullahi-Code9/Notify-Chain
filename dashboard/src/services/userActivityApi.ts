import type {
  UserActivityEvent,
  UserActivityTimelineResponse,
  UserActivityAction,
} from '../types/userActivity';
import { getEventsApiBaseUrl } from '../config/eventsApiUrl';

const BASE_URL = getEventsApiBaseUrl();

export async function fetchUserActivityTimeline(
  limit: number = 50,
): Promise<UserActivityTimelineResponse> {
  const response = await fetch(`${BASE_URL}/api/user-activity?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch user activity timeline: ${response.status}`);
  }
  return response.json() as Promise<UserActivityTimelineResponse>;
}

const ACTION_SUMMARIES: Record<UserActivityAction, string> = {
  subscription_created: 'Created a subscription group',
  subscription_updated: 'Updated subscription settings',
  subscription_cancelled: 'Cancelled a subscription',
  notification_preference_changed: 'Changed notification preferences',
  notification_muted: 'Muted a notification category',
  notification_unmuted: 'Unmuted a notification category',
  template_managed: 'Managed a notification template',
  export_requested: 'Requested a notification export',
};

/** Chronological (newest first) mock timeline for offline / empty-API use. */
export function generateMockUserActivity(count: number = 12): UserActivityEvent[] {
  const actions = Object.keys(ACTION_SUMMARIES) as UserActivityAction[];
  const now = Date.now();

  return Array.from({ length: count }, (_, index) => {
    const action = actions[index % actions.length];
    return {
      id: `user-activity-${index + 1}`,
      action,
      timestamp: now - index * 15 * 60 * 1000,
      summary: ACTION_SUMMARIES[action],
      details: `Related to subscriptions and notification management (#${index + 1})`,
      resourceId: `resource-${index + 1}`,
    };
  });
}

export function sortUserActivityChronologically(events: UserActivityEvent[]): UserActivityEvent[] {
  return [...events].sort((a, b) => b.timestamp - a.timestamp);
}
