import { useState, useCallback, memo, useMemo, useEffect, useRef } from 'react';
import type { BlockchainEvent } from '../types/event';
import { EventExplorerCard } from './EventExplorerCard';

const STORAGE_KEY = 'notify-chain-event-table-widths';

export const DEFAULT_COLUMN_WIDTHS = [
  220,
  160,
  110,
  180,
  100,
  160,
] as const;

export const MIN_COLUMN_WIDTH = 80;

const COLUMN_LABELS = [
  'Contract',
  'Event',
  'Kind',
  'Received',
  'Ledger',
  'Transaction',
] as const;

interface EventExplorerTableProps {
  events: BlockchainEvent[];
  onSelectEvent?: (event: BlockchainEvent) => void;
  contractStatuses?: unknown[];
}

export function loadColumnWidths(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return [...DEFAULT_COLUMN_WIDTHS];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (
      !Array.isArray(parsed) ||
      parsed.length !== DEFAULT_COLUMN_WIDTHS.length
    ) {
      return [...DEFAULT_COLUMN_WIDTHS];
    }

    return parsed.map((value, index) => {
      const n = Number(value);

      if (!Number.isFinite(n) || n < MIN_COLUMN_WIDTH) {
        return DEFAULT_COLUMN_WIDTHS[index];
      }

      return n;
    });
  } catch {
    return [...DEFAULT_COLUMN_WIDTHS];
  }
}

export function persistColumnWidths(widths: number[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Ignore storage errors.
  }
}

export function widthsToGridTemplate(widths: number[]) {
  return widths.map((width) => `${width}px`).join(' ');
}

async function syncCopyText(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const fallback = document.createElement('textarea');

  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'absolute';
  fallback.style.left = '-9999px';

  document.body.appendChild(fallback);
  fallback.select();

  const successful = document.execCommand('copy');

  document.body.removeChild(fallback);

  if (!successful) {
    throw new Error('Clipboard copy failed.');
  }
}

export const EventExplorerTable = memo(function EventExplorerTable({
  events,
  onSelectEvent,
}: EventExplorerTableProps) {
  const [columnWidths, setColumnWidths] = useState<number[]>(
    loadColumnWidths,
  );

  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const dragRef = useRef<{
    index: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const startResize = useCallback(
    (index: number, clientX: number) => {
      dragRef.current = {
        index,
        startX: clientX,
        startWidth: columnWidths[index],
      };

      document.body.classList.add('event-explorer--resizing');
    },
    [columnWidths],
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!dragRef.current) {
        return;
      }

      const { index, startX, startWidth } = dragRef.current;
      const difference = event.clientX - startX;

      const newWidth = Math.max(
        MIN_COLUMN_WIDTH,
        startWidth + difference,
      );

      setColumnWidths((current) => {
        const updated = [...current];
        updated[index] = newWidth;
        return updated;
      });
    };

    const handleMouseUp = () => {
      if (!dragRef.current) {
        return;
      }

      dragRef.current = null;
      document.body.classList.remove('event-explorer--resizing');

      setColumnWidths((current) => {
        persistColumnWidths(current);
        return current;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('event-explorer--resizing');
    };
  }, []);

  const handleCopyContract = useCallback(async (address: string) => {
    try {
      await syncCopyText(address);

      setCopiedAddress(address);

      window.setTimeout(() => {
        setCopiedAddress(null);
      }, 1800);
    } catch {
      setCopiedAddress(null);
    }
  }, []);

  const isCopied = useMemo(
    () => (address: string) => copiedAddress === address,
    [copiedAddress],
  );

  const handleSelectEvent = useCallback(
    (event: BlockchainEvent) => {
      onSelectEvent?.(event);
    },
    [onSelectEvent],
  );

  const gridTemplate = widthsToGridTemplate(columnWidths);

  return (
    <section className="event-explorer__table-wrapper">
      <div
        className="event-explorer__table-header"
        role="rowgroup"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {COLUMN_LABELS.map((label, index) => (
          <div
            key={label}
            className="event-explorer__column-header"
            role="columnheader"
          >
            <span>{label}</span>

            {index < COLUMN_LABELS.length - 1 && (
              <button
                type="button"
                className="event-explorer__resize-handle"
                aria-label={`Resize ${label} column`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  startResize(index, event.clientX);
                }}
              />
            )}
          </div>
        ))}
      </div>

      <div
        className="event-explorer__table-body"
        role="rowgroup"
        style={{
          ['--event-explorer-columns' as string]: gridTemplate,
        }}
      >
        {events.map((event) => (
          <EventExplorerCard
            key={event.eventId}
            event={event}
            onCopyContract={handleCopyContract}
            isCopied={isCopied(event.contractAddress)}
            onSelectEvent={handleSelectEvent}
          />
        ))}
      </div>
    </section>
  );
});