import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityFeed } from './ActivityFeed';

const mockFetchActivityFeed = jest.fn();

jest.mock('../services/activityApi', () => {
  const actual = jest.requireActual('../services/activityApi');
  return {
    ...actual,
    fetchActivityFeed: (...args: unknown[]) => mockFetchActivityFeed(...args),
  };
});

jest.mock('../hooks/useWalletAccountSync', () => ({
  useWalletAccountSync: jest.fn(),
}));

describe('ActivityFeed loading and retry states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('distinguishes an API failure from empty data and retries the request', async () => {
    mockFetchActivityFeed
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ events: [], total: 0, page: 1, pageSize: 20 });

    render(<ActivityFeed />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /service is unavailable.*sample activity/i,
    );
    expect(screen.getByText(/sample data/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(mockFetchActivityFeed).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });
});
