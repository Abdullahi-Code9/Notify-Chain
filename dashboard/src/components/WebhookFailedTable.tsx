import { memo, useMemo } from 'react';
import type { WebhookMetricBucket } from '../types/webhook';
import { EmptyState } from './EmptyState';

interface WebhookDeliveryChartProps {
  buckets: WebhookMetricBucket[];
  isLoading: boolean;
}

const CHART_HEIGHT = 180;
const CHART_PADDING_TOP = 16;
const CHART_PADDING_BOTTOM = 36; // space for x-axis labels
const CHART_PADDING_LEFT = 48; // space for y-axis labels
const CHART_PADDING_RIGHT = 16;

const SKELETON_BUCKET_COUNT = 24;

/** Build an SVG polyline `points` string from value array + chart geometry. */
function buildPolylinePoints(
  values: number[],
  maxValue: number,
  chartWidth: number,
  chartHeight: number,
): string {
  if (values.length < 2) return '';

  const drawWidth =
    chartWidth - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const drawHeight =
    chartHeight - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const safeMax = maxValue > 0 ? maxValue : 1;

  return values
    .map((v, i) => {
      const x =
        CHART_PADDING_LEFT +
        (i / (values.length - 1)) * drawWidth;
      const y =
        CHART_PADDING_TOP +
        drawHeight -
        (v / safeMax) * drawHeight;

      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Build an SVG path for a filled area under the line. */
function buildAreaPath(
  values: number[],
  maxValue: number,
  chartWidth: number,
  chartHeight: number,
): string {
  if (values.length < 2) return '';

  const drawWidth =
    chartWidth - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const drawHeight =
    chartHeight - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const safeMax = maxValue > 0 ? maxValue : 1;
  const baseY = CHART_PADDING_TOP + drawHeight;

  const points = values.map((v, i) => {
    const x =
      CHART_PADDING_LEFT +
      (i / (values.length - 1)) * drawWidth;
    const y =
      CHART_PADDING_TOP +
      drawHeight -
      (v / safeMax) * drawHeight;

    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const firstX = CHART_PADDING_LEFT.toFixed(1);
  const lastX = (
    CHART_PADDING_LEFT + drawWidth
  ).toFixed(1);

  return `M ${firstX},${baseY} L ${points.join(
    ' L ',
  )} L ${lastX},${baseY} Z`;
}

/** Select a subset of tick labels to avoid crowding. */
function getTickIndices(
  count: number,
  maxTicks = 8,
): number[] {
  if (count <= maxTicks) {
    return Array.from({ length: count }, (_, i) => i);
  }

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

export const WebhookDeliveryChart = memo(
  function WebhookDeliveryChart({
    buckets,
    isLoading,
  }: WebhookDeliveryChartProps) {
    const {
      successValues,
      failedValues,
      maxValue,
      tickIndices,
    } = useMemo(() => {
      const successValues = buckets.map(
        (b) => b.successCount,
      );
      const failedValues = buckets.map(
        (b) => b.failedCount,
      );
      const maxValue = Math.max(
        1,
        ...successValues,
        ...failedValues,
      );
      const tickIndices = getTickIndices(buckets.length);

      return {
        successValues,
        failedValues,
        maxValue,
        tickIndices,
      };
    }, [buckets]);

    // Responsive: use a viewBox-based SVG so it scales naturally
    const viewBoxWidth = 800;
    const viewBoxHeight = CHART_HEIGHT;

    const drawWidth =
      viewBoxWidth -
      CHART_PADDING_LEFT -
      CHART_PADDING_RIGHT;

    const drawHeight =
      viewBoxHeight -
      CHART_PADDING_TOP -
      CHART_PADDING_BOTTOM;

    const successPoints = buildPolylinePoints(
      successValues,
      maxValue,
      viewBoxWidth,
      viewBoxHeight,
    );

    const failedPoints = buildPolylinePoints(
      failedValues,
      maxValue,
      viewBoxWidth,
      viewBoxHeight,
    );

    const successArea = buildAreaPath(
      successValues,
      maxValue,
      viewBoxWidth,
      viewBoxHeight,
    );

    const failedArea = buildAreaPath(
      failedValues,
      maxValue,
      viewBoxWidth,
      viewBoxHeight,
    );

    // Y-axis ticks: 5 levels
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(
      (ratio) => ({
        value: Math.round(maxValue * ratio),
        y:
          CHART_PADDING_TOP +
          drawHeight -
          ratio * drawHeight,
      }),
    );

    const baseY =
      CHART_PADDING_TOP + drawHeight;

    return (
      <div
        className="webhook-delivery-chart"
        aria-label="Delivery success vs failure chart"
      >
        {/* Legend */}
        <div
          className="webhook-delivery-chart__legend"
          aria-hidden="true"
        >
          <span className="webhook-delivery-chart__legend-item webhook-delivery-chart__legend-item--success">
            <svg
              width="16"
              height="2"
              aria-hidden="true"
            >
              <line
                x1="0"
                y1="1"
                x2="16"
                y2="1"
                stroke="#34d399"
                strokeWidth="2"
              />
            </svg>
            Successful
          </span>

          <span className="webhook-delivery-chart__legend-item webhook-delivery-chart__legend-item--failed">
            <svg
              width="16"
              height="2"
              aria-hidden="true"
            >
              <line
                x1="0"
                y1="1"
                x2="16"
                y2="1"
                stroke="#f87171"
                strokeWidth="2"
              />
            </svg>
            Failed
          </span>
        </div>

        {isLoading ? (
          /* Skeleton state */
          <svg
            viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
            className="webhook-delivery-chart__svg"
            role="img"
            aria-label="Loading chart data"
          >
            {/* Skeleton bars */}
            {Array.from({
              length: SKELETON_BUCKET_COUNT,
            }).map((_, i) => {
              const barW =
                (drawWidth / SKELETON_BUCKET_COUNT) *
                0.6;

              const x =
                CHART_PADDING_LEFT +
                (i / SKELETON_BUCKET_COUNT) *
                  drawWidth +
                barW * 0.3;

              const h =
                20 + ((i * 37 + 13) % 80);

              return (
                <rect
                  key={i}
                  x={x}
                  y={baseY - h}
                  width={barW}
                  height={h}
                  rx="3"
                  className="webhook-delivery-chart__skeleton-bar"
                />
              );
            })}
          </svg>
        ) : buckets.length === 0 ? (
          <div className="webhook-delivery-chart__empty">
            <EmptyState
              className="empty-state--inline"
              icon="📊"
              title="No data"
              description="No delivery data for the selected range."
            />
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
            className="webhook-delivery-chart__svg"
            role="img"
            aria-label="Time-series chart of webhook delivery outcomes"
          >
            <defs>
              <linearGradient
                id="wh-success-fill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="#34d399"
                  stopOpacity="0.25"
                />
                <stop
                  offset="100%"
                  stopColor="#34d399"
                  stopOpacity="0.02"
                />
              </linearGradient>

              <linearGradient
                id="wh-failed-fill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="#f87171"
                  stopOpacity="0.2"
                />
                <stop
                  offset="100%"
                  stopColor="#f87171"
                  stopOpacity="0.02"
                />
              </linearGradient>
            </defs>

            {/* Grid lines + Y-axis labels */}
            {yTicks.map(({ value, y }) => (
              <g key={y}>
                <line
                  x1={CHART_PADDING_LEFT}
                  y1={y}
                  x2={
                    viewBoxWidth -
                    CHART_PADDING_RIGHT
                  }
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
              x2={
                viewBoxWidth -
                CHART_PADDING_RIGHT
              }
              y2={baseY}
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="1"
            />

            {/* Filled areas */}
            <path
              d={successArea}
              fill="url(#wh-success-fill)"
            />

            <path
              d={failedArea}
              fill="url(#wh-failed-fill)"
            />

            {/* Lines */}
            <polyline
              points={successPoints}
              fill="none"
              stroke="#34d399"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            <polyline
              points={failedPoints}
              fill="none"
              stroke="#f87171"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* X-axis labels */}
            {tickIndices.map((idx) => {
              const bucket = buckets[idx];

              const x =
                CHART_PADDING_LEFT +
                (buckets.length > 1
                  ? (idx / (buckets.length - 1)) *
                    drawWidth
                  : drawWidth / 2);

              return (
                <text
                  key={idx}
                  x={x}
                  y={viewBoxHeight - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#6b7280"
                >
                  {bucket.displayLabel}
                </text>
              );
            })}
          </svg>
        )}
      </div>
    );
  },
);