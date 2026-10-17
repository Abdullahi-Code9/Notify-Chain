import {
  EventBatcher,
  EventBatchingConfig,
  BatchedEventGroup,
  BatchableEvent,
  defaultGroupKey,
} from './event-batcher';

function makeEvent(overrides: Partial<BatchableEvent> = {}): BatchableEvent {
  return {
    eventId: 'evt-1',
    contractAddress: 'CABC',
    eventName: 'task_created',
    ledger: 100,
    ...overrides,
  };
}

const batchingConfig = (overrides: Partial<EventBatchingConfig> = {}): EventBatchingConfig => ({
  enabled: true,
  maxBatchSize: 3,
  windowMs: 60_000,
  ...overrides,
});

describe('EventBatcher', () => {
  let flushed: BatchedEventGroup[];

  beforeEach(() => {
    flushed = [];
  });

  describe('immediate mode', () => {
    it('delivers each event immediately when batching is disabled', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ enabled: false }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: 'a' }));
      await batcher.add(makeEvent({ eventId: 'b' }));

      expect(flushed).toHaveLength(2);
      expect(flushed.map((b) => b.eventIds)).toEqual([['a'], ['b']]);
      expect(flushed.every((b) => b.batched === false)).toBe(true);
      expect(batcher.pendingCount).toBe(0);
    });

    it('treats a max batch size of 1 as immediate mode', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 1 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      expect(batcher.isImmediateMode).toBe(true);
      await batcher.add(makeEvent({ eventId: 'solo' }));

      expect(flushed).toHaveLength(1);
      expect(flushed[0].eventIds).toEqual(['solo']);
    });
  });

  describe('count-based flushing', () => {
    it('buffers events until the max batch size is reached', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 3 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: '1' }));
      await batcher.add(makeEvent({ eventId: '2' }));
      expect(flushed).toHaveLength(0);
      expect(batcher.pendingCount).toBe(2);

      await batcher.add(makeEvent({ eventId: '3' }));

      expect(flushed).toHaveLength(1);
      expect(flushed[0].eventCount).toBe(3);
      expect(flushed[0].batched).toBe(true);
      // Individual event references remain accessible and ordered.
      expect(flushed[0].eventIds).toEqual(['1', '2', '3']);
      expect(batcher.pendingCount).toBe(0);
    });

    it('keeps separate groups independent', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 2 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: 'a1', eventName: 'a' }));
      await batcher.add(makeEvent({ eventId: 'b1', eventName: 'b' }));
      expect(batcher.pendingCount).toBe(2);

      // Completes the 'a' group only.
      await batcher.add(makeEvent({ eventId: 'a2', eventName: 'a' }));

      expect(flushed).toHaveLength(1);
      expect(flushed[0].groupKey).toBe('CABC:a');
      expect(flushed[0].eventIds).toEqual(['a1', 'a2']);
      expect(batcher.getPendingCount('CABC:b')).toBe(1);
    });

    it('accepts a custom group key', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 1 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent(), 'custom-group');
      expect(flushed[0].groupKey).toBe('custom-group');
    });
  });

  describe('window-based flushing', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('flushes a group when the collection window elapses', async () => {
      jest.useFakeTimers();
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 10, windowMs: 1000 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: 'x' }));
      await batcher.add(makeEvent({ eventId: 'y' }));
      expect(flushed).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(1000);

      expect(flushed).toHaveLength(1);
      expect(flushed[0].eventIds).toEqual(['x', 'y']);
      batcher.stop();
    });

    it('flushDue flushes elapsed windows against an injected clock', async () => {
      let clock = 1_000;
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 10, windowMs: 500 }),
        now: () => clock,
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: 'p' }));
      expect(await batcher.flushDue()).toBe(0);

      clock += 500;
      expect(await batcher.flushDue()).toBe(1);
      expect(flushed[0].eventIds).toEqual(['p']);
      batcher.stop();
    });
  });

  describe('manual flush and lifecycle', () => {
    it('flush emits every pending group and returns the count', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 10 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent({ eventId: '1', eventName: 'a' }));
      await batcher.add(makeEvent({ eventId: '2', eventName: 'b' }));

      expect(await batcher.flush()).toBe(2);
      expect(flushed).toHaveLength(2);
      expect(batcher.pendingCount).toBe(0);
    });

    it('flush of an unknown group emits nothing', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig(),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      expect(await batcher.flush('nope')).toBe(0);
      expect(flushed).toHaveLength(0);
    });

    it('stop() drops buffered events and rejects further adds', async () => {
      const batcher = new EventBatcher({
        config: batchingConfig({ maxBatchSize: 10 }),
        onFlush: (batch) => {
          flushed.push(batch);
        },
      });

      await batcher.add(makeEvent());
      batcher.stop();

      expect(batcher.pendingCount).toBe(0);
      await expect(batcher.add(makeEvent())).rejects.toThrow(/stopped/);
      expect(flushed).toHaveLength(0);
    });
  });

  describe('defaultGroupKey', () => {
    it('combines contract and event name', () => {
      expect(defaultGroupKey({ contractAddress: 'CXYZ', eventName: 'ping' })).toBe('CXYZ:ping');
    });
  });
});
