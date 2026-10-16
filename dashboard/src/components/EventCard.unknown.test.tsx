import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { EventCard } from './EventCard';
import type { BlockchainEvent } from '../types/event';

const UNKNOWN_TYPE = 'FutureContractEvent';

function unknownEvent(overrides: Partial<BlockchainEvent> = {}): BlockchainEvent {
  return {
    eventId: 'evt-unknown-1',
    contractAddress: 'GABCDEF1234567890ABCDEF1234567890ABCDEF12',
    eventName: UNKNOWN_TYPE,
    ledger: 12345,
    type: UNKNOWN_TYPE,
    topic: [UNKNOWN_TYPE],
    value: '{"weird_field":42}',
    receivedAt: Date.now(),
    ...overrides,
  } as BlockchainEvent;
}

describe('EventCard unknown event type fallback (issue #612)', () => {
  it('renders an unknown event with the neutral fallback badge instead of throwing', () => {
    const { container } = render(<EventCard event={unknownEvent()} />);

    const card = container.querySelector('.event-card--compact');
    expect(card).toBeTruthy();
    expect(card!.getAttribute('data-event-type-known')).toBe('false');
    expect(container.querySelector('.event-card__badge--default')).toBeTruthy();
  });

  it('stays inspectable when the payload is not a plain string', () => {
    const event = unknownEvent({
      value: { weird_field: 42 } as unknown as string,
      topic: undefined as unknown as string[],
    });

    expect(() => render(<EventCard event={event} variant="expanded" />)).not.toThrow();
    expect(screen.getByText(/Unrecognized event type/i)).toBeInTheDocument();
    expect(document.querySelector('.event-card__payload')).toHaveTextContent(/weird_field/);
  });

  it('keeps known events on their mapped presentation', () => {
    const { container } = render(
      <EventCard event={unknownEvent({ eventName: 'TaskCreated', type: 'contract' })} />,
    );

    const card = container.querySelector('.event-card--compact');
    expect(card!.getAttribute('data-event-type-known')).toBe('true');
    expect(container.querySelector('.event-card__badge--green')).toBeTruthy();
  });
});
