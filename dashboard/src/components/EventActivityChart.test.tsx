import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { EventActivityChart, getTickIndices } from './EventActivityChart';
import type { EventActivityBucket } from '../utils/eventActivityData';

expect.extend(toHaveNoViolations);

function bucket(overrides: Partial<EventActivityBucket> = {}): EventActivityBucket {
  const startMs = overrides.startMs ?? Date.UTC(2026, 0, 15, 0, 0, 0);
  return {
    key: new Date(startMs).toISOString(),
    startMs,
    endMs: startMs + 60 * 60 * 1000,
    label: '12:00',
    displayLabel: '12:00',
    count: 0,
    ...overrides,
  };
}

function bucketsWithCounts(counts: number[]): EventActivityBucket[] {
  return counts.map((count, i) =>
    bucket({
      startMs: Date.UTC(2026, 0, 15, 0, 0, 0) + i * 60 * 60 * 1000,
      count,
      displayLabel: `bucket-${i}`,
      label: `b${i}`,
    }),
  );
}

describe('EventActivityChart', () => {
  it('shows the reconciled total in the summary', () => {
    render(<EventActivityChart buckets={bucketsWithCounts([2, 3, 5])} rangeLabel="the last 6 hours" />);

    expect(screen.getByText(/events in the last 6 hours/)).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('renders one bar per bucket with reconcilable counts', () => {
    const buckets = bucketsWithCounts([1, 4, 0]);
    const { container } = render(<EventActivityChart buckets={buckets} />);

    const bars = container.querySelectorAll('.event-activity-chart__bar');
    expect(bars).toHaveLength(3);

    const renderedCounts = Array.from(bars).map((bar) => Number(bar.getAttribute('data-count')));
    expect(renderedCounts).toEqual([1, 4, 0]);
    expect(renderedCounts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('supports empty datasets with an empty state', () => {
    render(<EventActivityChart buckets={[]} />);

    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.getByText('No activity data')).toBeInTheDocument();
  });

  it('renders a zeroed-but-present dataset without the empty state', () => {
    const { container } = render(<EventActivityChart buckets={bucketsWithCounts([0, 0, 0])} />);

    expect(screen.queryByText('No activity data')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.event-activity-chart__bar')).toHaveLength(3);
  });

  it('renders a loading skeleton instead of bars', () => {
    const { container } = render(<EventActivityChart buckets={bucketsWithCounts([1, 2])} isLoading />);

    expect(container.querySelectorAll('.event-activity-chart__bar')).toHaveLength(0);
    expect(container.querySelectorAll('.event-activity-chart__skeleton-bar').length).toBeGreaterThan(
      0,
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <EventActivityChart buckets={bucketsWithCounts([1, 4, 2])} rangeLabel="the last 24 hours" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe('getTickIndices', () => {
  it('returns every index when below the tick limit', () => {
    expect(getTickIndices(5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins labels but always includes the last index', () => {
    const indices = getTickIndices(24, 8);
    expect(indices.length).toBeLessThanOrEqual(9);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(23);
  });

  it('handles zero buckets', () => {
    expect(getTickIndices(0)).toEqual([]);
  });
});
