import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { NotificationSummaryCards } from './NotificationSummaryCards';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';

const sample: NotificationSummaryMetrics = {
  delivered: 1842,
  pending: 217,
  failed: 83,
  total: 2142,
  deliveredRate: 85.9,
};

function getCardNumber(label: string): HTMLElement {
  return screen
    .getByText(label)
    .closest('.notification-summary__card')!
    .querySelector('.notification-summary__card-number')!;
}

describe('NotificationSummaryCards', () => {
  it('renders delivered, pending, and failed counts with locale grouping', () => {
    render(<NotificationSummaryCards summary={sample} isLoading={false} />);

    expect(getCardNumber('Delivered')).toHaveTextContent('1,842');
    expect(getCardNumber('Pending')).toHaveTextContent('217');
    expect(getCardNumber('Failed')).toHaveTextContent('83');
  });

  it('shows the delivered rate as a sub-value of the delivered card', () => {
    render(<NotificationSummaryCards summary={sample} isLoading={false} />);

    expect(getCardNumber('Delivered').closest('.notification-summary__card')).toHaveTextContent(
      'Deliver rate: 85.9%',
    );
  });

  it('applies the correct accent border to each card', () => {
    render(<NotificationSummaryCards summary={sample} isLoading={false} />);

    const deliveredCard = getCardNumber('Delivered').closest('.notification-summary__card');
    const pendingCard = getCardNumber('Pending').closest('.notification-summary__card');
    const failedCard = getCardNumber('Failed').closest('.notification-summary__card');

    expect(deliveredCard).toHaveClass('notification-summary__card--green');
    expect(pendingCard).toHaveClass('notification-summary__card--yellow');
    expect(failedCard).toHaveClass('notification-summary__card--red');
  });

  it('renders a skeleton while loading instead of values', () => {
    render(<NotificationSummaryCards summary={null} isLoading={true} />);

    expect(document.querySelectorAll('.notification-summary__skeleton')).toHaveLength(3);
    expect(screen.queryByText('1,842')).not.toBeInTheDocument();
  });

  it('marks each card as busy while loading', () => {
    render(<NotificationSummaryCards summary={null} isLoading={true} />);
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(3);
  });

  it('updates the displayed counts when the summary prop changes', () => {
    const { rerender } = render(<NotificationSummaryCards summary={sample} isLoading={false} />);

    expect(getCardNumber('Delivered')).toHaveTextContent('1,842');

    const updated: NotificationSummaryMetrics = {
      delivered: 10,
      pending: 3,
      failed: 42,
      total: 55,
      deliveredRate: 18.2,
    };
    rerender(<NotificationSummaryCards summary={updated} isLoading={false} />);

    expect(getCardNumber('Delivered')).toHaveTextContent('10');
    expect(getCardNumber('Pending')).toHaveTextContent('3');
    expect(getCardNumber('Failed')).toHaveTextContent('42');
    expect(getCardNumber('Delivered').closest('.notification-summary__card')).toHaveTextContent(
      'Deliver rate: 18.2%',
    );
  });

  it('renders zeroed counts when no summary is available and not loading', () => {
    render(<NotificationSummaryCards summary={null} isLoading={false} />);

    expect(getCardNumber('Delivered')).toHaveTextContent('0');
    expect(getCardNumber('Pending')).toHaveTextContent('0');
    expect(getCardNumber('Failed')).toHaveTextContent('0');
  });

  it('marks the summary region with an accessible name', () => {
    const { container } = render(<NotificationSummaryCards summary={sample} isLoading={false} />);
    expect(container.querySelector('[aria-label="Notification delivery summary"]')).not.toBeNull();
  });
});
