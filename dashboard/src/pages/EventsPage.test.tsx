import '@testing-library/jest-dom';
import { render, screen, waitFor, act } from '@testing-library/react';
import { EventsPage } from './EventsPage';
import { useEventStore } from '../store/eventStore';
import { generateMockEvents } from '../utils/eventData';
import { fetchEvents } from '../services/eventsApi';

jest.mock('../services/eventsApi', () => ({
  fetchEvents: jest.fn(),
}));

jest.mock('../services/wallet', () => ({
  restoreWalletSession: jest.fn(() => Promise.resolve()),
}));

jest.mock('../components/WalletConnectButton', () => ({
  WalletConnectButton: () => <div data-testid="wallet-connect" />,
}));

const mockedFetchEvents = fetchEvents as jest.MockedFunction<typeof fetchEvents>;

describe('EventsPage loading skeletons', () => {
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
    mockedFetchEvents.mockReset();
  });

  it('shows event list skeletons while loading and hides loading text', async () => {
    mockedFetchEvents.mockReturnValue(new Promise(() => {}));

    render(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/loading events/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/loading events\.\.\./i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/loading events/i)).toHaveAttribute('aria-busy', 'true');
  });

  it('replaces skeletons with event content once data is available', async () => {
    const events = generateMockEvents(3);
    let resolveFetch!: (value: typeof events) => void;
    mockedFetchEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/loading events/i)).toBeInTheDocument();
    });

    await act(async () => {
      resolveFetch(events);
    });

    await waitFor(() => {
      expect(screen.queryByLabelText(/loading events/i)).not.toBeInTheDocument();
    });

    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
    expect(screen.queryByText(/no events match/i)).not.toBeInTheDocument();
  });
});
