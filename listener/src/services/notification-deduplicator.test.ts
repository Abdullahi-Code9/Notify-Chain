import { NotificationDeduplicator, generateFingerprint } from './notification-deduplicator';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

describe('generateFingerprint', () => {
  it('combines contractAddress and eventId', () => {
    const fp = generateFingerprint('event-42', 'CABC123');
    expect(fp).toBe('CABC123:event-42');
  });

  it('produces different fingerprints for different event ids', () => {
    const fp1 = generateFingerprint('event-1', 'CABC123');
    const fp2 = generateFingerprint('event-2', 'CABC123');
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprints for different contract addresses', () => {
    const fp1 = generateFingerprint('event-1', 'CABC123');
    const fp2 = generateFingerprint('event-1', 'CXYZ999');
    expect(fp1).not.toBe(fp2);
  });
});

describe('NotificationDeduplicator', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('isDuplicate', () => {
    it('returns false for a fingerprint that has not been seen', () => {
      const d = new NotificationDeduplicator();
      expect(d.isDuplicate('CONTRACT:event-1')).toBe(false);
    });

    it('returns true for a fingerprint that has been marked sent', () => {
      const d = new NotificationDeduplicator();
      d.markSent('CONTRACT:event-1');
      expect(d.isDuplicate('CONTRACT:event-1')).toBe(true);
    });

    it('returns false for a different fingerprint after another is marked sent', () => {
      const d = new NotificationDeduplicator();
      d.markSent('CONTRACT:event-1');
      expect(d.isDuplicate('CONTRACT:event-2')).toBe(false);
    });
  });

  describe('markSent', () => {
    it('increments size after marking a new fingerprint', () => {
      const d = new NotificationDeduplicator();
      d.markSent('CONTRACT:event-1');
      expect(d.size()).toBe(1);
    });

    it('does not increment size when marking the same fingerprint twice', () => {
      const d = new NotificationDeduplicator();
      d.markSent('CONTRACT:event-1');
      d.markSent('CONTRACT:event-1');
      expect(d.size()).toBe(1);
    });

    it('evicts the oldest entry when the cache is full', () => {
      const d = new NotificationDeduplicator(3);
      d.markSent('fp-1');
      d.markSent('fp-2');
      d.markSent('fp-3');

      d.markSent('fp-4');

      expect(d.size()).toBe(3);
      expect(d.isDuplicate('fp-1')).toBe(false);
      expect(d.isDuplicate('fp-2')).toBe(true);
      expect(d.isDuplicate('fp-3')).toBe(true);
      expect(d.isDuplicate('fp-4')).toBe(true);
    });

    it('logs a warning when evicting due to full cache', () => {
      const d = new NotificationDeduplicator(2);
      d.markSent('fp-1');
      d.markSent('fp-2');
      d.markSent('fp-3');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Notification deduplicator cache full, evicted oldest entry',
        expect.objectContaining({ evicted: 'fp-1', cacheSize: 2 })
      );
    });

    it('does not evict when cache has room', () => {
      const d = new NotificationDeduplicator(5);
      d.markSent('fp-1');
      d.markSent('fp-2');

      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(d.size()).toBe(2);
    });
  });


  describe('time window and metrics', () => {
    it('allows the same fingerprint after the deduplication window expires', () => {
      let now = 1000;
      const d = new NotificationDeduplicator({ windowMs: 500, now: () => now });

      d.markSent('CONTRACT:event-windowed');
      expect(d.isDuplicate('CONTRACT:event-windowed')).toBe(true);

      now = 1501;
      expect(d.isDuplicate('CONTRACT:event-windowed')).toBe(false);
      expect(d.size()).toBe(0);
    });

    it('reports skipped duplicate metrics accurately', () => {
      const d = new NotificationDeduplicator({ windowMs: 1000 });

      d.markSent('CONTRACT:event-1');
      d.markSent('CONTRACT:event-2');
      d.isDuplicate('CONTRACT:event-1');
      d.isDuplicate('CONTRACT:event-1');
      d.isDuplicate('CONTRACT:event-new');

      expect(d.getMetrics()).toEqual({
        acceptedRequests: 2,
        skippedDuplicates: 2,
        evictedEntries: 0,
        expiredEntries: 0,
        cacheSize: 2,
        deduplicationWindowMs: 1000,
      });
    });

    it('counts evicted and expired entries in metrics', () => {
      let now = 0;
      const d = new NotificationDeduplicator({ maxSize: 2, windowMs: 100, now: () => now });

      d.markSent('fp-1');
      d.markSent('fp-2');
      d.markSent('fp-3');
      now = 101;
      d.size();

      expect(d.getMetrics()).toEqual(
        expect.objectContaining({
          evictedEntries: 1,
          expiredEntries: 2,
          cacheSize: 0,
        })
      );
    });
  });

  describe('size', () => {
    it('returns 0 for a new deduplicator', () => {
      expect(new NotificationDeduplicator().size()).toBe(0);
    });

    it('returns the correct count after multiple unique fingerprints', () => {
      const d = new NotificationDeduplicator();
      d.markSent('fp-1');
      d.markSent('fp-2');
      d.markSent('fp-3');
      expect(d.size()).toBe(3);
    });
  });

  describe('duplicate prevention across repeated events', () => {
    it('prevents a second notification for the same event on re-poll', () => {
      const d = new NotificationDeduplicator();
      const fp = generateFingerprint('event-99', 'CONTRACT-A');

      d.markSent(fp);

      expect(d.isDuplicate(fp)).toBe(true);
    });

    it('allows notifications for unique events with the same contract', () => {
      const d = new NotificationDeduplicator();
      d.markSent(generateFingerprint('event-1', 'CONTRACT-A'));
      d.markSent(generateFingerprint('event-2', 'CONTRACT-A'));

      expect(d.isDuplicate(generateFingerprint('event-3', 'CONTRACT-A'))).toBe(false);
    });

    it('treats same event id on different contracts as distinct', () => {
      const d = new NotificationDeduplicator();
      d.markSent(generateFingerprint('event-1', 'CONTRACT-A'));

      expect(d.isDuplicate(generateFingerprint('event-1', 'CONTRACT-B'))).toBe(false);
    });
  });
});

