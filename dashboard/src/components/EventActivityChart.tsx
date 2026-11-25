import { memo, useMemo } from 'react';
import type { EventActivityBucket } from '../utils/eventActivityData';
import { sumBucketCounts } from '../utils/eventActivityData';
import { EmptyState } from './EmptyState';

interface EventActivityChartProps {
  /** Time-ordered (oldest first) buckets from `computeEventActivity`. */
  buckets: EventActivityBucket[];
  isLoading?: boolean;
  /** Human-readable description of the selected range, e.g. "last 24 hours". */
  rangeLabel?: string;
}

const CHART_HEIGHT = 200;
const CHART_PADDING_TOP = 16;
const CHART_PADDING_BOTTOM = 40;
const CHART_PADDING_LEFT = 48;
const CHART_PADDING_RIGHT = 16;
const VIEW_BOX_WIDTH = 800;
const SKELETON_BAR_COUNT = 24;
const MAX_TICK_LABELS = 8;

/** Choose a subset of bucket indices to label so axis text does not overlap. */
export function getTickIndices(count: number, maxTicks: number = MAX_TICK_LABELS): number[] {
  if (count <= 0) return [];
  if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);

  const step = Math.ceil(count / maxTicks);
  const indices: number[] = [];
  for (let i = 0; i < count; i += step) {
    indices.push(i);
  }
  if (indices[indices.length - 1] !== count - 1) {
    indices.push(count - 1);
  }
  return indices;
}

export const EventActivityChart = memo(function EventActivityChart({
  buckets,
  isLoading = false,
  rangeLabel = 'the selected range',
}: EventActivityChartProps) {
  const totalCount = useMemo(() => sumBucketCounts(buckets), [buckets]);

  const maxCount = useMemo(
    () => buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0),
    [buckets],
  );

  const tickIndices = useMemo(() => getTickIndices(buckets.length), [buckets.length]);

  const drawWidth = VIEW_BOX_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const drawHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const baseY = CHART_PADDING_TOP + drawHeight;
  const safeMax = maxCount > 0 ? maxCount : 1;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    value: Math.round(maxCount * ratio),
    y: CHART_PADDING_TOP + drawHeight - ratio * drawHeight,
  }));

  const barCount = buckets.length;
  const slotWidth = barCount > 0 ? drawWidth / barCount : drawWidth;
  const barWidth = Math.max(1, slotWidth * 0.6);

  const barX = (index: number) =>
    CHART_PADDING_LEFT + index * slotWidth + (slotWidth - barWidth) / 2;

  return (
    <div className="event-activity-chart" aria-label={`Event activity for ${rangeLabel}`}>
      <p className="event-activity-chart__summary">
        <strong>{totalCount.toLocaleString()}</strong> events in {rangeLabel}
      </p>

      {isLoading ? (
        <svg
          viewBox={`0 0 ${VIEW_BOX_WIDTH} ${CHART_HEIGHT}`}
          className="event-activity-chart__svg"
          role="img"
          aria-label="Loading event activity"
        >
          {Array.from({ length: SKELETON_BAR_COUNT }).map((_, i) => {
            const h = 20 + ((i * 37 + 13) % 90);
            return (
              <rect
                key={i}
                x={CHART_PADDING_LEFT + (i / SKELETON_BAR_COUNT) * drawWidth + 2}
                y={baseY - h}
                width={Math.max(1, (drawWidth / SKELETON_BAR_COUNT) * 0.6)}
                height={h}
                rx="3"
                className="event-activity-chart__skeleton-bar"
              />
            );
          })}
        </svg>
      ) : barCount === 0 ? (
        <div className="event-activity-chart__empty">
          <EmptyState
            className="empty-state--inline"
            icon="📈"
            title="No activity data"
            description="No events were received in the selected range."
          />
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${VIEW_BOX_WIDTH} ${CHART_HEIGHT}`}
          className="event-activity-chart__svg"
          role="img"
          aria-label={`Bar chart of event volume for ${rangeLabel}`}
        >
          {/* Grid lines + Y-axis labels */}
          {yTicks.map(({ value, y }) => (
            <g key={y}>
              <line
                x1={CHART_PADDING_LEFT}
                y1={y}
                x2={VIEW_BOX_WIDTH - CHART_PADDING_RIGHT}
                y2={y}
                stroke="rgba(255,255,255,0.07)"
                strokeWidth="1"
              />
              <text
                x={CHART_PADDING_LEFT - 6}
                y={y + 4}
                textAnchor="end"
                fontSize="11"
                fill="#6b7280"
              >
                {value}
              </text>
            </g>
          ))}

          {/* X-axis baseline */}
          <line
            x1={CHART_PADDING_LEFT}
            y1={baseY}
            x2={VIEW_BOX_WIDTH - CHART_PADDING_RIGHT}
            y2={baseY}
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1"
          />

          {/* Bars */}
          {buckets.map((bucket, index) => {
            const h = (bucket.count / safeMax) * drawHeight;
            return (
              <rect
                key={bucket.key}
                x={barX(index)}
                y={baseY - h}
                width={barWidth}
                height={Math.max(0, h)}
                rx="2"
                className="event-activity-chart__bar"
                data-count={bucket.count}
                data-bucket-key={bucket.key}
              >
                <title>{`${bucket.displayLabel}: ${bucket.count} event${bucket.count === 1 ? '' : 's'}`}</title>
              </rect>
            );
          })}

          {/* X-axis labels */}
          {tickIndices.map((index) => (
            <text
              key={buckets[index].key}
              x={barX(index) + barWidth / 2}
              y={CHART_HEIGHT - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#6b7280"
            >
              {buckets[index].label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
});
