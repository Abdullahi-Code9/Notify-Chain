import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationSummaryPanel } from './NotificationSummaryPanel';
import type { ScheduleStatsResponse } from '../types/notificationHealth';
import { generateMockNotificationSummary } from '../utils/notificationSummaryData';

function stats(overrides: Partial<ScheduleStatsResponse> = {}): ScheduleStatsResponse {
  return { pending: 0, processing: 0, completed: 0, failed: 0, overdue: 0, ...overrides };
}

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function getCardNumber(label: string): HTMLElement {
  return screen
    .getByText(label)
    .closest('.notification-summary__card')!
    .querySelector('.notification-summary__card-number')!;
}

describe('NotificationSummaryPanel', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('shows a skeleton while the summary is loading', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<NotificationSummaryPanel apiUrl="http://localhost:8787" pollIntervalMs={60_000} />);

    expect(screen.getByText('Updating…')).toBeInTheDocument();
    expect(document.querySelectorAll('.notification-summary__skeleton')).toHaveLength(3);
    expect(screen.queryByText('180')).not.toBeInTheDocument();
  });

  it('renders delivered/pending/failed counts aggregated from schedule stats', async () => {
    // completed=180 -> delivered; pending(40)+processing(10)+overdue(2)=52 pending; failed=5
    fetchMock.mockResolvedValueOnce(
      okJson(stats({ pending: 40, processing: 10, completed: 180, failed: 5, overdue: 2 })),
    );

    render(<NotificationSummaryPanel apiUrl="http://localhost:8787" pollIntervalMs={60_000} />);

    expect(await screen.findByText('180')).toBeInTheDocument(); // delivered
    expect(getCardNumber('Pending')).toHaveTextContent('52');
    expect(getCardNumber('Failed')).toHaveTextContent('5');
    expect(getCardNumber('Delivered').closest('.notification-summary__card')).toHaveTextContent(
      'Deliver rate: 75.9%',
    ); // 180 / 237
  });

  it('falls back to mock data and shows a banner when the API is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    render(<NotificationSummaryPanel apiUrl="http://localhost:8787" pollIntervalMs={60_000} />);

    const mock = generateMockNotificationSummary();
    expect(await screen.findByText('1,842')).toBeInTheDocument(); // mock delivered
    expect(getCardNumber('Pending')).toHaveTextContent(String(mock.pending));
    expect(getCardNumber('Failed')).toHaveTextContent(String(mock.failed));
    expect(
      screen.getByText(/Listener API unavailable — showing sample data\./i),
    ).toBeInTheDocument();
  });

  it('updates the displayed counts when the user clicks refresh', async () => {
    fetchMock.mockResolvedValueOnce(okJson(stats({ completed: 180 })));
    fetchMock.mockResolvedValueOnce(okJson(stats({ completed: 999 })));

    render(<NotificationSummaryPanel apiUrl="http://localhost:8787" pollIntervalMs={60_000} />);

    expect(await screen.findByText('180')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByText('999')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches on the polling interval and updates the cards', async () => {
    fetchMock.mockResolvedValueOnce(okJson(stats({ completed: 180 })));
    fetchMock.mockResolvedValue(okJson(stats({ completed: 9999 })));

    render(<NotificationSummaryPanel apiUrl="http://localhost:8787" pollIntervalMs={150} />);

    expect(await screen.findByText('180')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('9,999')).toBeInTheDocument();
  });
});
