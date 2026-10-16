import { render, screen, fireEvent, act } from '@testing-library/react';
import { NotificationSearchBar } from './NotificationSearchBar';
import { useEventStore } from '../store/eventStore';
import { filterEvents } from '../utils/eventData';

// Reset store between tests
beforeEach(() => {
  useEventStore.setState({
    filters: {
      search: '',
      contractAddress: 'all',
      eventType: 'all',
      status: 'all',
      dateFrom: '',
      dateTo: '',
    },
  });

  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function getStore() {
  return useEventStore.getState();
}

describe('NotificationSearchBar', () => {
  it('renders search input and all status buttons', () => {
    render(<NotificationSearchBar />);

    expect(
      screen.getByLabelText(/search notifications/i),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /^all$/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /^unread$/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /^read$/i }),
    ).toBeInTheDocument();
  });

  it('debounces search input — store not updated immediately', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/search notifications/i),
      {
        target: { value: 'TaskCreated' },
      },
    );

    // Before debounce fires, store should still be empty
    expect(getStore().filters.search).toBe('');
  });

  it('updates store after debounce delay', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/search notifications/i),
      {
        target: { value: 'TaskCreated' },
      },
    );

    act(() => jest.advanceTimersByTime(300));

    expect(getStore().filters.search).toBe('TaskCreated');
  });

  it('sets status filter when status button clicked', () => {
    render(<NotificationSearchBar />);

    fireEvent.click(
      screen.getByRole('button', { name: /^unread$/i }),
    );

    expect(getStore().filters.status).toBe('unread');

    expect(
      screen.getByRole('button', { name: /^unread$/i }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('sets dateFrom and dateTo', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/filter from date/i),
      {
        target: { value: '2026-01-01' },
      },
    );

    fireEvent.change(
      screen.getByLabelText(/filter to date/i),
      {
        target: { value: '2026-01-31' },
      },
    );

    expect(getStore().filters.dateFrom).toBe('2026-01-01');
    expect(getStore().filters.dateTo).toBe('2026-01-31');
  });

  it('shows clear button only when filters are active', () => {
    render(<NotificationSearchBar />);

    expect(
      screen.queryByRole('button', { name: /clear/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /^unread$/i }),
    );

    expect(
      screen.getByRole('button', { name: /clear/i }),
    ).toBeInTheDocument();
  });

  it('clear button resets all filters', () => {
    render(<NotificationSearchBar />);

    fireEvent.click(
      screen.getByRole('button', { name: /^unread$/i }),
    );

    fireEvent.change(
      screen.getByLabelText(/filter from date/i),
      {
        target: { value: '2026-01-01' },
      },
    );

    fireEvent.click(
      screen.getByRole('button', { name: /clear/i }),
    );

    act(() => jest.advanceTimersByTime(300));

    const f = getStore().filters;

    expect(f.status).toBe('all');
    expect(f.dateFrom).toBe('');
    expect(f.search).toBe('');
  });

  it('renders transaction hash input', () => {
    render(<NotificationSearchBar />);

    expect(
      screen.getByLabelText(/filter by transaction hash/i),
    ).toBeInTheDocument();
  });

  it('debounces txHash input — store not updated immediately', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/filter by transaction hash/i),
      {
        target: { value: 'abc123' },
      },
    );

    expect(getStore().filters.txHash).toBe('');
  });

  it('updates store txHash after debounce delay', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/filter by transaction hash/i),
      {
        target: { value: 'abc123' },
      },
    );

    act(() => jest.advanceTimersByTime(300));

    expect(getStore().filters.txHash).toBe('abc123');
  });

  it('shows clear button when txHash is set and clears it', () => {
    render(<NotificationSearchBar />);

    fireEvent.change(
      screen.getByLabelText(/filter by transaction hash/i),
      {
        target: { value: 'deadbeef' },
      },
    );

    expect(
      screen.getByRole('button', { name: /clear/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /clear/i }),
    );

    act(() => jest.advanceTimersByTime(300));

    expect(getStore().filters.txHash).toBe('');
  });
});

describe('filterEvents with new filter fields', () => {
  it('filters by status=unread correctly', () => {
    const events = [
      {
        eventId: '1',
        read: false,
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 1,
        type: 'c',
        topic: [],
        value: '',
      },
      {
        eventId: '2',
        read: true,
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 2,
        type: 'c',
        topic: [],
        value: '',
      },
    ];

    const result = filterEvents(
      events,
      '',
      'all',
      'all',
      'unread',
      '',
      '',
    );

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('1');
  });

  it('filters by txHash — only matching events returned', () => {
    const events = [
      {
        eventId: '1',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 1,
        type: 'c',
        topic: [],
        value: '',
        txHash: 'aabbccdd',
      },
      {
        eventId: '2',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 2,
        type: 'c',
        topic: [],
        value: '',
        txHash: '11223344',
      },
      {
        eventId: '3',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 3,
        type: 'c',
        topic: [],
        value: '',
      },
    ];

    const result = filterEvents(
      events,
      '',
      'all',
      'all',
      'all',
      '',
      '',
      'aabb',
    );

    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('1');
  });

  it('filters by txHash — empty txHash returns all events', () => {
    const events = [
      {
        eventId: '1',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 1,
        type: 'c',
        topic: [],
        value: '',
        txHash: 'aabbccdd',
      },
      {
        eventId: '2',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: Date.now(),
        ledger: 2,
        type: 'c',
        topic: [],
        value: '',
      },
    ];

    const result = filterEvents(
      events,
      '',
      'all',
      'all',
      'all',
      '',
      '',
      '',
    );

    expect(result).toHaveLength(2);
  });

  it('filters by date range', () => {
    const jan1 = Date.parse('2026-01-01T12:00:00Z');
    const jan15 = Date.parse('2026-01-15T12:00:00Z');
    const feb1 = Date.parse('2026-02-01T12:00:00Z');

    const events = [
      {
        eventId: '1',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: jan1,
        ledger: 1,
        type: 'c',
        topic: [],
        value: '',
      },
      {
        eventId: '2',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: jan15,
        ledger: 2,
        type: 'c',
        topic: [],
        value: '',
      },
      {
        eventId: '3',
        contractAddress: 'A',
        eventName: 'X',
        receivedAt: feb1,
        ledger: 3,
        type: 'c',
        topic: [],
        value: '',
      },
    ];

    const result = filterEvents(
      events,
      '',
      'all',
      'all',
      'all',
      '2026-01-01',
      '2026-01-20',
      '',
    );

    expect(
      result.map((e: { eventId: string }) => e.eventId),
    ).toEqual(['2', '1']);
  });
});