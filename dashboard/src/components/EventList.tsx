import { memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { BlockchainEvent } from '../types/event';
import { EventRow } from './EventRow';

const ROW_HEIGHT = 88;
const OVERSCAN = 8;

interface EventListProps {
  events: BlockchainEvent[];
}

export const EventList = memo(function EventList({ events }: EventListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    setScrollTop(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [events]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const onContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) {
      setViewportHeight(node.clientHeight || 600);
    }
  }, []);

  const windowState = useMemo(() => {
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN;
    const maxScrollTop = Math.max(0, events.length * ROW_HEIGHT - viewportHeight);
    const clampedScrollTop = Math.min(scrollTop, maxScrollTop);
    const startIndex = Math.max(0, Math.floor(clampedScrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIndex = Math.min(events.length, startIndex + visibleCount + OVERSCAN);

    return {
      startIndex,
      endIndex,
      totalHeight: events.length * ROW_HEIGHT,
    };
  }, [events, scrollTop, viewportHeight]);

  const visibleEvents = events.slice(windowState.startIndex, windowState.endIndex);

  return (
    <div
      ref={onContainerRef}
      className="event-list event-list--virtualized"
      onScroll={onScroll}
      role="list"
      aria-label={`Blockchain events, ${events.length.toLocaleString()} total`}
      tabIndex={0}
    >
      <div className="event-list__viewport" style={{ height: `${windowState.totalHeight}px` }}>
        {visibleEvents.map((event, index) => {
          const position = windowState.startIndex + index;
          return (
            <div
              key={event.eventId}
              className="event-list__item"
              role="listitem"
              aria-setsize={events.length}
              aria-posinset={position + 1}
              style={{
                transform: `translateY(${position * ROW_HEIGHT}px)`,
                height: `${ROW_HEIGHT}px`,
              }}
            >
              <EventRow event={event} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
