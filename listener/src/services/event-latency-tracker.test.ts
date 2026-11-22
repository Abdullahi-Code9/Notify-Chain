import {
  EVENT_STAGES,
  EventLatencyStore,
  StageTimer,
  parseStageTimings,
} from './event-latency-tracker';

function fakeClock(...ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

describe('StageTimer (#1120)', () => {
  it('measures each stage independently', () => {
    const timer = new StageTimer(fakeClock(0, 5, 10, 30));
    timer.start('decodeValidation');
    timer.end('decodeValidation');
    timer.start('persistence');
    timer.end('persistence');
    expect(timer.snapshot()).toEqual({ decodeValidation: 5, persistence: 20 });
  });

  it('accumulates repeated measurements of the same stage', () => {
    const timer = new StageTimer(fakeClock(0, 2, 10, 13));
    timer.start('persistence');
    timer.end('persistence');
    timer.start('persistence');
    timer.end('persistence');
    timer.add('persistence', 1);
    expect(timer.snapshot().persistence).toBe(6);
  });

  it('ignores end without start and invalid external durations', () => {
    const timer = new StageTimer(fakeClock(0));
    timer.end('retrieval');
    timer.add('retrieval', undefined);
    timer.add('retrieval', -1);
    timer.add('retrieval', Number.NaN);
    expect(timer.snapshot()).toEqual({});
  });

  it('records a duration even when the measured work throws', async () => {
    const timer = new StageTimer(fakeClock(0, 7));
    await expect(
      timer.measure('notificationPrep', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(timer.snapshot().notificationPrep).toBe(7);
  });
});

describe('EventLatencyStore (#1120)', () => {
  it('reports missing stages instead of failing', () => {
    const store = new EventLatencyStore();
    const record = store.record({
      eventId: 'e1',
      contractAddress: 'CA',
      outcome: 'processed',
      stages: { retrieval: 3, persistence: 2 },
      recordedAt: 1,
    });
    expect(record.missingStages).toEqual(['decodeValidation', 'notificationPrep']);
    expect(record.totalMs).toBe(5);
  });

  it('tolerates absent timing data and non-string identifiers', () => {
    const store = new EventLatencyStore();
    const record = store.record({ eventId: 42, contractAddress: undefined, outcome: 'error', stages: null });
    expect(record.eventId).toBe('');
    expect(record.missingStages).toEqual([...EVENT_STAGES]);
    expect(record.totalMs).toBeNull();
  });

  it('never stores fields other than identifiers and durations', () => {
    const store = new EventLatencyStore();
    store.record({
      eventId: 'e1',
      contractAddress: 'CA',
      outcome: 'processed',
      stages: { retrieval: 1, topic: 'secret', value: 'secret' } as any,
    });
    expect(JSON.stringify(store.list())).not.toContain('secret');
  });

  it('is bounded and lists most recent first', () => {
    const store = new EventLatencyStore(2);
    for (const id of ['a', 'b', 'c']) {
      store.record({ eventId: id, contractAddress: 'CA', outcome: 'processed', stages: {} });
    }
    expect(store.list(10).map((r) => r.eventId)).toEqual(['c', 'b']);
    expect(store.find('a')).toBeUndefined();
    expect(store.find('b', 'CA')?.eventId).toBe('b');
    expect(store.find('b', 'OTHER')).toBeUndefined();
  });

  it('summarises per stage with missing counts', () => {
    const store = new EventLatencyStore();
    store.record({ eventId: 'a', contractAddress: 'CA', outcome: 'processed', stages: { retrieval: 10 } });
    store.record({ eventId: 'b', contractAddress: 'CA', outcome: 'processed', stages: { retrieval: 20 } });
    const summary = store.summary();
    expect(summary.sampleSize).toBe(2);
    expect(summary.stages.retrieval).toMatchObject({ count: 2, missing: 0, avgMs: 15, maxMs: 20 });
    expect(summary.stages.persistence).toMatchObject({ count: 0, missing: 2, avgMs: null });
  });
});

describe('parseStageTimings', () => {
  it.each([undefined, null, '', '   ', 'not json', '42'])('returns null for %p', (raw) => {
    expect(parseStageTimings(raw)).toBeNull();
  });

  it('keeps only valid known stages', () => {
    expect(parseStageTimings('{"retrieval":1,"persistence":-1,"other":3}')).toEqual({ retrieval: 1 });
  });
});
