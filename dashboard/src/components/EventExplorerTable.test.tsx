import {
  DEFAULT_COLUMN_WIDTHS,
  loadColumnWidths,
  persistColumnWidths,
  widthsToGridTemplate,
  MIN_COLUMN_WIDTH,
  EventExplorerTable,
} from './EventExplorerTable';
import { render, fireEvent, screen } from '@testing-library/react';
import type { BlockchainEvent } from '../types/event';

const STORAGE_KEY = 'notify-chain-event-table-widths';

const sampleEvent: BlockchainEvent = {
  eventId: 'evt-1',
  contractAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ',
  eventName: 'Transfer',
  type: 'contract',
  ledger: 123,
  topic: ['Transfer'],
  value: '{}',
  txHash: 'abc123',
  receivedAt: Date.now(),
};

describe('EventExplorerTable column resizing helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads default widths when nothing is persisted', () => {
    expect(loadColumnWidths()).toEqual([...DEFAULT_COLUMN_WIDTHS]);
  });

  it('persists and restores column widths', () => {
    const widths = [240, 180, 120, 200, 110, 170];

    persistColumnWidths(widths);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(widths);
    expect(loadColumnWidths()).toEqual(widths);
  });

  it('rejects corrupt persisted values and falls back to defaults', () => {
    localStorage.setItem(STORAGE_KEY, '{"bad":true}');

    expect(loadColumnWidths()).toEqual([...DEFAULT_COLUMN_WIDTHS]);

    localStorage.setItem(STORAGE_KEY, JSON.stringify([10, 20]));

    expect(loadColumnWidths()).toEqual([...DEFAULT_COLUMN_WIDTHS]);
  });

  it('clamps widths below the minimum when loading', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([40, 180, 120, 200, 110, 170]),
    );

    const loaded = loadColumnWidths();

    expect(loaded[0]).toBe(DEFAULT_COLUMN_WIDTHS[0]);
    expect(loaded[0]).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
  });

  it('builds a stable grid template from widths', () => {
    expect(widthsToGridTemplate([100, 120, 80])).toBe(
      '100px 120px 80px',
    );
  });
});

describe('EventExplorerTable resizing UI', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders resize handles and keeps layout stable while resizing', () => {
    const { getByLabelText, container } = render(
      <EventExplorerTable
        events={[sampleEvent]}
        contractStatuses={[]}
      />,
    );

    const handle = getByLabelText('Resize Contract column');

    expect(handle).toBeInTheDocument();

    const header = container.querySelector(
      '.event-explorer__table-header',
    ) as HTMLElement;

    const before = header.style.gridTemplateColumns;

    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 260 });
    fireEvent.mouseUp(window);

    const after = header.style.gridTemplateColumns;

    expect(after).not.toBe(before);
    expect(after.split(' ').length).toBe(DEFAULT_COLUMN_WIDTHS.length);
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();
  });

  it('renders invalid event timestamps without throwing', () => {
    render(
      <EventExplorerTable
        events={[{ ...sampleEvent, receivedAt: NaN }]}
        contractStatuses={[]}
      />,
    );

    expect(screen.getByText('Unknown time')).toBeInTheDocument();

    expect(
      screen.getByText('Unknown time').closest('time'),
    ).not.toHaveAttribute('dateTime');
  });
});