import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { EventList } from './EventList';
import type { BlockchainEvent } from '../types/event';

expect.extend(toHaveNoViolations);

function makeEvent(overrides: Partial<BlockchainEvent> = {}): BlockchainEvent {
  return {
    eventId: 'evt-1',
    type: 'TaskCreated',
    eventName: 'TaskCreated',
    ledger: 12345,
    contractAddress: 'GABCDEF1234567890ABCDEF1234567890ABCDEF12',
    receivedAt: Date.now(),
    value: '100',
    txHash: 'abcdef1234567890',
    topic: [],
    ...overrides,
  } as BlockchainEvent;
}

test('EventList has no accessibility violations', async () => {
  const events = [makeEvent({ eventId: '1' }), makeEvent({ eventId: '2' })];
  const { container } = render(<EventList events={events} />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('EventList exposes list semantics', () => {
  const events = [makeEvent({ eventId: '1' }), makeEvent({ eventId: '2' })];
  const { getByRole, getAllByRole } = render(<EventList events={events} />);
  expect(getByRole('list')).toBeInTheDocument();
  expect(getAllByRole('listitem')).toHaveLength(2);
});
