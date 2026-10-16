import { fireEvent, render, screen } from '@testing-library/react';
import { EventRow } from './EventRow';
import type { BlockchainEvent } from '../types/event';

const mockEvent: BlockchainEvent = {
  eventId: 'notif-42',
  type: 'TaskCreated',
  eventName: 'TaskCreated',
  ledger: 12345,
  contractAddress: 'GABCDEF1234567890ABCDEF1234567890ABCDEF12',
  receivedAt: Date.now(),
  value: '100',
  txHash: 'abcdef1234567890',
  topic: [],
} as BlockchainEvent;

describe('EventRow notification ID copy action', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders a copy button for the notification ID', () => {
    render(<EventRow event={mockEvent} />);

    expect(screen.getByRole('button', { name: /copy notification id/i })).toBeInTheDocument();
  });

  it('copies the notification ID and shows success feedback', async () => {
    render(<EventRow event={mockEvent} />);

    fireEvent.click(screen.getByRole('button', { name: /copy notification id/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('notif-42');
    expect(
      await screen.findByRole('button', { name: /notification id copied/i }),
    ).toBeInTheDocument();
  });

  it('copies the full transaction hash and shows success feedback', async () => {
    render(<EventRow event={mockEvent} />);

    expect(screen.getByTitle(mockEvent.txHash)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /copy transaction hash/i }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockEvent.txHash);
    expect(
      await screen.findByRole('button', { name: /transaction hash copied/i }),
    ).toBeInTheDocument();
  });

  it('handles transaction hash clipboard failures gracefully', async () => {
    navigator.clipboard.writeText = jest.fn().mockRejectedValue(new Error('Denied'));
    render(<EventRow event={mockEvent} />);

    fireEvent.click(screen.getByRole('button', { name: /copy transaction hash/i }));

    expect(
      await screen.findByRole('button', { name: /copy transaction hash/i }),
    ).toBeInTheDocument();
  });
});
