import { memo } from 'react';
import type { BlockchainEvent } from '../types/event';
import { EventRow } from './EventRow';

interface EventListNaiveProps {
  events: BlockchainEvent[];
}

/** Naive list used only for benchmark comparisons — renders every row in the DOM. */
export const EventListNaive = memo(function EventListNaive({ events }: EventListNaiveProps) {
  return (
    <div className="event-list event-list--naive">
      {events.map((event) => (
        <EventRow key={event.eventId} event={event} />
      ))}
    </div>
  );
});
