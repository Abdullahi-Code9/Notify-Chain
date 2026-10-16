import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchScheduleStats, fetchHealth, fetchAnalytics } from '../services/notificationHealthApi';
import type {
  ScheduleStatsResponse,
  HealthResponse,
  NotificationAnalyticsSnapshot,
} from '../types/notificationHealth';
import { formatTimestampShort } from '../utils/formatTime';
import { formatDuration } from '../utils/formatDuration';

const DEFAULT_POLL_INTERVAL_MS = 5000;

function serviceStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'Healthy';
    case 'error':
      return 'Error';
    case 'not_configured':
      return 'Not Configured';
    default:
      return 'Unknown';
  }
}

function serviceStatusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'notification-health__service--ok';
    case 'error':
      return 'notification-health__service--error';
    case 'not_configured':
      return 'notification-health__service--not-configured';
    default:
      return 'notification-health__service--unknown';
  }
}

function overallStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}

function overallStatusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'notification-health__status--ok';
    case 'degraded':
      return 'notification-health__status--degraded';
    case 'error':
      return 'notification-health__status--error';
    default:
      return 'notification-health__status--unknown';
  }
}

export function NotificationHealthPanel(props: { healthUrl: string; pollIntervalMs?: number }) {
  const pollIntervalMs = props.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const [scheduleStats, setScheduleStats] = useState<ScheduleStatsResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [analytics, setAnalytics] = useState<NotificationAnalyticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const effectivePollIntervalMs = useMemo(() => {
    if (typeof document === 'undefined') return pollIntervalMs;
    return document.visibilityState === 'hidden' ? pollIntervalMs * 3 : pollIntervalMs;
  }, [pollIntervalMs]);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsRefreshing(true);
    setError(null);

    try {
      const [scheduleStatsData, healthData, analyticsData] = await Promise.allSettled([
        fetchScheduleStats(props.healthUrl),
        fetchHealth(props.healthUrl),
        fetchAnalytics(props.healthUrl),
      ]);

      if (scheduleStatsData.status === 'fulfilled') {
        setScheduleStats(scheduleStatsData.value);
      }
      if (healthData.status === 'fulfilled') {
        setHealth(healthData.value);
      }
      if (analyticsData.status === 'fulfilled') {
        setAnalytics(analyticsData.value);
      }

      const allRejected =
        scheduleStatsData.status === 'rejected' &&
        healthData.status === 'rejected' &&
        analyticsData.status === 'rejected';

      if (allRejected) {
        const errors = [scheduleStatsData, healthData, analyticsData].map(
          (p) => (p as PromiseRejectedResult).reason,
        );
        setError(errors.map((e) => (e instanceof Error ? e.message : String(e))).join(', '));
      }

      setLastUpdated(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRefreshing(false);
    }
  }, [props.healthUrl]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(async () => {
        await refresh();
        schedule(effectivePollIntervalMs);
      }, ms);
    };

    void refresh();
    schedule(effectivePollIntervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [effectivePollIntervalMs, refresh]);

  const overallStatus = health?.status ?? 'unknown';
  const successRate = analytics?.overall.successRate ?? 0;

  return (
    <section className="notification-health" aria-label="Notification Health">
      <div className="notification-health__header">
        <div>
          <p className="notification-health__eyebrow">Monitor</p>
          <h2 className="notification-health__title">Notification Health</h2>
        </div>

        <div className="notification-health__meta">
          <span className={`notification-health__status ${overallStatusClass(overallStatus)}`}>
            {overallStatusLabel(overallStatus)}
          </span>
          <span className="notification-health__updated">
            {isRefreshing ? 'Updating…' : `Updated ${formatTimestampShort(lastUpdated)}`}
          </span>
        </div>
      </div>

      {error && (
        <p className="notification-health__error" role="alert">
          {error}
        </p>
      )}

      <div className="notification-health__grid">
        <div className="notification-health__card">
          <h3 className="notification-health__card-title">Queue Health</h3>
          <div className="notification-health__metrics-grid">
            {scheduleStats && (
              <>
                <div className="notification-health__metric">
                  <dt>Pending</dt>
                  <dd>{scheduleStats.pending.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Processing</dt>
                  <dd>{scheduleStats.processing.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Completed</dt>
                  <dd>{scheduleStats.completed.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Failed</dt>
                  <dd>{scheduleStats.failed.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Overdue</dt>
                  <dd>{scheduleStats.overdue.toLocaleString()}</dd>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="notification-health__card">
          <h3 className="notification-health__card-title">Delivery Status</h3>
          <div className="notification-health__metrics-grid">
            {analytics && (
              <>
                <div className="notification-health__metric">
                  <dt>Success Rate</dt>
                  <dd>{(successRate * 100).toFixed(1)}%</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Total Delivered</dt>
                  <dd>{analytics.overall.total.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Success</dt>
                  <dd>{analytics.overall.success.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Failure</dt>
                  <dd>{analytics.overall.failure.toLocaleString()}</dd>
                </div>
                <div className="notification-health__metric">
                  <dt>Avg Duration</dt>
                  <dd>{formatDuration(analytics.overall.averageDurationMs)}</dd>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="notification-health__card notification-health__card--full">
          <h3 className="notification-health__card-title">Service Indicators</h3>
          <div className="notification-health__services-grid">
            {health && (
              <>
                <div
                  className={`notification-health__service ${serviceStatusClass(health.services.stellarRpc.status)}`}
                >
                  <div className="notification-health__service-name">Stellar RPC</div>
                  <div className="notification-health__service-status">
                    {serviceStatusLabel(health.services.stellarRpc.status)}
                  </div>
                  {health.services.stellarRpc.latencyMs && (
                    <div className="notification-health__service-latency">
                      {health.services.stellarRpc.latencyMs}ms
                    </div>
                  )}
                  {health.services.stellarRpc.detail && (
                    <div className="notification-health__service-detail">
                      {health.services.stellarRpc.detail}
                    </div>
                  )}
                </div>
                <div
                  className={`notification-health__service ${serviceStatusClass(health.services.discord.status)}`}
                >
                  <div className="notification-health__service-name">Discord</div>
                  <div className="notification-health__service-status">
                    {serviceStatusLabel(health.services.discord.status)}
                  </div>
                  {health.services.discord.latencyMs && (
                    <div className="notification-health__service-latency">
                      {health.services.discord.latencyMs}ms
                    </div>
                  )}
                  {health.services.discord.detail && (
                    <div className="notification-health__service-detail">
                      {health.services.discord.detail}
                    </div>
                  )}
                </div>
                <div
                  className={`notification-health__service ${serviceStatusClass(health.services.eventRegistry.status)}`}
                >
                  <div className="notification-health__service-name">Event Registry</div>
                  <div className="notification-health__service-status">
                    {serviceStatusLabel(health.services.eventRegistry.status)}
                  </div>
                  <div className="notification-health__service-detail">
                    {health.services.eventRegistry.eventCount.toLocaleString()} events
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
