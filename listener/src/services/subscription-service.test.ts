import { SubscriptionService, isBlankChannelName } from './subscription-service';
import { SubscribeInput } from '../types/subscription';

describe('SubscriptionService', () => {
  let service: SubscriptionService;

  beforeEach(() => {
    service = new SubscriptionService();
  });

  describe('subscribe', () => {
    it('creates a new subscription successfully', () => {
      const input: SubscribeInput = {
        userId: 'user-1',
        channel: 'discord',
      };

      const result = service.subscribe(input);

      expect(result.success).toBe(true);
      expect(result.subscription).toBeDefined();
      expect(result.subscription?.userId).toBe('user-1');
      expect(result.subscription?.channel).toBe('discord');
      expect(result.subscription?.active).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects duplicate subscriptions to the same channel', () => {
      const input: SubscribeInput = {
        userId: 'user-1',
        channel: 'discord',
      };

      // First subscription succeeds
      const firstResult = service.subscribe(input);
      expect(firstResult.success).toBe(true);
      expect(firstResult.subscription).toBeDefined();

      const originalSubscription = firstResult.subscription;

      // Second subscription to same channel fails
      const duplicateResult = service.subscribe(input);
      expect(duplicateResult.success).toBe(false);
      expect(duplicateResult.error).toBe('DUPLICATE_SUBSCRIPTION');
      expect(duplicateResult.message).toContain('already subscribed');
      expect(duplicateResult.subscription).toEqual(originalSubscription);
    });

    it('allows the same user to subscribe to different channels', () => {
      const discordResult = service.subscribe({
        userId: 'user-1',
        channel: 'discord',
      });

      const emailResult = service.subscribe({
        userId: 'user-1',
        channel: 'email',
      });

      expect(discordResult.success).toBe(true);
      expect(emailResult.success).toBe(true);
      expect(service.getUserSubscriptions('user-1')).toHaveLength(2);
    });

    it('allows different users to subscribe to the same channel', () => {
      const user1Result = service.subscribe({
        userId: 'user-1',
        channel: 'discord',
      });

      const user2Result = service.subscribe({
        userId: 'user-2',
        channel: 'discord',
      });

      expect(user1Result.success).toBe(true);
      expect(user2Result.success).toBe(true);
      expect(service.count()).toBe(2);
    });

    it('validates required input fields', () => {
      const invalidInputs = [
        { userId: '', channel: 'discord' },
        { userId: 'user-1', channel: '' },
        { userId: '', channel: '' },
      ];

      for (const input of invalidInputs) {
        const result = service.subscribe(input);
        expect(result.success).toBe(false);
        expect(result.error).toBe('INVALID_INPUT');
        expect(result.subscription).toBeNull();
      }
    });

    // ── Issue #479: whitespace-only channel names ─────────────────────────
    it('rejects a channel name that is a single space', () => {
      const result = service.subscribe({ userId: 'user-1', channel: ' ' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(result.message).toMatch(/whitespace/i);
      expect(result.subscription).toBeNull();
    });

    it('rejects a channel name consisting entirely of tabs and spaces', () => {
      const result = service.subscribe({ userId: 'user-1', channel: '   \t  ' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(result.subscription).toBeNull();
    });

    it('rejects a channel name that is a newline character', () => {
      const result = service.subscribe({ userId: 'user-1', channel: '\n' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_INPUT');
      expect(result.subscription).toBeNull();
    });

    it('accepts a channel name that contains leading/trailing spaces around a valid word', () => {
      // Trimming is for validation only; we do NOT silently mutate the channel value.
      // A name like "  discord  " still fails because only pure-whitespace is rejected.
      // However " discord " has non-whitespace content, so it is accepted as-is.
      const result = service.subscribe({ userId: 'user-1', channel: ' discord ' });
      expect(result.success).toBe(true);
      expect(result.subscription?.channel).toBe(' discord ');
    });

    it('preserves the original subscription when rejecting duplicates', () => {
      const input: SubscribeInput = {
        userId: 'user-1',
        channel: 'discord',
      };

      // Create initial subscription
      const firstResult = service.subscribe(input);
      const originalId = firstResult.subscription!.id;
      const originalCreatedAt = firstResult.subscription!.createdAt;

      // Wait a bit to ensure timestamps would differ
      const later = Date.now() + 100;
      jest.spyOn(Date, 'now').mockReturnValue(later);

      // Attempt duplicate subscription
      const duplicateResult = service.subscribe(input);

      // Verify the returned subscription is the original, unchanged
      expect(duplicateResult.subscription?.id).toBe(originalId);
      expect(duplicateResult.subscription?.createdAt).toBe(originalCreatedAt);
      expect(duplicateResult.subscription?.createdAt).not.toBe(later);

      jest.restoreAllMocks();
    });
  });

  describe('isSubscribed', () => {
    it('returns true for existing active subscription', () => {
      service.subscribe({ userId: 'user-1', channel: 'discord' });
      expect(service.isSubscribed('user-1', 'discord')).toBe(true);
    });

    it('returns false for non-existent subscription', () => {
      expect(service.isSubscribed('user-1', 'email')).toBe(false);
    });
  });

  describe('getUserSubscriptions', () => {
    it('returns all subscriptions for a user', () => {
      service.subscribe({ userId: 'user-1', channel: 'discord' });
      service.subscribe({ userId: 'user-1', channel: 'email' });
      service.subscribe({ userId: 'user-2', channel: 'discord' });

      const subscriptions = service.getUserSubscriptions('user-1');
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.map((s) => s.channel)).toContain('discord');
      expect(subscriptions.map((s) => s.channel)).toContain('email');
    });

    it('returns empty array for user with no subscriptions', () => {
      const subscriptions = service.getUserSubscriptions('user-999');
      expect(subscriptions).toEqual([]);
    });
  });

  describe('getSubscription', () => {
    it('retrieves specific subscription by user and channel', () => {
      service.subscribe({ userId: 'user-1', channel: 'discord' });

      const subscription = service.getSubscription('user-1', 'discord');
      expect(subscription).toBeDefined();
      expect(subscription?.userId).toBe('user-1');
      expect(subscription?.channel).toBe('discord');
    });

    it('returns null for non-existent subscription', () => {
      const subscription = service.getSubscription('user-1', 'email');
      expect(subscription).toBeNull();
    });
  });

  describe('unsubscribe', () => {
    it('removes an existing subscription', () => {
      service.subscribe({ userId: 'user-1', channel: 'discord' });
      expect(service.isSubscribed('user-1', 'discord')).toBe(true);

      const removed = service.unsubscribe('user-1', 'discord');
      expect(removed).toBe(true);
      expect(service.isSubscribed('user-1', 'discord')).toBe(false);
    });

    it('allows re-subscription after unsubscribing', () => {
      // Initial subscription
      const first = service.subscribe({ userId: 'user-1', channel: 'discord' });
      expect(first.success).toBe(true);

      // Unsubscribe
      service.unsubscribe('user-1', 'discord');

      // Re-subscribe should succeed (not a duplicate since it was removed)
      const second = service.subscribe({ userId: 'user-1', channel: 'discord' });
      expect(second.success).toBe(true);
      expect(second.subscription?.id).not.toBe(first.subscription?.id);
    });

    it('returns false when unsubscribing non-existent subscription', () => {
      const removed = service.unsubscribe('user-1', 'email');
      expect(removed).toBe(false);
    });
  });

  describe('count', () => {
    it('returns correct subscription count', () => {
      expect(service.count()).toBe(0);

      service.subscribe({ userId: 'user-1', channel: 'discord' });
      expect(service.count()).toBe(1);

      service.subscribe({ userId: 'user-1', channel: 'email' });
      expect(service.count()).toBe(2);

      service.unsubscribe('user-1', 'discord');
      expect(service.count()).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all subscriptions', () => {
      service.subscribe({ userId: 'user-1', channel: 'discord' });
      service.subscribe({ userId: 'user-2', channel: 'email' });
      expect(service.count()).toBe(2);

      service.clear();
      expect(service.count()).toBe(0);
      expect(service.getUserSubscriptions('user-1')).toEqual([]);
    });
  });
});

// ── Issue #479: isBlankChannelName helper ─────────────────────────────────
describe('isBlankChannelName', () => {
  it('returns true for an empty string', () => {
    expect(isBlankChannelName('')).toBe(true);
  });

  it('returns true for a string of only spaces', () => {
    expect(isBlankChannelName('   ')).toBe(true);
  });

  it('returns true for a string of only tabs', () => {
    expect(isBlankChannelName('\t\t')).toBe(true);
  });

  it('returns true for mixed whitespace characters', () => {
    expect(isBlankChannelName(' \t\n\r ')).toBe(true);
  });

  it('returns false for a normal channel name', () => {
    expect(isBlankChannelName('discord')).toBe(false);
  });

  it('returns false for a name with surrounding whitespace but real content', () => {
    expect(isBlankChannelName('  email  ')).toBe(false);
  });

  it('returns false for a single non-whitespace character', () => {
    expect(isBlankChannelName('x')).toBe(false);
  });
});
