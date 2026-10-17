import { DigestService, DigestConfig, DigestEvent, DigestSummary } from './digest-service';
import { Translator } from '../i18n';

const digestConfig = (overrides: Partial<DigestConfig> = {}): DigestConfig => ({
  enabled: true,
  intervalMs: 3_600_000,
  maxEventsPerDigest: 100,
  ...overrides,
});

function makeEvent(overrides: Partial<DigestEvent> = {}): DigestEvent {
  return {
    eventId: 'evt-1',
    contractAddress: 'CABC',
    eventName: 'task_created',
    ledger: 42,
    ...overrides,
  };
}

describe('DigestService', () => {
  let emitted: DigestSummary[];

  beforeEach(() => {
    emitted = [];
  });

  it('does not accumulate when digests are disabled', async () => {
    const service = new DigestService({
      config: digestConfig({ enabled: false }),
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    expect(service.enabled).toBe(false);
    expect(await service.recordEvent('user-1', makeEvent())).toBeNull();
    expect(service.getPendingCount('user-1')).toBe(0);
    expect(await service.collectDue(Date.now() + 10_000_000)).toEqual([]);
    expect(emitted).toHaveLength(0);
  });

  it('accumulates events and emits a digest once the interval elapses', async () => {
    let clock = 1_000;
    const service = new DigestService({
      config: digestConfig({ intervalMs: 1_000 }),
      now: () => clock,
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    expect(await service.recordEvent('user-1', makeEvent({ eventId: 'a' }))).toBeNull();
    await service.recordEvent('user-1', makeEvent({ eventId: 'b' }));
    expect(service.getPendingCount('user-1')).toBe(2);

    // Interval not yet elapsed.
    expect(await service.collectDue()).toEqual([]);
    expect(emitted).toHaveLength(0);

    clock += 1_000;
    const summaries = await service.collectDue();

    expect(summaries).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    const digest = emitted[0];
    expect(digest.recipient).toBe('user-1');
    expect(digest.eventCount).toBe(2);
    // Traceability: individual event references survive into the digest.
    expect(digest.eventIds).toEqual(['a', 'b']);
    expect(digest.events.map((e) => e.eventId)).toEqual(['a', 'b']);
    expect(digest.lines).toHaveLength(2);
    // Accumulator is reset after emission.
    expect(service.getPendingCount('user-1')).toBe(0);
  });

  it('flushes immediately when maxEventsPerDigest is reached', async () => {
    const service = new DigestService({
      config: digestConfig({ maxEventsPerDigest: 2, intervalMs: 3_600_000 }),
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    expect(await service.recordEvent('user-1', makeEvent({ eventId: 'a' }))).toBeNull();
    const summary = await service.recordEvent('user-1', makeEvent({ eventId: 'b' }));

    expect(summary).not.toBeNull();
    expect(summary!.eventIds).toEqual(['a', 'b']);
    expect(emitted).toHaveLength(1);
    expect(service.getPendingCount('user-1')).toBe(0);
  });

  it('keeps recipients isolated', async () => {
    let clock = 0;
    const service = new DigestService({
      config: digestConfig({ intervalMs: 1_000 }),
      now: () => clock,
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    await service.recordEvent('user-1', makeEvent({ eventId: 'a' }));
    clock += 600;
    await service.recordEvent('user-2', makeEvent({ eventId: 'b' }));
    clock = 1_000; // user-1 due, user-2 not yet

    await service.collectDue();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].recipient).toBe('user-1');
    expect(service.getPendingCount('user-2')).toBe(1);
  });

  it('supports explicit flush of a single recipient', async () => {
    const service = new DigestService({
      config: digestConfig(),
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    await service.recordEvent('user-1', makeEvent());
    const summary = await service.flush('user-1');

    expect(summary).not.toBeNull();
    expect(emitted).toHaveLength(1);
    // Nothing left to flush.
    expect(await service.flush('user-1')).toBeNull();
  });

  it('renders localized text, with fallback for missing translations', async () => {
    const translator = new Translator({ defaultLocale: 'en' });
    let clock = 0;
    const service = new DigestService({
      config: digestConfig({ intervalMs: 1 }),
      translator,
      now: () => clock,
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    await service.recordEvent('user-1', makeEvent({ eventName: 'ping' }));
    clock += 1;
    await service.collectDue();

    expect(emitted[0].title).toBe('Activity digest');
    expect(emitted[0].text).toContain('1 events');
    expect(emitted[0].lines[0]).toBe('ping · CABC · ledger 42');
  });

  it('starts a sweep that emits interval-based digests', async () => {
    jest.useFakeTimers();
    try {
      let clock = 0;
      const service = new DigestService({
        config: digestConfig({ intervalMs: 1_000 }),
        now: () => clock,
        onDigest: (d) => {
          emitted.push(d);
        },
      });

      await service.recordEvent('user-1', makeEvent());
      service.start();

      clock = 1_000;
      await jest.advanceTimersByTimeAsync(1_000);

      expect(emitted).toHaveLength(1);
      service.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stop() drops buffered events and rejects further records', async () => {
    const service = new DigestService({
      config: digestConfig(),
      onDigest: (d) => {
        emitted.push(d);
      },
    });

    await service.recordEvent('user-1', makeEvent());
    service.stop();

    expect(service.getPendingCount()).toBe(0);
    await expect(service.recordEvent('user-1', makeEvent())).rejects.toThrow(/stopped/);
  });

  describe('summary shape', () => {
    it('exposes interval boundaries and generation timestamp', async () => {
      let clock = 5_000;
      const service = new DigestService({
        config: digestConfig({ intervalMs: 1_000 }),
        now: () => clock,
        onDigest: () => undefined,
      });

      await service.recordEvent('user-1', makeEvent());
      clock = 6_000;
      const summary = await service.flush('user-1');

      expect(summary!.intervalStart).toBe(new Date(5_000).toISOString());
      expect(summary!.intervalEnd).toBe(new Date(6_000).toISOString());
      expect(summary!.generatedAt).toBe(new Date(6_000).toISOString());
    });
  });
});
