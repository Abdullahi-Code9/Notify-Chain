import { memo } from 'react';
import type { WebhookSummaryMetrics } from '../types/webhook';

interface WebhookSummaryCardsProps {
  summary: WebhookSummaryMetrics;
  isLoading: boolean;
}

function MetricCard({
  label,
  value,
  subValue,
  accent,
  isLoading,
}: {
  label: string;
  value: string;
  subValue?: string;
  accent: 'blue' | 'green' | 'red' | 'yellow';
  isLoading: boolean;
}) {
  return (
    <div className={`webhook-metric-card webhook-metric-card--${accent}`} aria-busy={isLoading}>
      <dt className="webhook-metric-card__label">{label}</dt>
      {isLoading ? (
        <dd className="webhook-metric-card__value">
          <span className="webhook-metric-card__skeleton" aria-hidden="true" />
        </dd>
      ) : (
        <dd className="webhook-metric-card__value">
          <span className="webhook-metric-card__number">{value}</span>
          {subValue && <span className="webhook-metric-card__sub">{subValue}</span>}
        </dd>
      )}
    </div>
  );
}

export const WebhookSummaryCards = memo(function WebhookSummaryCards({
  summary,
  isLoading,
}: WebhookSummaryCardsProps) {
  const successRateStr = isLoading ? '—' : `${summary.successRate.toFixed(2)}%`;
  const totalStr = isLoading ? '—' : summary.totalAttempts.toLocaleString();
  const failedStr = isLoading ? '—' : summary.failedCount.toLocaleString();
  const avgLatencyStr = isLoading
    ? '—'
    : summary.avgLatencyMs !== null
      ? `${summary.avgLatencyMs.toLocaleString()} ms`
      : '—';
  const p95LatencyStr =
    !isLoading && summary.p95LatencyMs !== null
      ? `p95: ${summary.p95LatencyMs.toLocaleString()} ms`
      : undefined;

  // Determine accent for success rate
  const rateAccent: 'green' | 'yellow' | 'red' =
    summary.successRate >= 95 ? 'green' : summary.successRate >= 80 ? 'yellow' : 'red';

  return (
    <dl className="webhook-summary-cards" aria-label="Webhook delivery summary">
      <MetricCard label="Total Attempts" value={totalStr} accent="blue" isLoading={isLoading} />
      <MetricCard
        label="Success Rate"
        value={successRateStr}
        accent={rateAccent}
        isLoading={isLoading}
      />
      <MetricCard label="Failed Deliveries" value={failedStr} accent="red" isLoading={isLoading} />
      <MetricCard
        label="Avg Latency"
        value={avgLatencyStr}
        subValue={p95LatencyStr}
        accent="yellow"
        isLoading={isLoading}
      />
    </dl>
  );
});
