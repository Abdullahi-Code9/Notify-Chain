import { fireEvent, render, screen } from '@testing-library/react';
import { DashboardActivityTimeline } from './DashboardActivityTimeline';
import type { BlockchainEvent } from '../types/event';

const EVENTS: BlockchainEvent[] = [
  {
    eventId: 'evt-later',
    contractAddress: 'GCONTRACT',
    eventName: 'NotificationFailed',
    ledger: 12,
    type: 'notification',
    topic: [],
    value: '{}',
    txHash: 'tx-later',
    receivedAt: 2_000,
  },
  {
    eventId: 'evt-earlier',
    contractAddress: 'GCONTRACT',
    eventName: 'NotificationScheduled',
    ledger: 11,
    type: 'notification',
    topic: [],
    value: '{}',
    txHash: 'tx-earlier',
    receivedAt: 1_000,
    notificationStatus: 'active',
  },
];

describe('DashboardActivityTimeline', () => {
  const props = {
    events: EVENTS,
    isLoading: false,
    error: null,
    onRetry: jest.fn(),
    onSelectEvent: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders events in chronological order with accurate statuses and event links', () => {
    render(<DashboardActivityTimeline {...props} />);

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'NotificationScheduled',
      'NotificationFailed',
    ]);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('eventId=evt-earlier'));
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    fireEvent.click(links[0]);
    expect(props.onSelectEvent).toHaveBeenCalledWith(EVENTS[1]);
  });

  it('shows a loading skeleton and a useful empty state', () => {
    const { rerender } = render(<DashboardActivityTimeline {...props} events={[]} isLoading />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    rerender(<DashboardActivityTimeline {...props} events={[]} />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  it('offers retry actions when activity data is unavailable', () => {
    render(<DashboardActivityTimeline {...props} events={[]} error="service unavailable" />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry timeline' }));
    expect(props.onRetry).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Activity data is unavailable/)).toBeInTheDocument();
  });
});
