import { memo, useCallback, type KeyboardEvent } from 'react';
import type { BlockchainEvent } from '../types/event';
import type { ContractStatus } from '../services/eventsApi';
import { formatTimestamp, toUtcIsoString } from '../utils/formatTime';
import { useActiveTimeZone } from '../store/timezoneStore';
import { getEventKindClass, getEventKindLabel, isKnownEventType } from '../utils/eventTypeMapping';
import { CopyButton } from './CopyButton';
import type { DashboardColumnId } from '../utils/dashboardPreferences';

function shortenAddress(address: string) {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export interface EventExplorerCardProps {
  event: BlockchainEvent;
  onCopyContract?: (contractAddress: string) => void;
  isCopied?: boolean;
  onSelect?: (event: BlockchainEvent) => void;
  contractStatuses?: ContractStatus[];
  onContractClick?: (contractAddress: string) => void;
  visibleColumns?: DashboardColumnId[];
}

export const EventExplorerCard = memo(function EventExplorerCard({
  event,
  onCopyContract,
  isCopied = false,
  onSelect,
  contractStatuses = [],
  onContractClick,
  visibleColumns = ['contract', 'event', 'kind', 'received', 'ledger', 'transaction'],
}: EventExplorerCardProps) {
  const timeZone = useActiveTimeZone();
  const receivedAtUtc = toUtcIsoString(event.receivedAt);
  const contractStatus = contractStatuses.find(
    (status) => status.address === event.contractAddress,
  );
  const isPaused = contractStatus?.paused ?? false;
  const label = event.eventName ?? event.type;
  const badgeClass = getEventKindClass(event.type);
  const kindLabel = getEventKindLabel(event.type);
  const isUnknown = !isKnownEventType(event.type);
  const isVisible = (column: DashboardColumnId) => visibleColumns.includes(column);
  const receivedDate = new Date(event.receivedAt);
  const receivedDateTime = Number.isNaN(receivedDate.getTime())
    ? undefined
    : receivedDate.toISOString();

  const handleKeyDown = useCallback(
    (keyboardEvent: KeyboardEvent<HTMLElement>) => {
      if (!onSelect) {
        return;
      }
      if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        keyboardEvent.preventDefault();
        onSelect(event);
      }
    },
    [onSelect, event],
  );

  return (
    <article
      className={`event-explorer__row${onSelect ? ' event-card--clickable' : ''}`}
      role={onSelect ? 'button' : 'row'}
      tabIndex={onSelect ? 0 : undefined}
      data-event-id={event.eventId}
      data-event-type-known={isUnknown ? 'false' : 'true'}
      onClick={onSelect ? () => onSelect(event) : undefined}
      onKeyDown={onSelect ? handleKeyDown : undefined}
      aria-label={onSelect ? `View details for ${label} notification` : undefined}
    >
      {isVisible('contract') && (
        <div className="event-explorer__cell" data-label="Contract" role="cell">
          <div className="event-explorer__contract-block">
            <button
              type="button"
              className="event-explorer__contract-link"
              onClick={(e) => {
                e.stopPropagation();
                onContractClick?.(event.contractAddress);
              }}
              title={event.contractAddress}
            >
              {shortenAddress(event.contractAddress)}
            </button>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="event-explorer__copy-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyContract?.(event.contractAddress);
                }}
                aria-label={`Copy contract address ${event.contractAddress}`}
              >
                {isCopied ? 'Copied' : 'Copy'}
              </button>
              {isPaused && (
                <span className="event-explorer__badge event-explorer__badge--paused">Paused</span>
              )}
            </div>
          </div>
        </div>
      )}

      {isVisible('event') && (
        <div className="event-explorer__cell" data-label="Event" role="cell">
          <p className="event-explorer__event-name">{label}</p>
        </div>
      )}

      {isVisible('kind') && (
        <div className="event-explorer__cell" data-label="Kind" role="cell">
          <span
            className={`event-explorer__badge ${badgeClass}`}
            title={isUnknown ? `Unrecognized event kind: ${event.type}` : undefined}
          >
            {kindLabel}
          </span>
        </div>
      )}
      <div className="event-explorer__cell" data-label="Received" role="cell">
        <time dateTime={receivedAtUtc} title={receivedAtUtc ? `UTC: ${receivedAtUtc}` : undefined}>
          {formatTimestamp(event.receivedAt, timeZone)}
        </time>
      </div>

      {isVisible('received') && (
        <div className="event-explorer__cell" data-label="Received" role="cell">
          <time dateTime={receivedDateTime}>{formatTimestamp(event.receivedAt)}</time>
        </div>
      )}

      {isVisible('ledger') && (
        <div className="event-explorer__cell" data-label="Ledger" role="cell">
          <div className="event-explorer__id-cell">
            <span>{event.ledger.toLocaleString()}</span>
            <CopyButton value={event.eventId} label="event ID" size="xs" />
          </div>
        </div>
      )}

      {isVisible('transaction') && (
        <div className="event-explorer__cell" data-label="Transaction" role="cell">
          {event.txHash ? (
            <div className="event-explorer__id-cell">
              <span title={event.txHash}>{shortenAddress(event.txHash)}</span>
              <CopyButton value={event.txHash} label="tx hash" size="xs" />
            </div>
          ) : (
            <span>—</span>
          )}
        </div>
      )}
    </article>
  );
});
