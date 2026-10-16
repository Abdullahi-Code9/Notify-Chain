import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectEventCount, selectFilters, useEventStore } from '../store/eventStore';
import { filterEvents } from '../utils/eventData';

export function useFilteredEvents() {
  const events = useEventStore((state) => state.events);
  const filters = useEventStore(useShallow(selectFilters));

  return useMemo(
    () =>
      filterEvents(
        events,
        filters.search,
        filters.contractAddress,
        filters.eventType,
        filters.status,
        filters.dateFrom,
        filters.dateTo,
        filters.txHash,
        filters.sortBy ?? 'newest',
      ),
    [events, filters],
  );
}

export function useEventFilters() {
  return useEventStore(useShallow(selectFilters));
}

export function useEventCount() {
  return useEventStore(selectEventCount);
}

export function useFilterOptions() {
  const events = useEventStore((state) => state.events);

  return useMemo(() => {
    const contractOptions = Array.from(new Set(events.map((event) => event.contractAddress)));
    const eventTypeOptions = Array.from(
      new Set(
        events.map((event) => event.eventName).filter((name): name is string => Boolean(name)),
      ),
    );

    return { contractOptions, eventTypeOptions };
  }, [events]);
}

export function useEventLoadingState() {
  return useEventStore(
    useShallow((state) => ({
      isLoading: state.isLoading,
      error: state.error,
    })),
  );
}
