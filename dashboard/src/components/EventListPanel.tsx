import { memo } from 'react';
import { useFilteredEvents } from '../hooks/useEventSelectors';
import { EventList } from './EventList';
import { EmptyState } from './EmptyState';

export const EventListPanel = memo(function EventListPanel() {
  const events = useFilteredEvents();

  if (events.length === 0) {
    return (
      <div className="event-panel event-panel--empty">
        <EmptyState
          className="empty-state--compact"
          icon="🔍"
          title="No events match"
          description="No events match the current filters. Try adjusting or clearing your search."
          size="inline"
        />
      </div>
    );
  }

  return (
    <div className="event-panel">
      <EventList events={events} />
    </div>
  );
});