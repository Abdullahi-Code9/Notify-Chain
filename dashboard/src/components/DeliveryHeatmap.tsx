import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { BlockchainEvent } from '../types/event';
import {
  aggregateHeatmapData,
  DAY_LABELS,
  HOUR_LABELS,
  intensityLevel,
} from '../utils/heatmapData';

interface HeatmapDateRange {
  start: string; // yyyy-mm-dd
  end: string;
}

interface DeliveryHeatmapProps {
  events: BlockchainEvent[];
}

/* ── Tooltip state ── */
interface TooltipState {
  day: number;
  hour: number;
  count: number;
  x: number;
  y: number;
}

const CELL_SIZE = 38;
const CELL_GAP = 3;
const CELL_RADIUS = 6;

/** Parses a yyyy-mm-dd string to a Date at start-of-day, or null if empty. */
function parseDateInput(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

/** Parses end-of-day (23:59:59.999) so the full day is included. */
function parseEndDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value + 'T23:59:59.999');
  return isNaN(d.getTime()) ? null : d;
}

/** Quick-range presets for the date filter. */
const PRESETS = [
  { label: 'Last 24 h', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'All time', days: 0 },
] as const;

function DeliveryHeatmapInner({ events }: DeliveryHeatmapProps) {
  const [dateRange, setDateRange] = useState<HeatmapDateRange>({ start: '', end: '' });
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  /* ── Date range helpers ── */
  const startDate = useMemo(() => parseDateInput(dateRange.start), [dateRange.start]);
  const endDate = useMemo(() => parseEndDate(dateRange.end), [dateRange.end]);

  const handleStartChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setDateRange((prev) => ({ ...prev, start: e.target.value })),
    [],
  );
  const handleEndChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setDateRange((prev) => ({ ...prev, end: e.target.value })),
    [],
  );

  const handlePreset = useCallback((days: number) => {
    if (days === 0) {
      setDateRange({ start: '', end: '' });
      return;
    }
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    setDateRange({
      start: start.toISOString().slice(0, 10),
      end: now.toISOString().slice(0, 10),
    });
  }, []);

  const handleClearDates = useCallback(() => {
    setDateRange({ start: '', end: '' });
  }, []);

  /* ── Heatmap data (memoised) ── */
  const heatmap = useMemo(
    () => aggregateHeatmapData(events, startDate, endDate),
    [events, startDate, endDate],
  );

  /* ── Tooltip handlers ── */
  const handleCellEnter = useCallback(
    (day: number, hour: number, count: number, el: HTMLElement) => {
      if (!gridRef.current) return;
      const gridRect = gridRef.current.getBoundingClientRect();
      const cellRect = el.getBoundingClientRect();
      setTooltip({
        day,
        hour,
        count,
        x: cellRect.left - gridRect.left + cellRect.width / 2,
        y: cellRect.top - gridRect.top,
      });
    },
    [],
  );

  const handleCellLeave = useCallback(() => setTooltip(null), []);

  /* ── Legend ── */
  const legendLevels = [0, 1, 2, 3, 4];

  const hasFilters = dateRange.start !== '' || dateRange.end !== '';

  return (
    <section className="heatmap" id="delivery-heatmap">
      {/* ── Header ── */}
      <div className="heatmap__header">
        <div>
          <p className="heatmap__eyebrow">Analytics</p>
          <h2 className="heatmap__title">Delivery Activity Heatmap</h2>
          <p className="heatmap__subtitle">
            Notification delivery patterns by day of week and hour of day
          </p>
        </div>

        <div className="heatmap__stats">
          <div className="heatmap__stat">
            <span className="heatmap__stat-value">{heatmap.totalCount.toLocaleString()}</span>
            <span className="heatmap__stat-label">{hasFilters ? 'Filtered' : 'Total'} Events</span>
          </div>
          <div className="heatmap__stat">
            <span className="heatmap__stat-value">{heatmap.maxCount.toLocaleString()}</span>
            <span className="heatmap__stat-label">Peak (per slot)</span>
          </div>
        </div>
      </div>

      {/* ── Date-range filters ── */}
      <div className="heatmap__filters" id="heatmap-date-filters">
        <div className="heatmap__presets">
          {PRESETS.map((preset) => {
            const isActive = preset.days === 0 ? !dateRange.start && !dateRange.end : false; // full active-state logic lives in CSS via data attribute
            return (
              <button
                key={preset.label}
                type="button"
                className={`heatmap__preset-btn${isActive ? ' heatmap__preset-btn--active' : ''}`}
                onClick={() => handlePreset(preset.days)}
                id={`heatmap-preset-${preset.days}`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="heatmap__date-inputs">
          <label className="heatmap__date-field">
            <span>From</span>
            <input
              type="date"
              value={dateRange.start}
              onChange={handleStartChange}
              id="heatmap-date-start"
            />
          </label>
          <label className="heatmap__date-field">
            <span>To</span>
            <input
              type="date"
              value={dateRange.end}
              onChange={handleEndChange}
              id="heatmap-date-end"
            />
          </label>
          {hasFilters && (
            <button
              type="button"
              className="heatmap__clear-btn"
              onClick={handleClearDates}
              id="heatmap-clear-dates"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Heatmap grid ── */}
      <div className="heatmap__grid-container" ref={gridRef}>
        {tooltip && (
          <div
            className="heatmap__tooltip"
            style={{
              left: tooltip.x,
              top: tooltip.y,
            }}
            role="tooltip"
          >
            <strong>{tooltip.count.toLocaleString()}</strong>{' '}
            {tooltip.count === 1 ? 'event' : 'events'}
            <br />
            <span className="heatmap__tooltip-sub">
              {DAY_LABELS[tooltip.day]}, {HOUR_LABELS[tooltip.hour]}
            </span>
          </div>
        )}

        {/* Hour labels (top) */}
        <div className="heatmap__hour-labels">
          <div className="heatmap__corner" />
          {HOUR_LABELS.map((label, i) => (
            <div
              key={i}
              className="heatmap__hour-label"
              style={{ width: CELL_SIZE, marginRight: CELL_GAP }}
            >
              {i % 3 === 0 ? label : ''}
            </div>
          ))}
        </div>

        {/* Rows (one per day-of-week) */}
        {heatmap.cells.map((hours, dayIdx) => (
          <div className="heatmap__row" key={dayIdx}>
            <div className="heatmap__day-label">{DAY_LABELS[dayIdx]}</div>
            {hours.map((cell) => (
              <div
                key={cell.hour}
                className={`heatmap__cell heatmap__cell--level-${intensityLevel(cell.intensity)}`}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  borderRadius: CELL_RADIUS,
                  marginRight: CELL_GAP,
                  marginBottom: CELL_GAP,
                }}
                aria-label={`${DAY_LABELS[cell.day]} ${HOUR_LABELS[cell.hour]}: ${cell.count} events`}
                onMouseEnter={(e) =>
                  handleCellEnter(cell.day, cell.hour, cell.count, e.currentTarget)
                }
                onMouseLeave={handleCellLeave}
                onFocus={(e) => handleCellEnter(cell.day, cell.hour, cell.count, e.currentTarget)}
                onBlur={handleCellLeave}
                tabIndex={0}
                role="gridcell"
              />
            ))}
          </div>
        ))}
      </div>

      {/* ── Legend ── */}
      <div className="heatmap__legend">
        <span className="heatmap__legend-label">Less</span>
        {legendLevels.map((level) => (
          <div
            key={level}
            className={`heatmap__legend-cell heatmap__cell--level-${level}`}
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
            }}
          />
        ))}
        <span className="heatmap__legend-label">More</span>
      </div>
    </section>
  );
}

export const DeliveryHeatmap = memo(DeliveryHeatmapInner);
