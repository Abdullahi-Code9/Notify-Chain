import { render } from '@testing-library/react';
import { describe, expect, it } from '@jest/globals';
import { EventList } from '../components/EventList';
import { EventListNaive } from '../components/EventListNaive';
import { generateMockEvents } from '../utils/eventData';

const EVENT_COUNT = 2000;

function countRenderedRows(container: HTMLElement): number {
  return container.querySelectorAll('.event-row').length;
}

// Performance metrics tracking
interface PerformanceMetrics {
  testName: string;
  duration: number;
  renderedNodes: number;
  timestamp: string;
}

const metricsLog: PerformanceMetrics[] = [];

function logPerformance(testName: string, duration: number, renderedNodes: number) {
  const metric: PerformanceMetrics = {
    testName,
    duration,
    renderedNodes,
    timestamp: new Date().toISOString(),
  };
  metricsLog.push(metric);
  console.log(`[Performance] ${testName}: ${duration.toFixed(2)}ms, ${renderedNodes} nodes`);
}

afterAll(() => {
  if (metricsLog.length > 0) {
    console.log('\n=== Performance Metrics Summary ===');
    metricsLog.forEach((metric) => {
      console.log(`${metric.testName}: ${metric.duration.toFixed(2)}ms, ${metric.renderedNodes} nodes (${metric.timestamp})`);
    });
    console.log('===================================\n');
  }
});

describe('event list render performance', () => {
  const events = generateMockEvents(EVENT_COUNT);

  it('virtualized list renders a bounded number of DOM nodes for large datasets', () => {
    const startTime = performance.now();
    const { container } = render(
      <div style={{ height: 600, width: 800 }}>
        <EventList events={events} />
      </div>,
    );
    const duration = performance.now() - startTime;

    const renderedRows = countRenderedRows(container);
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(EVENT_COUNT);
    expect(renderedRows).toBeLessThan(50);

    logPerformance('Virtualized list initial render', duration, renderedRows);
  });

  it('naive list renders every row and is measurably slower than virtualization', () => {
    const naiveStart = performance.now();
    const naiveRender = render(<EventListNaive events={events} />);
    const naiveDuration = performance.now() - naiveStart;
    const naiveRows = countRenderedRows(naiveRender.container);

    logPerformance('Naive list render', naiveDuration, naiveRows);

    naiveRender.unmount();

    const virtualStart = performance.now();
    const virtualRender = render(
      <div style={{ height: 600, width: 800 }}>
        <EventList events={events} />
      </div>,
    );
    const virtualDuration = performance.now() - virtualStart;
    const virtualRows = countRenderedRows(virtualRender.container);

    logPerformance('Virtualized list comparison render', virtualDuration, virtualRows);

    expect(naiveRows).toBe(EVENT_COUNT);
    expect(virtualRows).toBeLessThan(naiveRows);
    expect(virtualDuration).toBeLessThan(naiveDuration);
  });

  it('performance metrics are recorded for optimization tracking', () => {
    expect(metricsLog.length).toBeGreaterThan(0);
    metricsLog.forEach((metric) => {
      expect(metric.duration).toBeGreaterThanOrEqual(0);
      expect(metric.renderedNodes).toBeGreaterThanOrEqual(0);
      expect(metric.timestamp).toBeDefined();
    });
  });
});
