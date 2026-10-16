import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { EventExplorerTable, ROW_HEIGHT } from './EventExplorerTable';
import { generateMockEvents } from '../utils/eventData';
import type { BlockchainEvent } from '../types/event';

const EVENT_COUNT = 5000;
const SCROLL_TARGET_INDEX = 50;

function renderTable(events: BlockchainEvent[]) {
  const utils = render(<EventExplorerTable events={events} />);
  const body = utils.container.querySelector('.event-explorer__table-body');
  if (!body) {
    throw new Error('EventExplorerTable did not render its scrollable body.');
  }
  return { ...utils, body: body as HTMLElement };
}

function renderedEventIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.event-explorer__row')).map(
    (row) => row.getAttribute('data-event-id') ?? '',
  );
}

describe('EventExplorerTable virtualization', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders only a window of rows for a 5,000 event dataset', () => {
    const { container } = renderTable(generateMockEvents(EVENT_COUNT));

    // jest.setup.cjs reports a 600px clientHeight for every jsdom element.
    const rendered = renderedEventIds(container);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(rendered.length).toBeLessThan(EVENT_COUNT);

    const spacer = container.querySelector('.event-explorer__table-spacer') as HTMLElement | null;
    expect(spacer).not.toBeNull();
    expect(spacer?.style.height).toBe(`${EVENT_COUNT * ROW_HEIGHT}px`);
  });

  it('moves the rendered window when the body scrolls', () => {
    const { container, body } = renderTable(generateMockEvents(EVENT_COUNT));

    const initialIds = renderedEventIds(container);
    expect(initialIds[0]).toBe('event-0');

    fireEvent.scroll(body, { target: { scrollTop: SCROLL_TARGET_INDEX * ROW_HEIGHT } });

    const scrolledIds = renderedEventIds(container);
    expect(scrolledIds.length).toBeGreaterThan(0);
    expect(scrolledIds[0]).not.toBe(initialIds[0]);
    expect(scrolledIds).toContain(`event-${SCROLL_TARGET_INDEX}`);
  });

  it('renders every row when the dataset already fits the viewport', () => {
    const { container } = renderTable(generateMockEvents(5));
    expect(renderedEventIds(container)).toHaveLength(5);
  });
});
