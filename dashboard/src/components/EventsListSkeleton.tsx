interface EventsListSkeletonProps {
  rows?: number;
}

function SkeletonLine({ width }: { width: string }) {
  return (
    <span className="skeleton-block skeleton-block--inline" style={{ width }} aria-hidden="true" />
  );
}

export function EventsListSkeleton({ rows = 8 }: EventsListSkeletonProps) {
  return (
    <div className="event-panel event-panel--skeleton" aria-busy="true" aria-label="Loading events">
      <div className="event-list" role="status">
        {Array.from({ length: rows }).map((_, index) => (
          <article key={index} className="event-row event-row--skeleton">
            <div className="event-row__primary">
              <SkeletonLine width="140px" />
              <SkeletonLine width="90px" />
            </div>
            <div className="event-row__meta">
              <SkeletonLine width="120px" />
              <SkeletonLine width="160px" />
            </div>
            <div className="event-row__details">
              <SkeletonLine width="80px" />
              <SkeletonLine width="110px" />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
