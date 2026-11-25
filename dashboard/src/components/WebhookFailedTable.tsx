import { Fragment, memo, useMemo, useState } from 'react';
import type { WebhookDelivery } from '../types/webhook';
import { getErrorCategory } from '../utils/webhookData';
import { formatTimestamp } from '../utils/formatTime';
import { EmptyState } from './EmptyState';

interface WebhookFailedTableProps {
  deliveries: WebhookDelivery[];
  isLoading: boolean;
}

type SortKey = 'eventType' | 'targetUrl' | 'httpStatus' | 'attemptNumber' | 'attemptedAt';
type SortDirection = 'asc' | 'desc';

const PAGE_SIZE = 10;
const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'eventType', label: 'Event type' },
  { key: 'targetUrl', label: 'Endpoint' },
  { key: 'httpStatus', label: 'Response' },
  { key: 'attemptNumber', label: 'Attempt' },
  { key: 'attemptedAt', label: 'Last attempted' },
];

function compareDeliveries(a: WebhookDelivery, b: WebhookDelivery, key: SortKey) {
  const left = a[key];
  const right = b[key];

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return String(left ?? '').localeCompare(String(right ?? ''));
}

function sortLabel(key: SortKey, direction: SortDirection) {
  return `${key} ${direction === 'asc' ? 'ascending' : 'descending'}`;
}

export const WebhookFailedTable = memo(function WebhookFailedTable({
  deliveries,
  isLoading,
}: WebhookFailedTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('attemptedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sortedDeliveries = useMemo(
    () =>
      [...deliveries].sort((a, b) => {
        const comparison = compareDeliveries(a, b, sortKey);
        return sortDirection === 'asc' ? comparison : -comparison;
      }),
    [deliveries, sortDirection, sortKey],
  );

  const pageCount = Math.max(1, Math.ceil(sortedDeliveries.length / PAGE_SIZE));
  const visibleDeliveries = sortedDeliveries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection(key === 'attemptedAt' ? 'desc' : 'asc');
    }
    setPage(1);
  }

  return (
    <section className="webhook-failed-table-section" aria-labelledby="failed-deliveries-title">
      <header className="webhook-failed-table-section__header">
        <h2 className="webhook-failed-table-section__title" id="failed-deliveries-title">
          Failed Deliveries
        </h2>
        <span className="webhook-failed-table-section__count">
          {isLoading ? 'Loading…' : `${deliveries.length.toLocaleString()} failed`}
        </span>
      </header>

      <div className="webhook-failed-table__wrapper">
        <table className="webhook-failed-table">
          <thead>
            <tr>
              {SORT_COLUMNS.map(({ key, label }) => (
                <th
                  key={key}
                  className="webhook-failed-table__th"
                  scope="col"
                  aria-sort={
                    sortKey === key
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className={`webhook-failed-table__sort-btn${sortKey === key ? ' webhook-failed-table__sort-btn--active' : ''}`}
                    onClick={() => toggleSort(key)}
                    aria-label={`Sort by ${label}, ${sortLabel(key, sortKey === key ? sortDirection : 'asc')}`}
                  >
                    {label}
                  </button>
                </th>
              ))}
              <th className="webhook-failed-table__th" scope="col">
                Error
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 4 }, (_, index) => (
                  <tr
                    key={`skeleton-${index}`}
                    className="webhook-failed-table__row webhook-failed-table__row--skeleton"
                    aria-hidden="true"
                  >
                    {SORT_COLUMNS.map(({ key }) => (
                      <td key={key} className="webhook-failed-table__cell">
                        <span className="webhook-failed-table__skeleton" />
                      </td>
                    ))}
                    <td className="webhook-failed-table__cell">
                      <span className="webhook-failed-table__skeleton" />
                    </td>
                  </tr>
                ))
              : visibleDeliveries.map((delivery) => {
                  const category = getErrorCategory(delivery);
                  const isExpanded = expandedId === delivery.id;
                  const codeClass =
                    category === 'network' ? 'network' : category === '4xx' ? '4xx' : '5xx';
                  return (
                    <Fragment key={delivery.id}>
                      <tr
                        key={delivery.id}
                        className={`webhook-failed-table__row${isExpanded ? ' webhook-failed-table__row--expanded' : ''}`}
                      >
                        <td className="webhook-failed-table__cell" data-label="Event type">
                          <span className="webhook-failed-table__event-badge">
                            {delivery.eventType}
                          </span>
                        </td>
                        <td
                          className="webhook-failed-table__cell webhook-failed-table__cell--url"
                          data-label="Endpoint"
                          title={delivery.targetUrl}
                        >
                          {delivery.targetUrl}
                        </td>
                        <td className="webhook-failed-table__cell" data-label="Response">
                          <div className="webhook-failed-table__cell-row">
                            <span
                              className={`webhook-failed-table__code webhook-failed-table__code--${codeClass}`}
                            >
                              {delivery.httpStatus ?? 'Network'}
                            </span>
                            {category && (
                              <span
                                className={`webhook-failed-table__category webhook-failed-table__category--${category}`}
                              >
                                {category}
                              </span>
                            )}
                          </div>
                        </td>
                        <td
                          className="webhook-failed-table__cell webhook-failed-table__cell--mono"
                          data-label="Attempt"
                        >
                          #{delivery.attemptNumber}
                        </td>
                        <td className="webhook-failed-table__cell" data-label="Last attempted">
                          <time dateTime={new Date(delivery.attemptedAt).toISOString()}>
                            {formatTimestamp(delivery.attemptedAt)}
                          </time>
                        </td>
                        <td className="webhook-failed-table__cell" data-label="Error">
                          {delivery.errorPayload ? (
                            <button
                              type="button"
                              className="webhook-failed-table__expand-btn"
                              aria-expanded={isExpanded}
                              onClick={() =>
                                setExpandedId(isExpanded ? null : delivery.id)
                              }
                            >
                              {isExpanded ? 'Hide details' : 'View details'}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                      {isExpanded && delivery.errorPayload && (
                        <tr
                          key={`${delivery.id}-details`}
                          className="webhook-failed-table__detail-row"
                        >
                          <td colSpan={SORT_COLUMNS.length + 1} className="webhook-failed-table__detail-cell">
                            <pre className="webhook-failed-table__error-payload">
                              {delivery.errorPayload}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
            {!isLoading && deliveries.length === 0 && (
              <tr>
                <td colSpan={SORT_COLUMNS.length + 1}>
                  <EmptyState
                    className="webhook-failed-table__empty"
                    size="compact"
                    title="No failed deliveries"
                    description="All webhook attempts in this time range were successful."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!isLoading && pageCount > 1 && (
        <nav className="webhook-failed-table__pagination" aria-label="Failed deliveries pages">
          <span className="webhook-failed-table__pagination-info">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, deliveries.length)} of{' '}
            {deliveries.length}
          </span>
          <div className="webhook-failed-table__pagination-controls">
            <button
              type="button"
              className="webhook-failed-table__page-btn"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="webhook-failed-table__page-indicator">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              className="webhook-failed-table__page-btn"
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              disabled={page === pageCount}
            >
              Next
            </button>
          </div>
        </nav>
      )}
    </section>
  );
});
