import { useCallback, useEffect, useState } from 'react';
import { fetchRetryStatistics, generateMockRetryStatistics } from '../services/retryStatisticsApi';
import type { RetryStatistics } from '../types/retryStatistics';
import { formatAverageRetries, formatRetryRate } from '../types/retryStatistics';

export function RetryStatisticsPanel() {
  const [stats, setStats] = useState<RetryStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRetryStatistics();
      setStats(data);
      setUsingMock(false);
    } catch {
      setStats(generateMockRetryStatistics());
      setUsingMock(true);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="retry-stats" aria-labelledby="retry-stats-title">
      <div className="retry-stats__header">
        <div>
          <h2 id="retry-stats-title" className="retry-stats__title">
            Notification Retry Statistics
          </h2>
          <p className="retry-stats__subtitle">
            Delivery monitoring for failed notifications and retry attempts
            {usingMock ? ' (sample data)' : ''}
          </p>
        </div>
        <button type="button" className="retry-stats__refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading && !stats && (
        <p className="retry-stats__loading" role="status">
          Loading retry statistics…
        </p>
      )}

      {error && (
        <div className="retry-stats__error" role="alert">
          {error}
        </div>
      )}

      {stats && (
        <>
          <div className="retry-stats__cards" role="list" aria-label="Retry summary">
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Total retries</p>
              <p className="retry-stats__card-value">{stats.totalRetryAttempts}</p>
            </article>
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Notifications with retries</p>
              <p className="retry-stats__card-value">{stats.notificationsWithRetries}</p>
            </article>
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Recovered after retry</p>
              <p className="retry-stats__card-value">{stats.recoveredAfterRetry}</p>
            </article>
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Permanent failures</p>
              <p className="retry-stats__card-value">{stats.permanentFailures}</p>
            </article>
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Avg retries / notification</p>
              <p className="retry-stats__card-value">
                {formatAverageRetries(stats.averageRetriesPerNotification)}
              </p>
            </article>
            <article className="retry-stats__card" role="listitem">
              <p className="retry-stats__card-label">Retry rate</p>
              <p className="retry-stats__card-value">{formatRetryRate(stats.retryRate)}</p>
            </article>
          </div>

          <div className="retry-stats__distribution">
            <h3 className="retry-stats__distribution-title">Retry distribution</h3>
            {stats.distribution.length === 0 ? (
              <p className="retry-stats__empty" role="status">
                No retry data recorded yet.
              </p>
            ) : (
              <table className="retry-stats__table">
                <caption className="sr-only">Notifications grouped by retry count</caption>
                <thead>
                  <tr>
                    <th scope="col">Retry count</th>
                    <th scope="col">Total</th>
                    <th scope="col">Succeeded</th>
                    <th scope="col">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.distribution.map((bucket) => (
                    <tr key={bucket.retryCount}>
                      <td>{bucket.retryCount}</td>
                      <td>{bucket.count}</td>
                      <td>{bucket.successCount}</td>
                      <td>{bucket.failureCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
