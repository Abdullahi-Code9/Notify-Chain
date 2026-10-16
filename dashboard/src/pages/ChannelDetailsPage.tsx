import { useState, useEffect } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChannelStats {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  deliveryRate: number;
}

interface ChannelDetail {
  key: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  protocol: string;
  status: 'active' | 'degraded' | 'inactive';
  subscriberCount: number;
  stats: ChannelStats;
}

// ── Mock data (mirrors the channelDefinitions pattern used across the dashboard) ──

const MOCK_CHANNELS: ChannelDetail[] = [
  {
    key: 'inApp',
    label: 'In-App',
    description:
      'Push notifications delivered directly inside the Notify-Chain dashboard. No external credentials required — subscribers receive alerts in real time while the app is open.',
    icon: '🔔',
    color: '#5b7dff',
    protocol: 'WebSocket / SSE',
    status: 'active',
    subscriberCount: 3_842,
    stats: { sent: 128_450, delivered: 127_901, failed: 549, pending: 12, deliveryRate: 99.57 },
  },
  {
    key: 'email',
    label: 'Email',
    description:
      'Notifications dispatched via SMTP to verified recipient email addresses. Supports HTML templates with dynamic variable substitution.',
    icon: '✉️',
    color: '#34a853',
    protocol: 'SMTP / Sendgrid',
    status: 'active',
    subscriberCount: 2_197,
    stats: { sent: 74_320, delivered: 72_810, failed: 1_510, pending: 87, deliveryRate: 97.97 },
  },
  {
    key: 'discord',
    label: 'Discord',
    description:
      'Event payloads forwarded to Discord channels via webhook URLs. Formatted as rich embeds with colour-coded severity levels.',
    icon: '💬',
    color: '#5865f2',
    protocol: 'Discord Webhooks',
    status: 'active',
    subscriberCount: 1_564,
    stats: { sent: 53_200, delivered: 52_900, failed: 300, pending: 4, deliveryRate: 99.44 },
  },
  {
    key: 'telegram',
    label: 'Telegram',
    description:
      'Alerts sent to Telegram bots or groups via the Bot API. Subscribers configure their chat handle and receive formatted Markdown messages.',
    icon: '📨',
    color: '#0088cc',
    protocol: 'Telegram Bot API',
    status: 'degraded',
    subscriberCount: 887,
    stats: { sent: 29_100, delivered: 27_650, failed: 1_450, pending: 210, deliveryRate: 95.02 },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function statusLabel(s: ChannelDetail['status']): string {
  return s === 'active' ? 'Active' : s === 'degraded' ? 'Degraded' : 'Inactive';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cd-stat-card">
      <p className="cd-stat-card__label">{label}</p>
      <p className="cd-stat-card__value">{value}</p>
      {sub && <p className="cd-stat-card__sub">{sub}</p>}
    </div>
  );
}

function DeliveryBar({ rate }: { rate: number }) {
  return (
    <div className="cd-delivery-bar" aria-label={`Delivery rate ${rate}%`}>
      <div
        className="cd-delivery-bar__fill"
        style={{ width: `${rate}%`, opacity: rate >= 98 ? 1 : rate >= 95 ? 0.85 : 0.65 }}
      />
    </div>
  );
}

function ChannelCard({ ch }: { ch: ChannelDetail }) {
  return (
    <article className="cd-channel-card" aria-label={`${ch.label} channel details`}>
      {/* Header */}
      <div className="cd-channel-card__header" style={{ borderColor: ch.color }}>
        <span className="cd-channel-card__icon" aria-hidden="true">
          {ch.icon}
        </span>
        <div className="cd-channel-card__header-text">
          <h2 className="cd-channel-card__title">{ch.label}</h2>
          <p className="cd-channel-card__protocol">{ch.protocol}</p>
        </div>
        <span
          className={`cd-channel-card__status cd-channel-card__status--${ch.status}`}
          role="status"
        >
          {statusLabel(ch.status)}
        </span>
      </div>

      {/* Description */}
      <p className="cd-channel-card__desc">{ch.description}</p>

      {/* Subscriber count */}
      <div className="cd-channel-card__subscribers">
        <span className="cd-channel-card__subscribers-label">Subscribers</span>
        <span className="cd-channel-card__subscribers-count" style={{ color: ch.color }}>
          {formatNumber(ch.subscriberCount)}
        </span>
      </div>

      {/* Delivery rate bar */}
      <div className="cd-channel-card__rate-row">
        <span className="cd-channel-card__rate-label">Delivery rate</span>
        <span className="cd-channel-card__rate-pct">{ch.stats.deliveryRate.toFixed(2)}%</span>
      </div>
      <DeliveryBar rate={ch.stats.deliveryRate} />

      {/* Stats grid */}
      <div className="cd-channel-card__stats">
        <StatCard label="Sent" value={formatNumber(ch.stats.sent)} />
        <StatCard label="Delivered" value={formatNumber(ch.stats.delivered)} />
        <StatCard
          label="Failed"
          value={formatNumber(ch.stats.failed)}
          sub={
            ch.stats.failed > 0
              ? `${((ch.stats.failed / ch.stats.sent) * 100).toFixed(1)}%`
              : undefined
          }
        />
        <StatCard label="Pending" value={String(ch.stats.pending)} />
      </div>
    </article>
  );
}

function ChannelCardSkeleton() {
  return (
    <div
      className="cd-channel-card cd-channel-card--skeleton"
      aria-busy="true"
      aria-label="Loading channel"
    >
      <div className="cd-skeleton-line cd-skeleton-line--title" />
      <div className="cd-skeleton-line cd-skeleton-line--body" />
      <div className="cd-skeleton-line cd-skeleton-line--body cd-skeleton-line--short" />
      <div className="cd-skeleton-line cd-skeleton-line--bar" />
      <div className="cd-skeleton-stats">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="cd-skeleton-line cd-skeleton-line--stat" />
        ))}
      </div>
    </div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function SummaryStrip({ channels }: { channels: ChannelDetail[] }) {
  const totalSubs = channels.reduce((s, c) => s + c.subscriberCount, 0);
  const totalSent = channels.reduce((s, c) => s + c.stats.sent, 0);
  const totalFailed = channels.reduce((s, c) => s + c.stats.failed, 0);
  const overallRate = ((totalSent - totalFailed) / totalSent) * 100;

  return (
    <div className="cd-summary-strip" role="region" aria-label="Overall channel statistics">
      <div className="cd-summary-strip__item">
        <span className="cd-summary-strip__value">{channels.length}</span>
        <span className="cd-summary-strip__label">Channels</span>
      </div>
      <div className="cd-summary-strip__item">
        <span className="cd-summary-strip__value">{formatNumber(totalSubs)}</span>
        <span className="cd-summary-strip__label">Total subscribers</span>
      </div>
      <div className="cd-summary-strip__item">
        <span className="cd-summary-strip__value">{formatNumber(totalSent)}</span>
        <span className="cd-summary-strip__label">Total sent</span>
      </div>
      <div className="cd-summary-strip__item">
        <span className="cd-summary-strip__value">{overallRate.toFixed(2)}%</span>
        <span className="cd-summary-strip__label">Overall delivery rate</span>
      </div>
      <div className="cd-summary-strip__item">
        <span className="cd-summary-strip__value cd-summary-strip__value--active">
          {channels.filter((c) => c.status === 'active').length}
        </span>
        <span className="cd-summary-strip__label">Active</span>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function ChannelDetailsPage() {
  const [channels, setChannels] = useState<ChannelDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Simulate async API fetch — replace with real endpoint when available
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        setChannels(MOCK_CHANNELS);
      } catch {
        setError('Failed to load channel data. Please try again.');
      } finally {
        setLoading(false);
      }
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  function handleRetry() {
    setChannels([]);
    setLoading(true);
    setError(null);
    window.setTimeout(() => {
      setChannels(MOCK_CHANNELS);
      setLoading(false);
    }, 600);
  }

  return (
    <main className="cd-page">
      {/* Page header */}
      <header className="cd-page__header">
        <div>
          <p className="cd-page__eyebrow">Channels</p>
          <h1 className="cd-page__title">Channel Details</h1>
          <p className="cd-page__lead">
            Per-channel configuration, subscriber counts, and real-time delivery statistics.
          </p>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="cd-error-banner" role="alert">
          <strong>Error:</strong> {error}
          <button type="button" onClick={handleRetry} className="cd-error-banner__retry">
            Retry
          </button>
        </div>
      )}

      {/* Summary strip */}
      {!loading && !error && <SummaryStrip channels={channels} />}

      {/* Channel grid */}
      <section className="cd-channel-grid" aria-label="Channel cards" aria-busy={loading}>
        {loading
          ? [1, 2, 3, 4].map((i) => <ChannelCardSkeleton key={i} />)
          : channels.map((ch) => <ChannelCard key={ch.key} ch={ch} />)}
      </section>
    </main>
  );
}
