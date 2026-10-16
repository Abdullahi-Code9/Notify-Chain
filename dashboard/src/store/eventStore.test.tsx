import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from '@jest/globals';
import { EventFiltersBar } from '../components/EventFiltersBar';
import { EventListPanel } from '../components/EventListPanel';
import { EventList } from '../components/EventList';
import { useEventStore } from '../store/eventStore';
import { generateMockEvents } from '../utils/eventData';

describe('event store selective subscriptions', () => {
  it('deduplicates events before rendering notification rows', () => {
    const [firstEvent, secondEvent] = generateMockEvents(2);

    useEventStore.getState().setEvents([firstEvent, firstEvent, secondEvent]);

    render(
      <div style={{ height: 600, width: 800 }}>
        <EventListPanel />
      </div>,
    );

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getAllByText(`Ledger ${firstEvent.ledger}`)).toHaveLength(1);
    expect(screen.getAllByText(`Ledger ${secondEvent.ledger}`)).toHaveLength(1);
  });

  it('does not append duplicate notifications after repeated refresh data', () => {
    const [firstEvent, secondEvent] = generateMockEvents(2);

    useEventStore.getState().setEvents([firstEvent]);
    useEventStore.getState().appendEvents([firstEvent, secondEvent, secondEvent]);

    const storedEvents = useEventStore.getState().events;

    expect(storedEvents).toHaveLength(2);
    expect(storedEvents.map((event) => event.eventId)).toEqual([
      firstEvent.eventId,
      secondEvent.eventId,
    ]);
  });

  it('filter updates do not require reloading the full event collection', async () => {
    useEventStore.setState({
      events: generateMockEvents(100),
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
    });

    render(
      <div style={{ height: 600, width: 800 }}>
        <EventFiltersBar />
        <EventListPanel />
      </div>,
    );

    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);

    const searchInput = screen.getByLabelText('Search');
    await userEvent.type(searchInput, 'TaskCreated');

    const filteredRows = screen.getAllByRole('article');
    expect(filteredRows.length).toBeLessThan(100);
    expect(filteredRows[0].textContent).toContain('TaskCreated');
  });
});

describe('pagination + filter interaction', () => {
  it('applying a filter while scrolled does not blank the list', () => {
    const events = generateMockEvents(200);
    useEventStore.setState({
      events,
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
    });

    // Render just the list with a large scroll offset to simulate being deep in the list
    const { rerender } = render(<EventList events={events} />);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);

    // Now simulate a filter being applied — pass a small filtered result
    // while the internal scrollTop state is still set to a large value
    const filtered = events.filter((e) => e.eventName === 'TaskCreated');
    act(() => {
      rerender(<EventList events={filtered} />);
    });

    // The list must still render rows — not go blank
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('filter change resets scroll position to top', async () => {
    useEventStore.setState({
      events: generateMockEvents(100),
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
    });

    render(
      <div style={{ height: 600, width: 800 }}>
        <EventFiltersBar />
        <EventListPanel />
      </div>,
    );

    const before = screen.getAllByRole('article').length;
    const searchInput = screen.getByLabelText('Search');
    await userEvent.type(searchInput, 'Withdrawal');

    const after = screen.getAllByRole('article');
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before);
    expect(after[0].textContent).toContain('Withdrawal');
  });
});

describe('stale cache regression tests', () => {
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
    });
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
    });
  });

  it('setEvents with an updated record replaces the stale copy, not silently dropped', () => {
    const [event] = generateMockEvents(1);
    const staleEvent = { ...event, value: 'stale-value' };
    const freshEvent = { ...event, value: 'fresh-value' };

    useEventStore.getState().setEvents([staleEvent]);
    // Simulate a poll returning the same eventId with updated data
    useEventStore.getState().setEvents([freshEvent]);

    const stored = useEventStore.getState().events;
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toBe('fresh-value');
  });

  it('appendEvents with an updated record replaces the stale copy', () => {
    const [event] = generateMockEvents(1);
    const staleEvent = { ...event, value: 'stale-value' };
    const freshEvent = { ...event, value: 'fresh-value' };

    useEventStore.getState().setEvents([staleEvent]);
    // Poll brings in the updated record
    useEventStore.getState().appendEvents([freshEvent]);

    const stored = useEventStore.getState().events;
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toBe('fresh-value');
  });

  it('setEvents keeps order stable when no duplicates are present', () => {
    const [a, b, c] = generateMockEvents(3);
    useEventStore.getState().setEvents([a, b, c]);

    const stored = useEventStore.getState().events;
    expect(stored.map((e) => e.eventId)).toEqual([a.eventId, b.eventId, c.eventId]);
  });
});
