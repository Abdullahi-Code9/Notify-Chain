import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { UserActivityTimeline } from './UserActivityTimeline';
import type { UserActivityEvent } from '../types/userActivity';
import { sortUserActivityChronologically } from '../services/userActivityApi';

const mockFetchUserActivityTimeline = jest.fn();
const mockGenerateMockUserActivity = jest.fn();

jest.mock('../services/userActivityApi', () => ({
  fetchUserActivityTimeline: (...args: unknown[]) => mockFetchUserActivityTimeline(...args),
  generateMockUserActivity: (...args: unknown[]) => mockGenerateMockUserActivity(...args),
  sortUserActivityChronologically: jest.requireActual('../services/userActivityApi')
    .sortUserActivityChronologically,
}));

const EVENTS: UserActivityEvent[] = [
  {
    id: 'a1',
    action: 'subscription_created',
    timestamp: 3_000,
    summary: 'Created a subscription group',
    details: 'Team Alpha',
  },
  {
    id: 'a2',
    action: 'notification_preference_changed',
    timestamp: 5_000,
    summary: 'Changed notification preferences',
  },
  {
    id: 'a3',
    action: 'export_requested',
    timestamp: 1_000,
    summary: 'Requested a notification export',
  },
];

describe('UserActivityTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads events and renders them chronologically (newest first)', async () => {
    mockFetchUserActivityTimeline.mockResolvedValue({ events: EVENTS, total: EVENTS.length });

    render(<UserActivityTimeline />);

    expect(await screen.findByText(/Changed notification preferences/i)).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/Changed notification preferences/i);
    expect(items[1]).toHaveTextContent(/Created a subscription group/i);
    expect(items[2]).toHaveTextContent(/Requested a notification export/i);
  });

  it('handles empty state', async () => {
    mockFetchUserActivityTimeline.mockResolvedValue({ events: [], total: 0 });

    render(<UserActivityTimeline />);

    expect(await screen.findByText(/No recent activity yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Subscription and notification actions will appear here/i),
    ).toBeInTheDocument();
  });

  it('falls back to mock data when the API fails', async () => {
    mockFetchUserActivityTimeline.mockRejectedValue(new Error('offline'));
    mockGenerateMockUserActivity.mockReturnValue([
      {
        id: 'mock-1',
        action: 'subscription_updated',
        timestamp: Date.now(),
        summary: 'Updated subscription settings',
      },
    ]);

    render(<UserActivityTimeline />);

    expect(await screen.findByText(/sample data/i)).toBeInTheDocument();
    expect(screen.getByText(/Updated subscription settings/i)).toBeInTheDocument();
  });

  it('refreshes on demand', async () => {
    mockFetchUserActivityTimeline.mockResolvedValue({ events: EVENTS, total: EVENTS.length });
    render(<UserActivityTimeline />);

    await screen.findByText(/Changed notification preferences/i);
    expect(mockFetchUserActivityTimeline).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(mockFetchUserActivityTimeline).toHaveBeenCalledTimes(2);
    });
  });
});

describe('sortUserActivityChronologically', () => {
  it('orders newest events first', () => {
    const sorted = sortUserActivityChronologically(EVENTS);
    expect(sorted.map((e) => e.id)).toEqual(['a2', 'a1', 'a3']);
  });
});
