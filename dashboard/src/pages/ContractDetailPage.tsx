import { useState, useEffect, useMemo, useCallback } from 'react';
import { useEventStore } from '../store/eventStore';
import type { BlockchainEvent } from '../types/event';
import { EmptyState } from '../components/EmptyState';
import { CopyButton } from '../components/CopyButton';
import { EventCard } from '../components/EventCard';
import { formatTimestamp as formatTime } from '../utils/formatTime';

interface ContractStats {
  totalEvents: number;
  uniqueEventTypes: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

function formatAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="contract-detail__stat-card">
      <p className="contract-detail__stat-label">{label}</p>
      <p className="contract-detail__stat-value">{value}</p>
    </div>
  );
}

function ContractHeader({ address, stats }: { address: string; stats: ContractStats }) {
  return (
    <header className="contract-detail__header">
      <div>
        <p className="contract-detail__eyebrow">Contract Details</p>
        <h1 className="contract-detail__title">{formatAddress(address)}</h1>
        <div className="contract-detail__address-row">
          <code className="contract-detail__address">{address}</code>
          <CopyButton value={address} label="contract address" size="sm" />
        </div>
      </div>
      <div className="contract-detail__stats">
        <StatCard label="Total Events" value={stats.totalEvents.toLocaleString()} />
        <StatCard label="Event Types" value={stats.uniqueEventTypes.toString()} />
        <StatCard
          label="First Event"
          value={stats.firstEventAt ? formatTime(stats.firstEventAt) : 'N/A'}
        />
        <StatCard
          label="Last Event"
          value={stats.lastEventAt ? formatTime(stats.lastEventAt) : 'N/A'}
        />
      </div>
    </header>
  );
}

function EventTypeList({ events }: { events: BlockchainEvent[] }) {
  const eventTypes = useMemo(() => {
    const types = new Map<string, number>();
    events.forEach((event) => {
      if (event.eventName) {
        types.set(event.eventName, (types.get(event.eventName) || 0) + 1);
      }
    });
    return Array.from(types.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [events]);

  if (eventTypes.length === 0) {
    return null;
  }

  return (
    <section className="contract-detail__event-types">
      <h2 className="contract-detail__section-title">Available Event Types</h2>
      <div className="contract-detail__event-type-list">
        {eventTypes.map(({ name, count }) => (
          <div key={name} className="contract-detail__event-type-item">
            <code className="contract-detail__event-type-name">{name}</code>
            <span className="contract-detail__event-type-count">{count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentActivity({ events, onEventClick }: { events: BlockchainEvent[]; onEventClick: (event: BlockchainEvent) => void }) {
  const recentEvents = useMemo(() => {
    return events
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, 10);
  }, [events]);

  if (recentEvents.length === 0) {
    return null;
  }

  return (
    <section className="contract-detail__activity">
      <h2 className="contract-detail__section-title">Recent Activity</h2>
      <div className="contract-detail__activity-list">
        {recentEvents.map((event) => (
          <div
            key={event.eventId}
            className="contract-detail__activity-item"
            onClick={() => onEventClick(event)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onEventClick(event);
              }
            }}
          >
            <EventCard event={event} />
          </div>
        ))}
      </div>
    </section>
  );
}

function ContractDetailSkeleton() {
  return (
    <div className="contract-detail__skeleton" aria-busy="true" aria-label="Loading contract details">
      <div className="contract-detail__skeleton-header">
        <div className="contract-detail__skeleton-title" />
        <div className="contract-detail__skeleton-address" />
      </div>
      <div className="contract-detail__skeleton-stats">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="contract-detail__skeleton-stat" />
        ))}
      </div>
    </div>
  );
}

export function ContractDetailPage({ contractAddress }: { contractAddress: string }) {
  const events = useEventStore((state) => state.events);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<BlockchainEvent | null>(null);

  const contractEvents = useMemo(() => {
    return events.filter((event) => event.contractAddress === contractAddress);
  }, [events, contractAddress]);

  const stats = useMemo<ContractStats>(() => {
    if (contractEvents.length === 0) {
      return {
        totalEvents: 0,
        uniqueEventTypes: 0,
        firstEventAt: null,
        lastEventAt: null,
      };
    }

    const timestamps = contractEvents.map((e) => e.receivedAt);
    const eventTypes = new Set(contractEvents.map((e) => e.eventName).filter(Boolean));

    return {
      totalEvents: contractEvents.length,
      uniqueEventTypes: eventTypes.size,
      firstEventAt: Math.min(...timestamps),
      lastEventAt: Math.max(...timestamps),
    };
  }, [contractEvents]);

  useEffect(() => {
    // Simulate loading state for smooth UX
    const timer = setTimeout(() => {
      setLoading(false);
    }, 300);

    return () => clearTimeout(timer);
  }, []);

  const handleEventClick = useCallback((event: BlockchainEvent) => {
    setSelectedEvent(event);
    // Navigate to event explorer with the event selected
    window.location.hash = 'explorer';
    // Store the selected event ID in URL params for the explorer to pick up
    const url = new URL(window.location.href);
    url.searchParams.set('eventId', event.eventId);
    window.history.replaceState({}, '', `${url.pathname}${url.search}#explorer`);
  }, []);

  if (loading) {
    return <ContractDetailSkeleton />;
  }

  if (contractEvents.length === 0) {
    return (
      <main className="contract-detail-page">
        <header className="contract-detail__header">
          <div>
            <p className="contract-detail__eyebrow">Contract Details</p>
            <h1 className="contract-detail__title">{formatAddress(contractAddress)}</h1>
            <div className="contract-detail__address-row">
              <code className="contract-detail__address">{contractAddress}</code>
              <CopyButton value={contractAddress} label="contract address" size="sm" />
            </div>
          </div>
        </header>
        <EmptyState
          icon="📄"
          title="No events found for this contract"
          message="This contract address has not emitted any events yet, or it may not be monitored by the system."
          action={{
            label: 'View all contracts',
            onClick: () => {
              window.location.hash = 'explorer';
            },
          }}
        />
      </main>
    );
  }

  return (
    <main className="contract-detail-page">
      <ContractHeader address={contractAddress} stats={stats} />
      <EventTypeList events={contractEvents} />
      <RecentActivity events={contractEvents} onEventClick={handleEventClick} />
    </main>
  );
}
