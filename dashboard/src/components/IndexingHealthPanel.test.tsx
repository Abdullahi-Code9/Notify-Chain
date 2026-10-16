import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { IndexingHealthPanel } from './IndexingHealthPanel';

function mockFetchOnce(payload: unknown) {
  const fetchMock = global.fetch as unknown as jest.Mock;
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => payload,
  });
}

describe('IndexingHealthPanel', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    (global.fetch as unknown as jest.Mock).mockReset();
  });

  it('renders the synced state with core metrics', async () => {
    mockFetchOnce({
      status: 'synced',
      timestamp: '2026-01-01T00:00:00.000Z',
      indexedLedger: 100,
      networkTipLedger: 100,
      ledgerLag: 0,
      processingDelayMs: 10_000,
      lastIngestedAt: '2026-01-01T00:00:00.000Z',
    });

    render(
      <IndexingHealthPanel
        healthUrl="http://localhost:8787/api/indexing/health"
        pollIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText('Indexing Health')).toBeInTheDocument();
    expect(await screen.findByText('Synced')).toBeInTheDocument();
    expect(await screen.findByText('100 / 100')).toBeInTheDocument();
    expect(await screen.findByText('0 block(s)')).toBeInTheDocument();
    expect(await screen.findByText('10s')).toBeInTheDocument();
  });

  it('renders the degraded state for lagging indexers', async () => {
    mockFetchOnce({
      status: 'degraded',
      timestamp: '2026-01-01T00:00:00.000Z',
      indexedLedger: 80,
      networkTipLedger: 100,
      ledgerLag: 20,
      processingDelayMs: 300_000,
      detail: 'Behind by 20 ledger(s).',
    });

    render(
      <IndexingHealthPanel
        healthUrl="http://localhost:8787/api/indexing/health"
        pollIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(await screen.findByText('80 / 100')).toBeInTheDocument();
    expect(await screen.findByText('20 block(s)')).toBeInTheDocument();
    expect(await screen.findByText('5m 0s')).toBeInTheDocument();
    expect(await screen.findByText('Behind by 20 ledger(s).')).toBeInTheDocument();
  });
});
