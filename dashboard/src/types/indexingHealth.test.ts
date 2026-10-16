import { parseIndexingHealth } from './indexingHealth';

describe('parseIndexingHealth', () => {
  it('parses numeric fields and timestamps defensively', () => {
    const parsed = parseIndexingHealth({
      status: 'synced',
      timestamp: '2026-01-01T00:00:00.000Z',
      indexedLedger: '123',
      networkTipLedger: 124,
      ledgerLag: '1',
      processingDelayMs: '2500',
      lastIngestedAt: '2026-01-01T00:00:02.500Z',
      detail: 'ok',
    });

    expect(parsed.status).toBe('synced');
    expect(parsed.indexedLedger).toBe(123);
    expect(parsed.networkTipLedger).toBe(124);
    expect(parsed.ledgerLag).toBe(1);
    expect(parsed.processingDelayMs).toBe(2500);
    expect(parsed.lastIngestedAtMs).toBe(Date.parse('2026-01-01T00:00:02.500Z'));
    expect(parsed.detail).toBe('ok');
  });

  it('falls back to degraded for unknown status', () => {
    const parsed = parseIndexingHealth({ status: 'UNKNOWN_STATUS' });
    expect(parsed.status).toBe('degraded');
  });
});
