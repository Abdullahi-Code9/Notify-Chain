import { Subscription, SubscribeInput, SubscribeResult } from '../types/subscription';

/**
 * Returns true when a channel name is blank (empty or whitespace-only).
 *
 * Issue #479: channel names must contain at least one non-whitespace character
 * so that consumers can reliably identify and route to a channel.
 */
export function isBlankChannelName(name: string): boolean {
  return name.trim().length === 0;
}

/**
 * SubscriptionService manages user subscriptions to notification channels.
 * 
 * Core responsibilities:
 * - Prevent duplicate subscriptions (same user + channel)
 * - Track active subscriptions
 * - Provide query interface for subscription state
 * 
 * This service implements duplicate detection at the application layer,
 * ensuring users cannot subscribe twice to the same channel.
 */
export class SubscriptionService {
  private subscriptions = new Map<string, Subscription>();

  /**
   * Generate a unique fingerprint for a subscription.
   * Format: "userId:channel" (e.g., "user-123:discord")
   */
  private getFingerprint(userId: string, channel: string): string {
    return `${userId}:${channel}`;
  }

  /**
   * Generate a unique subscription ID.
   */
  private generateId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Subscribe a user to a notification channel.
   * 
   * Returns existing subscription if already subscribed (idempotent duplicate rejection).
   * 
   * @param input - User ID and channel to subscribe to
   * @returns SubscribeResult with success flag and subscription or error
   */
  subscribe(input: SubscribeInput): SubscribeResult {
    const { userId, channel } = input;

    // Validate input — issue #479: reject blank / whitespace-only channel names
    if (!userId || !channel) {
      return {
        success: false,
        subscription: null,
        error: 'INVALID_INPUT',
        message: 'userId and channel are required',
      };
    }

    if (isBlankChannelName(channel)) {
      return {
        success: false,
        subscription: null,
        error: 'INVALID_INPUT',
        message: 'Channel name must not be empty or whitespace-only',
      };
    }

    const fingerprint = this.getFingerprint(userId, channel);

    // Check for duplicate subscription
    if (this.subscriptions.has(fingerprint)) {
      const existing = this.subscriptions.get(fingerprint)!;
      return {
        success: false,
        subscription: existing,
        error: 'DUPLICATE_SUBSCRIPTION',
        message: `User ${userId} is already subscribed to channel ${channel}`,
      };
    }

    // Create new subscription
    const subscription: Subscription = {
      id: this.generateId(),
      userId,
      channel,
      createdAt: Date.now(),
      active: true,
    };

    this.subscriptions.set(fingerprint, subscription);

    return {
      success: true,
      subscription,
    };
  }

  /**
   * Check if a user is subscribed to a specific channel.
   */
  isSubscribed(userId: string, channel: string): boolean {
    const fingerprint = this.getFingerprint(userId, channel);
    const subscription = this.subscriptions.get(fingerprint);
    return !!subscription && subscription.active;
  }

  /**
   * Get all active subscriptions for a user.
   */
  getUserSubscriptions(userId: string): Subscription[] {
    return Array.from(this.subscriptions.values())
      .filter((sub) => sub.userId === userId && sub.active);
  }

  /**
   * Get a specific subscription by user and channel.
   */
  getSubscription(userId: string, channel: string): Subscription | null {
    const fingerprint = this.getFingerprint(userId, channel);
    return this.subscriptions.get(fingerprint) || null;
  }

  /**
   * Unsubscribe a user from a channel.
   */
  unsubscribe(userId: string, channel: string): boolean {
    const fingerprint = this.getFingerprint(userId, channel);
    return this.subscriptions.delete(fingerprint);
  }

  /**
   * Get total subscription count (for testing/debugging).
   */
  count(): number {
    return this.subscriptions.size;
  }

  /**
   * Clear all subscriptions (for testing).
   */
  clear(): void {
    this.subscriptions.clear();
  }
}
