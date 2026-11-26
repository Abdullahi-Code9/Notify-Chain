import { memo } from 'react';
import type { BlockchainEvent } from '../types/event';
import { formatRelativeTimestamp, formatTimestamp, toUtcIsoString } from '../utils/formatTime';
import { formatNumber } from '../utils/formatNumber';
import { useActiveTimeZone } from '../store/timezoneStore';
import { useActiveLocale } from '../store/localeStore';
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
  const timeZone = useActiveTimeZone();
  const locale = useActiveLocale();
  const receivedAtUtc = toUtcIsoString(event.receivedAt);
  const formattedLedger = formatNumber(event.ledger, locale);
  const formattedValue = formatNumber(event.value, locale);

  return (
    <article
      className="event-row"
      data-event-id={event.eventId}
      aria-label={`${label}, ledger ${formattedLedger}`}
    >
      <div className="event-row__primary">
        <span className="event-row__name">{label}</span>
        <span className="event-row__ledger" title={`Ledger ${event.ledger}`}>
          Ledger {formattedLedger}
        </span>
      </div>
      <div className="event-row__meta">
        <span>
          <span className="sr-only">Contract: </span>
          {shortenAddress(event.contractAddress)}
        </span>
        <time
          dateTime={receivedAtUtc}
          title={`${formatTimestamp(event.receivedAt, timeZone, locale)}${receivedAtUtc ? ` (UTC: ${receivedAtUtc})` : ''}`}
        >
          <span className="sr-only">Received: </span>
          {formatRelativeTimestamp(event.receivedAt, Date.now(), timeZone, locale)}
        </time>
        <CopyButton value={event.eventId} label="notification ID" size="xs" />
      </div>
      <div className="event-row__details">
        <span title={`Value: ${event.value}`}>Value: {formattedValue}</span>
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
