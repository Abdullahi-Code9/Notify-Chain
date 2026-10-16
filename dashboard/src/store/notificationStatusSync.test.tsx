/**
 * Regression tests for notification status desynchronization between
 * successful blockchain updates and the dashboard caching layer.
 *
 * Bug: After a blockchain transaction changed a notification's status
 * (e.g. NotificationExpired, NotificationRevoked), the Zustand store kept
 * the old status in memory. Users saw outdated statuses after a dashboard
 * refresh because:
 *
 *   1. `setEvents` never stamped `lastFetchedAt`, so every component re-mount
 *      triggered a redundant re-fetch that could still return stale data.
 *   2. There was no `updateEventStatus` action to patch a single cached entry
 *      in-place after a blockchain confirmation.
 *   3. `fetchEvents` did not hydrate `notificationStatus` from `eventName`,
 *      so a hard page refresh always showed `undefined` status even when the
 *      API returned the correct event name.
 *   4. There was no `invalidateEvents` action to force a re-fetch after a
 *      blockchain mutation whose target event id is not known upfront.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { useEventStore } from './eventStore';
import { fetchEvents } from '../services/eventsApi';
import type { BlockchainEvent } from '../types/event';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<BlockchainEvent> = {}): BlockchainEvent {
  return {
    eventId: 'evt-1',
    contractAddress: 'CABC',
    eventName: null,
    ledger: 1000,
    type: 'contract',
    topic: [],
    value: '0',
    receivedAt: Date.now(),
    ...overrides,
  };
}

// Reset Zustand store to a clean baseline before every test.
beforeEach(() => {
  useEventStore.setState({
    events: [],
    filters: {
      search: '',
      contractAddress: 'all',
      eventType: 'all',
      status: 'all',
      dateFrom: '',
      dateTo: '',
    },
    isLoading: false,
    error: null,
    lastFetchedAt: 0,
  });
});

// ---------------------------------------------------------------------------
// 1. updateEventStatus — in-place cache patch after blockchain confirmation
// ---------------------------------------------------------------------------

describe('updateEventStatus', () => {
  it('patches notificationStatus for the matching eventId without replacing the whole list', () => {
    const scheduled = makeEvent({
      eventId: 'notif-1',
      eventName: 'notification_scheduled',
      notificationStatus: 'active',
    });
    const unrelated = makeEvent({ eventId: 'notif-2', eventName: 'autoshare_created' });

    useEventStore.getState().setEvents([scheduled, unrelated]);
    useEventStore.getState().updateEventStatus('notif-1', 'expired');

    const events = useEventStore.getState().events;
    expect(events.find((e) => e.eventId === 'notif-1')?.notificationStatus).toBe('expired');
    // Unrelated event must be untouched.
    expect(events.find((e) => e.eventId === 'notif-2')?.notificationStatus).toBeUndefined();
  });

  it('patches entries matched by relatedNotificationId (status-transition events)', () => {
    // The notification_expired event refers back to the original scheduled event.
    const expiryEvent = makeEvent({
      eventId: 'expiry-evt-1',
      eventName: 'notification_expired',
      relatedNotificationId: 'notif-1',
      notificationStatus: 'active', // stale — should become 'expired'
    });

    useEventStore.getState().setEvents([expiryEvent]);
    useEventStore.getState().updateEventStatus('notif-1', 'expired');

    const patched = useEventStore.getState().events.find((e) => e.eventId === 'expiry-evt-1');
    expect(patched?.notificationStatus).toBe('expired');
  });

  it('does not alter events that share no id with the target', () => {
    const a = makeEvent({ eventId: 'a', notificationStatus: 'active' });
    const b = makeEvent({ eventId: 'b', notificationStatus: 'active' });

    useEventStore.getState().setEvents([a, b]);
    useEventStore.getState().updateEventStatus('a', 'revoked');

    expect(useEventStore.getState().events.find((e) => e.eventId === 'b')?.notificationStatus).toBe(
      'active',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. invalidateEvents + lastFetchedAt — forces re-fetch on next load cycle
// ---------------------------------------------------------------------------

describe('invalidateEvents / lastFetchedAt', () => {
  it('setEvents stamps lastFetchedAt so subsequent mounts skip redundant fetches', () => {
    expect(useEventStore.getState().lastFetchedAt).toBe(0);

    useEventStore.getState().setEvents([makeEvent()]);

    expect(useEventStore.getState().lastFetchedAt).toBeGreaterThan(0);
  });

  it('invalidateEvents resets lastFetchedAt to 0, signalling a re-fetch is required', () => {
    useEventStore.getState().setEvents([makeEvent()]);
    expect(useEventStore.getState().lastFetchedAt).toBeGreaterThan(0);

    useEventStore.getState().invalidateEvents();

    expect(useEventStore.getState().lastFetchedAt).toBe(0);
  });

  it('calling setEvents after invalidateEvents re-stamps lastFetchedAt', () => {
    useEventStore.getState().setEvents([makeEvent()]);
    useEventStore.getState().invalidateEvents();

    useEventStore.getState().setEvents([makeEvent({ eventId: 'evt-refreshed' })]);

    expect(useEventStore.getState().lastFetchedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. hydrateNotificationStatus in fetchEvents — hard-refresh persistence
// ---------------------------------------------------------------------------

describe('fetchEvents hydration', () => {
  it('resolves notificationStatus from eventName on a successful fetch', async () => {
    const payload = {
      events: [
        makeEvent({ eventId: 'n1', eventName: 'notification_scheduled' }),
        makeEvent({ eventId: 'n2', eventName: 'notification_expired' }),
        makeEvent({ eventId: 'n3', eventName: 'notification_revoked' }),
        makeEvent({ eventId: 'n4', eventName: 'autoshare_created' }),
      ],
    };

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      } as Response),
    );

    const events = await fetchEvents('http://test/api/events');

    expect(events.find((e) => e.eventId === 'n1')?.notificationStatus).toBe('active');
    expect(events.find((e) => e.eventId === 'n2')?.notificationStatus).toBe('expired');
    expect(events.find((e) => e.eventId === 'n3')?.notificationStatus).toBe('revoked');
    // Non-notification events must not have a status assigned.
    expect(events.find((e) => e.eventId === 'n4')?.notificationStatus).toBeUndefined();
  });

  it('preserves existing notificationStatus if eventName is null', async () => {
    // Events with no eventName (raw blockchain events) must not have a
    // notificationStatus injected by the hydration step.
    const payload = {
      events: [makeEvent({ eventId: 'raw', eventName: null })],
    };

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      } as Response),
    );

    const events = await fetchEvents('http://test/api/events');
    expect(events[0].notificationStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end desync scenario: status update after initial load
// ---------------------------------------------------------------------------

describe('desynchronization regression', () => {
  it('status change arriving after initial load updates the cached entry, not ignored', () => {
    // Simulate initial load: a notification_scheduled event is cached as active.
    const initial = makeEvent({
      eventId: 'notif-42',
      eventName: 'notification_scheduled',
      notificationStatus: 'active',
    });
    useEventStore.getState().setEvents([initial]);

    // Simulate a successful on-chain expiry transaction confirming. The
    // listener API pushes a notification_expired event; the UI calls
    // updateEventStatus with the original notification id.
    useEventStore.getState().updateEventStatus('notif-42', 'expired');

    const cached = useEventStore.getState().events.find((e) => e.eventId === 'notif-42');
    expect(cached?.notificationStatus).toBe('expired');
  });

  it('hard page refresh restores correct status from API without manual intervention', async () => {
    // After a hard refresh the store is empty (lastFetchedAt = 0).
    // The API returns the latest state — the notification is already expired.
    const payload = {
      events: [
        makeEvent({
          eventId: 'notif-42',
          eventName: 'notification_expired',
        }),
      ],
    };

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      } as Response),
    );

    const events = await fetchEvents('http://test/api/events');
    // hydrateNotificationStatus must resolve 'expired' from 'notification_expired'.
    expect(events[0].notificationStatus).toBe('expired');
  });
});
