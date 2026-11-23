import React, { useCallback, useEffect, useMemo, useState } from 'react';

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  resource: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

interface AuditHistoryPageProps {
  records?: AuditRecord[];
  loading?: boolean;
  error?: string | null;
  pageSize?: number;
  isAuthorized?: boolean;
  onFetchRecords?: () => Promise<AuditRecord[]>;
}

const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|apikey|credential|authorization|auth|private[_-]?key|ssn|credit[_-]?card|card[_-]?number|cvv)/i;

export function maskSensitiveValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '••••••••';
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item, index) => maskSensitiveValue(String(index), item));
    }
    const masked: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      masked[childKey] = maskSensitiveValue(childKey, childValue);
    }
    return masked;
  }
  return value;
}

export function maskRecordDetails(details?: Record<string, unknown>): Record<string, unknown> {
  if (!details) {
    return {};
  }
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    masked[key] = maskSensitiveValue(key, value);
  }
  return masked;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString();
}

const AuditHistoryPage: React.FC<AuditHistoryPageProps> = ({
  records: initialRecords,
  loading: initialLoading = false,
  error: initialError = null,
  pageSize = 10,
  isAuthorized = true,
  onFetchRecords,
}) => {
  const [records, setRecords] = useState<AuditRecord[]>(initialRecords ?? []);
  const [loading, setLoading] = useState<boolean>(initialLoading);
  const [error, setError] = useState<string | null>(initialError);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [selectedRecord, setSelectedRecord] = useState<AuditRecord | null>(null);

  const loadRecords = useCallback(async () => {
    if (!onFetchRecords) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fetched = await onFetchRecords();
      setRecords(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit records.');
    } finally {
      setLoading(false);
    }
  }, [onFetchRecords]);

  useEffect(() => {
    if (onFetchRecords) {
      void loadRecords();
    }
  }, [onFetchRecords, loadRecords]);

  const actionOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const record of records) {
      if (record.action) {
        unique.add(record.action);
      }
    }
    return Array.from(unique).sort();
  }, [records]);

  const filteredRecords = useMemo(() => {
    const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
    const end = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : null;

    return records
      .filter((record) => {
        if (actionFilter && record.action !== actionFilter) {
          return false;
        }
        const time = new Date(record.timestamp).getTime();
        if (Number.isNaN(time)) {
          return false;
        }
        if (start !== null && time < start) {
          return false;
        }
        if (end !== null && time > end) {
          return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [records, actionFilter, startDate, endDate]);

  useEffect(() => {
    setCurrentPage(1);
  }, [actionFilter, startDate, endDate]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedRecords = useMemo(() => {
    const startIndex = (safePage - 1) * pageSize;
    return filteredRecords.slice(startIndex, startIndex + pageSize);
  }, [filteredRecords, safePage, pageSize]);

  const handleResetFilters = () => {
    setActionFilter('');
    setStartDate('');
    setEndDate('');
  };

  const handleCloseModal = () => {
    setSelectedRecord(null);
  };

  if (!isAuthorized) {
    return (
      <div className="audit-history-page audit-history-page--forbidden" role="alert">
        <h1>Access Denied</h1>
        <p>You do not have permission to view administrative audit history.</p>
      </div>
    );
  }

  return (
    <div className="audit-history-page">
      <header className="audit-history-page__header">
        <h1>Audit History</h1>
        <p className="audit-history-page__subtitle">
          Review recorded administrative activities and configuration changes.
        </p>
      </header>

      <section className="audit-history-page__filters" aria-label="Audit filters">
        <div className="audit-history-page__filter">
          <label htmlFor="audit-action-filter">Action type</label>
          <select
            id="audit-action-filter"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">All actions</option>
            {actionOptions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="audit-history-page__filter">
          <label htmlFor="audit-start-date">From date</label>
          <input
            id="audit-start-date"
            type="date"
            value={startDate}
            max={endDate || undefined}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <div className="audit-history-page__filter">
          <label htmlFor="audit-end-date">To date</label>
          <input
            id="audit-end-date"
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>

        <button type="button" onClick={handleResetFilters}>
          Reset filters
        </button>
      </section>

      {error && (
        <div className="audit-history-page__error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="audit-history-page__loading" role="status">
          Loading audit records…
        </div>
      ) : filteredRecords.length === 0 ? (
        <div className="audit-history-page__empty" role="status">
          <p>No audit records found.</p>
          {(actionFilter || startDate || endDate) && (
            <p>Try adjusting or resetting your filters.</p>
          )}
        </div>
      ) : (
        <>
          <table className="audit-history-page__table">
            <thead>
              <tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Resource</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRecords.map((record) => (
                <tr key={record.id}>
                  <td>{formatTimestamp(record.timestamp)}</td>
                  <td>{record.actor}</td>
                  <td>{record.action}</td>
                  <td>{record.resource}</td>
                  <td>
                    <button type="button" onClick={() => setSelectedRecord(record)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <nav className="audit-history-page__pagination" aria-label="Audit history pagination">
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
            >
              Previous
            </button>
            <span>
              Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
            >
              Next
            </button>
          </nav>
        </>
      )}

      {selectedRecord && (
        <div
          className="audit-history-page__modal-overlay"
          role="presentation"
          onClick={handleCloseModal}
        >
          <div
            className="audit-history-page__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="audit-history-page__modal-header">
              <h2 id="audit-detail-title">Audit Record Details</h2>
              <button type="button" aria-label="Close" onClick={handleCloseModal}>
                ×
              </button>
            </header>

            <dl className="audit-history-page__detail-list">
              <dt>Record ID</dt>
              <dd>{selectedRecord.id}</dd>
              <dt>Timestamp</dt>
              <dd>{formatTimestamp(selectedRecord.timestamp)}</dd>
              <dt>Actor</dt>
              <dd>{selectedRecord.actor}</dd>
              <dt>Action</dt>
              <dd>{selectedRecord.action}</dd>
              <dt>Resource</dt>
              <dd>{selectedRecord.resource}</dd>
            </dl>

            <h3>Details</h3>
            <pre className="audit-history-page__detail-json">
              {JSON.stringify(maskRecordDetails(selectedRecord.details), null, 2)}
            </pre>

            <footer className="audit-history-page__modal-footer">
              <button type="button" onClick={handleCloseModal}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditHistoryPage;