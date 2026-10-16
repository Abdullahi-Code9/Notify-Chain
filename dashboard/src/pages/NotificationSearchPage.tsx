import { useState, useCallback, useEffect, useRef } from 'react';
import { NotificationSearchSkeleton } from '../components/NotificationSearchSkeleton';
import { formatTimestamp } from '../utils/formatTime';
import { getEventsApiBaseUrl } from '../config/eventsApiUrl';
import { useDebounce } from '../hooks/useDebounce';
import { EmptyState } from '../components/EmptyState';
import { CopyButton } from '../components/CopyButton';
import {
  isListenerApiTimeoutError,
  searchNotifications,
  type NotificationSearchResult,
  type NotificationSearchResponse,
  type NotificationSearchParams,
} from '../services/eventsApi';
import {
  buildNotificationExportBlob,
  downloadBlob,
  type NotificationExportFormat,
} from '../utils/notificationExport';

const PAGE_SIZE = 20;
const EXPORT_PAGE_SIZE = 100;
const API_BASE = getEventsApiBaseUrl();

/** Delivery / processing status values used by scheduled + processed notifications. */
export const NOTIFICATION_DELIVERY_STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'PROCESSED', label: 'Processed' },
];

/** Known notification channel types (listener NotificationType). */
export const NOTIFICATION_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'discord', label: 'Discord' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'sms', label: 'SMS' },
];

