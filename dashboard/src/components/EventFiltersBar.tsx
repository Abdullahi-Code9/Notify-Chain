import { memo } from 'react';
import { useEventStore } from '../store/eventStore';
import { useEventCount, useEventFilters, useFilterOptions } from '../hooks/useEventSelectors';
import { SearchAutocomplete } from './SearchAutocomplete';
import type { NotificationSortOption } from '../types/event';

const SORT_OPTIONS: { value: NotificationSortOption; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'priority', label: 'Priority (on-chain order)' },
  { value: 'delivery_status', label: 'Delivery status' },
];

export const EventFiltersBar = memo(function EventFiltersBar() {
  const filters = useEventFilters();
  const totalCount = useEventCount();
  const { contractOptions, eventTypeOptions } = useFilterOptions();
  const setSearch = useEventStore((state) => state.setSearch);
  const setContractFilter = useEventStore((state) => state.setContractFilter);
  const setEventTypeFilter = useEventStore((state) => state.setEventTypeFilter);
  const setSortBy = useEventStore((state) => state.setSortBy);

  return (
    <section className="event-filters" aria-label="Event filters">
      <div className="event-filters__group">
        <label htmlFor="event-search">Search</label>
        <SearchAutocomplete value={filters.search} onChange={(value) => setSearch(value)} />
      </div>
      <div className="event-filters__group">
        <label htmlFor="contract-filter">Contract</label>
        <select
          id="contract-filter"
          value={filters.contractAddress}
          onChange={(event) => setContractFilter(event.target.value)}
        >
          <option value="all">All contracts</option>
          {contractOptions.map((address) => (
            <option key={address} value={address}>
              {address.slice(0, 8)}...
            </option>
          ))}
        </select>
      </div>
      <div className="event-filters__group">
        <label htmlFor="event-type-filter">Event type</label>
        <select
          id="event-type-filter"
          value={filters.eventType}
          onChange={(event) => setEventTypeFilter(event.target.value)}
        >
          <option value="all">All types</option>
          {eventTypeOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {/* Sort control (#495) */}
      <div className="event-filters__group">
        <label htmlFor="event-sort">Sort by</label>
        <select
          id="event-sort"
          value={filters.sortBy ?? 'newest'}
          onChange={(e) => setSortBy(e.target.value as NotificationSortOption)}
          aria-label="Sort notifications"
        >
          {SORT_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p className="event-filters__count" aria-live="polite" role="status">
        {totalCount.toLocaleString()} events loaded
      </p>{' '}
    </section>
  );
});
