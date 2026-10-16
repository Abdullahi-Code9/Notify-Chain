import { useWebhookDashboard } from '../hooks/useWebhookDashboard';
import { WebhookSummaryCards } from '../components/WebhookSummaryCards';
import { WebhookDeliveryChart } from '../components/WebhookDeliveryChart';
import { WebhookFiltersBar } from '../components/WebhookFiltersBar';
import { WebhookFailedTable } from '../components/WebhookFailedTable';

export function WebhookDashboardPage() {
  const {
    isLoading,
    error,
    isMockData,
    filters,
    setFilters,
    failedDeliveries,
    summary,
    chartBuckets,
    eventTypeOptions,
    refresh,
    lastRefreshedAt,
  } = useWebhookDashboard();

  return (
    <main className="webhook-dashboard" aria-labelledby="webhook-dashboard-title">
      <header className="webhook-dashboard__header">
        <div>
          <p className="webhook-dashboard__eyebrow">Webhook Monitoring</p>
          <h1 id="webhook-dashboard-title" className="webhook-dashboard__title">
            Delivery Performance
          </h1>
          <p className="webhook-dashboard__lead">
            Real-time visibility into webhook delivery attempts, latency trends, and failure
            diagnostics across all registered endpoints.
          </p>
        </div>
      </header>

      {/* Error banner (API unavailable / mock data notice) */}
      {error && (
        <div className="webhook-dashboard__banner" role="alert">
          <span>{error}</span>
          <button type="button" className="webhook-dashboard__banner-retry" onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {/* Filters */}
      <WebhookFiltersBar
        filters={filters}
        eventTypeOptions={eventTypeOptions}
        onFiltersChange={setFilters}
        lastRefreshedAt={lastRefreshedAt}
        isMockData={isMockData}
        onRefresh={refresh}
        isLoading={isLoading}
      />

      {/* KPI summary cards */}
      <WebhookSummaryCards summary={summary} isLoading={isLoading} />

      {/* Delivery trend chart */}
      <section className="webhook-dashboard__chart-section" aria-labelledby="wh-chart-title">
        <h2 id="wh-chart-title" className="webhook-dashboard__section-title">
          Delivery Trends
        </h2>
        <p className="webhook-dashboard__section-sub">
          Successful vs failed delivery attempts over the selected time range.
        </p>
        <WebhookDeliveryChart buckets={chartBuckets} isLoading={isLoading} />
      </section>

      {/* Failed deliveries table */}
      <WebhookFailedTable deliveries={failedDeliveries} isLoading={isLoading} />
    </main>
  );
}