export function NotificationSearchPage() {
  const [query, setQuery] = useState('');
  const [sender, setSender] = useState('');
  const [txHash, setTxHash] = useState('');
  const [eventId, setEventId] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<
    'newest' | 'oldest' | 'status'
  >('newest');

  const [response, setResponse] =
    useState<NotificationSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] =
    useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] =
    useState<NotificationExportFormat>('json');
  const [exportMessage, setExportMessage] =
    useState<string | null>(null);

  const debouncedQuery = useDebounce(query, 300);
  const debouncedSender = useDebounce(sender, 300);
  const debouncedTxHash = useDebounce(txHash, 300);
  const debouncedEventId = useDebounce(eventId, 300);

  const hasParams =
    debouncedQuery ||
    debouncedSender ||
    debouncedTxHash ||
    debouncedEventId ||
    status ||
    type ||
    dateFrom ||
    dateTo;

  const abortRef =
    useRef<AbortController | null>(null);

  const currentFilters = useCallback(
    (): NotificationSearchParams => {
      return {
        q: debouncedQuery || undefined,
        sender: debouncedSender || undefined,
        txHash: debouncedTxHash || undefined,
        eventId: debouncedEventId || undefined,
        status: status || undefined,
        type: type || undefined,
        startDate: dateFrom || undefined,
        endDate: dateTo || undefined,
        sortBy,
      };
    },
    [
      debouncedQuery,
      debouncedSender,
      debouncedTxHash,
      debouncedEventId,
      status,
      type,
      dateFrom,
      dateTo,
      sortBy,
    ],
  );

  const runSearch = useCallback(async () => {
    if (!hasParams) {
      setResponse(null);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    abortRef.current =
      new AbortController();

    setLoading(true);
    setError(null);

    try {
      const result = await searchNotifications(
        API_BASE,
        {
          ...currentFilters(),
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        },
      );

      setResponse(result);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.name === 'AbortError'
      ) {
        return;
      }

      setError(
        isListenerApiTimeoutError(err)
          ? 'The notification search timed out. Please try again.'
          : err instanceof Error
            ? err.message
            : 'Search failed',
      );
    } finally {
      setLoading(false);
    }
  }, [
    currentFilters,
    page,
    hasParams,
  ]);

  const filtersKey = `${debouncedQuery}|${debouncedSender}|${debouncedTxHash}|${debouncedEventId}|${status}|${type}|${dateFrom}|${dateTo}|${sortBy}`;

  const prevFiltersRef =
    useRef(filtersKey);

  useEffect(() => {
    if (
      filtersKey !== prevFiltersRef.current
    ) {
      setPage(1);
    }

    prevFiltersRef.current =
      filtersKey;
  }, [filtersKey]);

  useEffect(() => {
    runSearch();
  }, [filtersKey, page, runSearch]);

  function clearAll() {
    setQuery('');
    setSender('');
    setTxHash('');
    setEventId('');
    setStatus('');
    setType('');
    setDateFrom('');
    setDateTo('');
    setSortBy('newest');
    setPage(1);
    setResponse(null);
    setError(null);
    setExportMessage(null);
  }

  async function handleExport() {
    if (!hasParams) {
      setExportMessage(
        'Apply at least one filter before exporting.',
      );
      return;
    }

    setExporting(true);
    setExportMessage(null);

    try {
      const filters = currentFilters();
      const all: NotificationSearchResult[] = [];
      let offset = 0;
      let total = Infinity;

      while (offset < total) {
        const pageResult =
          await searchNotifications(
            API_BASE,
            {
              ...filters,
              limit: EXPORT_PAGE_SIZE,
              offset,
            },
          );

        all.push(...pageResult.results);
        total = pageResult.total;
        offset += pageResult.results.length;

        if (pageResult.results.length === 0) {
          break;
        }
      }

      const { blob, filename } =
        buildNotificationExportBlob(
          all,
          exportFormat,
          filters,
        );

      downloadBlob(blob, filename);

      setExportMessage(
        `Exported ${all.length} notification${
          all.length === 1 ? '' : 's'
        } as ${exportFormat.toUpperCase()}.`,
      );
    } catch (err: unknown) {
      setExportMessage(
        err instanceof Error
          ? err.message
          : 'Export failed',
      );
    } finally {
      setExporting(false);
    }
  }

  const totalPages = response
    ? response.totalPages
    : 0;

  const getVisiblePages = () => {
    if (totalPages <= 1) {
      return [];
    }

    const pages: number[] = [];
    const maxVisible = 5;

    let startPage = Math.max(
      1,
      page - Math.floor(maxVisible / 2),
    );

    let endPage =
      startPage + maxVisible - 1;

    if (endPage > totalPages) {
      endPage = totalPages;
      startPage = Math.max(
        1,
        endPage - maxVisible + 1,
      );
    }

    for (
      let pageNumber = startPage;
      pageNumber <= endPage;
      pageNumber += 1
    ) {
      pages.push(pageNumber);
    }

    return pages;
  };

  const visiblePages =
    getVisiblePages();

  return (
    <main className="notif-search-page">
      <header className="notif-search-page__header">
        <p className="event-explorer__eyebrow">
          Notifications
        </p>

        <h1>Notification Search</h1>

        <p className="event-explorer__lead">
          Filter scheduled and processed
          notifications by type, delivery status,
          date range, sender, or free-text. Export
          respects the filters you apply (JSON or
          CSV).
        </p>
      </header>

      <section
        className="notif-search-form"
        aria-label="Notification search filters"
      >
        <div className="notif-search-form__row">
          <div className="notif-search-form__group notif-search-form__group--wide">
            <label
              htmlFor="nsf-query"
              className="notif-search-form__label"
            >
              Search
            </label>

            <input
              id="nsf-query"
              type="search"
              className="notif-search-form__input"
              placeholder="Sender, event ID, tx hash, type, payload…"
              value={query}
              onChange={(e) =>
                setQuery(e.target.value)
              }
              aria-label="Free-text search"
            />
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-sender"
              className="notif-search-form__label"
            >
              Sender
            </label>

            <input
              id="nsf-sender"
              type="text"
              className="notif-search-form__input"
              placeholder="Target recipient"
              value={sender}
              onChange={(e) =>
                setSender(e.target.value)
              }
            />
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-tx"
              className="notif-search-form__label"
            >
              Tx Hash
            </label>

            <input
              id="nsf-tx"
              type="text"
              className="notif-search-form__input"
              placeholder="Transaction hash"
              value={txHash}
              onChange={(e) =>
                setTxHash(e.target.value)
              }
            />
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-event"
              className="notif-search-form__label"
            >
              Event ID
            </label>

            <input
              id="nsf-event"
              type="text"
              className="notif-search-form__input"
              placeholder="Event identifier"
              value={eventId}
              onChange={(e) =>
                setEventId(e.target.value)
              }
            />
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-status"
              className="notif-search-form__label"
            >
              Delivery status
            </label>

            <select
              id="nsf-status"
              className="notif-search-form__input"
              value={status}
              onChange={(e) =>
                setStatus(e.target.value)
              }
              aria-label="Filter by delivery status"
            >
              {NOTIFICATION_DELIVERY_STATUS_OPTIONS.map(
                ({ value, label }) => (
                  <option
                    key={value || 'all'}
                    value={value}
                  >
                    {label}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-sort"
              className="notif-search-form__label"
            >
              Sort by
            </label>

            <select
              id="nsf-sort"
              className="notif-search-form__input"
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as
                    | 'newest'
                    | 'oldest'
                    | 'status',
                )
              }
              aria-label="Sort notifications"
            >
              <option value="newest">
                Newest first
              </option>
              <option value="oldest">
                Oldest first
              </option>
              <option value="status">
                Delivery status
              </option>
            </select>
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-type"
              className="notif-search-form__label"
            >
              Notification type
            </label>

            <select
              id="nsf-type"
              className="notif-search-form__input"
              value={type}
              onChange={(e) =>
                setType(e.target.value)
              }
              aria-label="Filter by notification type"
            >
              {NOTIFICATION_TYPE_OPTIONS.map(
                ({ value, label }) => (
                  <option
                    key={value || 'all'}
                    value={value}
                  >
                    {label}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-date-from"
              className="notif-search-form__label"
            >
              From
            </label>

            <input
              id="nsf-date-from"
              type="date"
              className="notif-search-form__input notif-search-form__input--date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) =>
                setDateFrom(e.target.value)
              }
              aria-label="Filter from date"
            />
          </div>

          <div className="notif-search-form__group">
            <label
              htmlFor="nsf-date-to"
              className="notif-search-form__label"
            >
              To
            </label>

            <input
              id="nsf-date-to"
              type="date"
              className="notif-search-form__input notif-search-form__input--date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) =>
                setDateTo(e.target.value)
              }
              aria-label="Filter to date"
            />
          </div>
        </div>

        <div
          className="notif-search-form__actions"
          style={{
            display: 'flex',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: '0.75rem',
          }}
        >
          {hasParams && (
            <button
              type="button"
              className="notif-search__clear"
              onClick={clearAll}
              aria-label="Clear all filters"
            >
              Clear filters
            </button>
          )}

          <label
            htmlFor="nsf-export-format"
            className="notif-search-form__label"
            style={{ margin: 0 }}
          >
            Export format
          </label>

          <select
            id="nsf-export-format"
            className="notif-search-form__input"
            value={exportFormat}
            onChange={(e) =>
              setExportFormat(
                e.target
                  .value as NotificationExportFormat,
              )
            }
            aria-label="Export format"
            style={{ width: 'auto' }}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>

          <button
            type="button"
            className="notif-search__export"
            onClick={handleExport}
            disabled={
              exporting || !hasParams
            }
            aria-label="Export filtered notifications"
          >
            {exporting
              ? 'Exporting…'
              : 'Export'}
          </button>
        </div>

        {exportMessage && (
          <p
            className="notif-search-page__export-status"
            role="status"
            style={{ marginTop: '0.5rem' }}
          >
            {exportMessage}
          </p>
        )}
      </section>

      <section
        aria-label="Search results"
        aria-live="polite"
      >
        {loading && (
          <NotificationSearchSkeleton />
        )}

        {error && !loading && (
          <div
            className="event-explorer__error-banner"
            role="alert"
          >
            <strong>Error:</strong> {error}
          </div>
        )}

        {!loading &&
          !error &&
          !hasParams && (
            <EmptyState
              size="compact"
              icon="🔔"
              title="Start searching"
              message="Enter a query above to find notifications by sender, transaction hash, event ID, or type."
            />
          )}

        {!loading &&
          !error &&
          hasParams &&
          response?.results.length === 0 && (
            <EmptyState
              icon="🕵️"
              action={{
                label: 'Clear filters',
                onClick: clearAll,
              }}
            />
          )}

        {!loading &&
          !error &&
          response &&
          response.results.length > 0 && (
            <>
              <p className="event-explorer__summary">
                {response.total.toLocaleString()}{' '}
                result
                {response.total !== 1
                  ? 's'
                  : ''}{' '}
                — showing{' '}
                {(
                  (page - 1) * PAGE_SIZE +
                  1
                ).toLocaleString()}
                –
                {Math.min(
                  page * PAGE_SIZE,
                  response.total,
                ).toLocaleString()}
              </p>

              <div className="notif-search-results">
                {response.results.map((r) => (
                  <NotificationResultCard
                    key={`${r.source}-${r.id}`}
                    result={r}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <nav
                  className="notif-search-page__pagination"
                  aria-label="Pagination"
                >
                  <button
                    type="button"
                    className="pagination__btn"
                    disabled={page === 1}
                    onClick={() =>
                      setPage(1)
                    }
                    aria-label="First page"
                  >
                    «
                  </button>

                  <button
                    type="button"
                    className="pagination__btn"
                    disabled={page === 1}
                    onClick={() =>
                      setPage(
                        (p) => p - 1,
                      )
                    }
                    aria-label="Previous page"
                  >
                    ← Previous
                  </button>

                  <div
                    className="pagination__pages"
                    role="list"
                    aria-label="Page numbers"
                  >
                    {visiblePages.map(
                      (pageNumber) => (
                        <button
                          key={pageNumber}
                          type="button"
                          className="pagination__page-btn"
                          onClick={() =>
                            setPage(
                              pageNumber,
                            )
                          }
                          aria-current={
                            pageNumber ===
                            page
                              ? 'page'
                              : undefined
                          }
                          aria-label={`Page ${pageNumber}`}
                        >
                          {pageNumber}
                        </button>
                      ),
                    )}
                  </div>

                  <button
                    type="button"
                    className="pagination__btn"
                    disabled={
                      page >= totalPages
                    }
                    onClick={() =>
                      setPage(
                        (p) => p + 1,
                      )
                    }
                    aria-label="Next page"
                  >
                    Next →
                  </button>

                  <button
                    type="button"
                    className="pagination__btn"
                    disabled={
                      page >= totalPages
                    }
                    onClick={() =>
                      setPage(totalPages)
                    }
                    aria-label="Last page"
                  >
                    »
                  </button>

                  <span className="pagination__info">
                    Page {page} of{' '}
                    {totalPages}
                  </span>
                </nav>
              )}
            </>
          )}
      </section>
    </main>
  );
}

function NotificationResultCard({
  result,
}: {
  result: NotificationSearchResult;
}) {
  return (
    <article className="notif-result-card">
      <div className="notif-result-card__header">
        <span
          className={`notif-result-card__source notif-result-card__source--${result.source}`}
        >
          {result.source}
        </span>

        <span
          className={`notif-result-card__status notif-result-card__status--${result.status.toLowerCase()}`}
        >
          {result.status}
        </span>

        {result.notificationType && (
          <span className="notif-result-card__type">
            {result.notificationType}
          </span>
        )}
      </div>

      <dl className="notif-result-card__fields">
        <dt>Notification ID</dt>

        <dd>
          <code>{result.id}</code>

          <CopyButton
            value={String(result.id)}
            label="notification ID"
            size="xs"
          />
        </dd>

        {result.eventId && (
          <>
            <dt>Event ID</dt>

            <dd>
              <code>{result.eventId}</code>

              <CopyButton
                value={result.eventId}
                label="event ID"
                size="xs"
              />
            </dd>
          </>
        )}

        {result.txHash && (
          <>
            <dt>Tx Hash</dt>

            <dd>
              <code>{result.txHash}</code>

              <CopyButton
                value={result.txHash}
                label="tx hash"
                size="xs"
              />
            </dd>
          </>
        )}

        {result.contractAddress && (
          <>
            <dt>Contract</dt>

            <dd>
              <code>
                {result.contractAddress}
              </code>

              <CopyButton
                value={
                  result.contractAddress
                }
                label="contract address"
                size="xs"
              />
            </dd>
          </>
        )}

        {result.targetRecipient && (
          <>
            <dt>Recipient</dt>

            <dd>
              {result.targetRecipient}

              <CopyButton
                value={
                  result.targetRecipient
                }
                label="recipient"
                size="xs"
              />
            </dd>
          </>
        )}

        {result.failureReason && (
          <>
            <dt>Failure reason</dt>

            <dd className="notif-result-card__failure-reason">
              {result.failureReason}
            </dd>
          </>
        )}

        <dt>Created</dt>

        <dd>
          {formatTimestamp(
            result.createdAt,
          )}
        </dd>
      </dl>
    </article>
  );
}