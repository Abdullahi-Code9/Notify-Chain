import { memo } from 'react';
import type { BlockchainEvent } from '../types/event';
import { formatRelativeTimestamp, formatTimestamp, parseToDate } from '../utils/formatTime';
import { CopyButton } from './CopyButton';

interface EventRowProps {
  event: BlockchainEvent;
}

function shortenAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export const EventRow = memo(function EventRow({ event }: EventRowProps) {
  const label = event.eventName ?? event.type;
  const receivedAt = parseToDate(event.receivedAt);

  return (
    <article
      className="event-row"
      data-event-id={event.eventId}
      aria-label={`${label}, ledger ${event.ledger}`}
    >
      <div className="event-row__primary">
        <span className="event-row__name">{label}</span>
        <span className="event-row__ledger">Ledger {event.ledger}</span>
      </div>
      <div className="event-row__meta">
        <span>
          <span className="sr-only">Contract: </span>
          {shortenAddress(event.contractAddress)}
        </span>
        <time dateTime={receivedAt?.toISOString()} title={formatTimestamp(event.receivedAt)}>
          <span className="sr-only">Received: </span>
          {formatRelativeTimestamp(event.receivedAt)}
        </time>
        <CopyButton value={event.eventId} label="notification ID" size="xs" />
      </div>
      <div className="event-row__details">
        <span>Value: {event.value}</span>
        {event.txHash && (
          <span title={event.txHash}>
            <span className="sr-only">Transaction: </span>
            Tx: {shortenAddress(event.txHash)}{' '}
            <CopyButton value={event.txHash} label="transaction hash" size="xs" />
          </span>
        )}
      </div>
    </article>
  );
});
