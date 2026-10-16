import { memo } from 'react';
import type { WebhookDateRange, WebhookFilters } from '../types/webhook';

interface WebhookFiltersBarProps {
  filters: WebhookFilters;
  eventTypeOptions: string[];
  onFiltersChange: (patch: Partial<WebhookFilters>) => void;
  lastRefreshedAt: number | null;
  isMockData: boolean;
  onRefresh: () => void;
  isLoading: boolean;
}

const DATE_RANGE_OPTIONS: { value: WebhookDateRange; label: string }[] = [
  { value: '1h', label: 'Last 1 h' },
  { value: '6h', label: 'Last 6 h' },
  { value: '24h', label: 'Last 24 h' },
  { value: '7d', label: 'Last 7 d' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

const ERROR_CATEGORY_OPTIONS = [
  { value: 'all', label: 'All errors' },
  { value: '4xx', label: '4xx Client' },
  { value: '5xx', label: '5xx Server' },
  { value: 'timeout', label: 'Timeout' },
  { value: 'network', label: 'Network' },
];

export const WebhookFiltersBar = memo(function WebhookFiltersBar({
  filters,
  eventTypeOptions,
  onFiltersChange,
  lastRefreshedAt,
  isMockData,
  onRefresh,
  isLoading,
}: WebhookFiltersBarProps) {
  const refreshedLabel = lastRefreshedAt
    ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`
    : '';

  return (
    <section className="webhook-filters" aria-label="Webhook delivery filters">
      {/* Date range toggle */}
      <div className="webhook-filters__group">
        <span className="webhook-filters__label" id="date-range-label">
          Time range
        </span>
        <div className="webhook-filters__btn-group" role="group" aria-labelledby="date-range-label">
          {DATE_RANGE_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`webhook-filters__range-btn${
                filters.dateRange === value ? ' webhook-filters__range-btn--active' : ''
              }`}
              aria-pressed={filters.dateRange === value}
              onClick={() => onFiltersChange({ dateRange: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Event type */}
      <div className="webhook-filters__group">
        <label htmlFor="wh-event-type" className="webhook-filters__label">
          Event type
        </label>
        <select
          id="wh-event-type"
          className="webhook-filters__select"
          value={filters.eventType}
          onChange={(e) => onFiltersChange({ eventType: e.target.value })}
        >
          <option value="all">All types</option>
          {eventTypeOptions.map((et) => (
            <option key={et} value={et}>
              {et}
            </option>
          ))}
        </select>
      </div>

      {/* Status filter */}
      <div className="webhook-filters__group">
        <label htmlFor="wh-status" className="webhook-filters__label">
          Status
        </label>
        <select
          id="wh-status"
          className="webhook-filters__select"
          value={filters.statusFilter}
          onChange={(e) => onFiltersChange({ statusFilter: e.target.value })}
        >
          {STATUS_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Error category — only meaningful when status is "failed" or "all" */}
      <div className="webhook-filters__group">
        <label htmlFor="wh-error-cat" className="webhook-filters__label">
          Error category
        </label>
        <select
          id="wh-error-cat"
          className="webhook-filters__select"
          value={filters.errorCategory}
          onChange={(e) => onFiltersChange({ errorCategory: e.target.value })}
          disabled={filters.statusFilter === 'success'}
        >
          {ERROR_CATEGORY_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Refresh + last-updated */}
      <div className="webhook-filters__actions">
        {isMockData && (
          <span className="webhook-filters__mock-badge" title="API unavailable — demo data shown">
            Demo
          </span>
        )}
        {refreshedLabel && <span className="webhook-filters__updated">{refreshedLabel}</span>}
        <button
          type="button"
          className="webhook-filters__refresh-btn"
          onClick={onRefresh}
          disabled={isLoading}
          aria-label="Refresh webhook data"
        >
          {isLoading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
    </section>
  );
});
