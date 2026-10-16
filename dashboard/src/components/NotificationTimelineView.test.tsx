import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationTimelineView } from './NotificationTimelineView';
import * as timelineApi from '../services/timelineApi';
import type { NotificationTimeline } from '../types/timeline';

jest.mock('../services/timelineApi');
const mockFetch = timelineApi.fetchTimeline as jest.MockedFunction<
  typeof timelineApi.fetchTimeline
>;

const MOCK_TIMELINE: NotificationTimeline = {
  notificationId: 7,
  status: 'COMPLETED',
  retryCount: 1,
  maxRetries: 3,
  createdAt: '2026-01-01T10:00:00.000Z',
  nextRetryAt: null,
  lastError: null,
  entries: [
    {
      attempt: 1,
      status: 'RETRY',
      executionTime: '2026-01-01T10:00:05.000Z',
      errorMessage: 'network timeout',
      durationMs: 500,
    },
    {
      attempt: 2,
      status: 'COMPLETED',
      executionTime: '2026-01-01T10:00:15.000Z',
      errorMessage: null,
      durationMs: 120,
    },
  ],
};

function renderView() {
  return render(<NotificationTimelineView />);
}

describe('NotificationTimelineView', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders initial empty state with prompt', () => {
    renderView();
    expect(screen.getByText(/enter a notification id/i)).toBeInTheDocument();
  });

  it('shows validation error for invalid id', async () => {
    renderView();
    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '-1' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid notification id/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches and renders timeline entries in chronological order', async () => {
    mockFetch.mockResolvedValue(MOCK_TIMELINE);
    renderView();

    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(7));

    const items = screen.getAllByRole('listitem');
    // entries should be chronological: RETRY first, COMPLETED second
    expect(items[0]).toHaveTextContent(/retrying/i);
    expect(items[1]).toHaveTextContent(/delivered/i);
  });

  it('shows error message from failed entries', async () => {
    mockFetch.mockResolvedValue(MOCK_TIMELINE);
    renderView();
    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(screen.getByText(/network timeout/i)).toBeInTheDocument());
  });

  it('shows empty state when no entries returned', async () => {
    mockFetch.mockResolvedValue({ ...MOCK_TIMELINE, entries: [] });
    renderView();
    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(screen.getByText(/no history entries/i)).toBeInTheDocument());
  });

  it('shows API error message on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Failed to fetch timeline: 404'));
    renderView();
    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '99' } });
    fireEvent.submit(screen.getByRole('search'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/404/);
  });

  it('disables button while loading', async () => {
    let resolve!: (v: NotificationTimeline) => void;
    mockFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderView();
    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '1' } });
    fireEvent.submit(screen.getByRole('search'));

    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled();

    resolve(MOCK_TIMELINE);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /view timeline/i })).not.toBeDisabled(),
    );
  });

  it('renders a copy button for the notification ID in the timeline summary', async () => {
    mockFetch.mockResolvedValue(MOCK_TIMELINE);
    renderView();

    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(7));

    // Verify the copy button for notification ID is rendered
    const copyBtn = screen.getByRole('button', { name: /copy notification id/i });
    expect(copyBtn).toBeInTheDocument();
  });

  it('copies notification ID to clipboard when copy button is clicked in timeline', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });

    mockFetch.mockResolvedValue(MOCK_TIMELINE);
    renderView();

    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(7));

    const copyBtn = screen.getByRole('button', { name: /copy notification id/i });
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('7');
  });

  it('shows copied feedback after clicking the notification ID copy button', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });

    mockFetch.mockResolvedValue(MOCK_TIMELINE);
    renderView();

    fireEvent.change(screen.getByLabelText(/notification id/i), { target: { value: '7' } });
    fireEvent.submit(screen.getByRole('search'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(7));

    const copyBtn = screen.getByRole('button', { name: /copy notification id/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /notification id copied/i })).toBeInTheDocument();
    });
  });
});
