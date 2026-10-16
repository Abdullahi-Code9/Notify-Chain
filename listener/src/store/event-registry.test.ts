import { xdr } from '@stellar/stellar-sdk';
import { EventRegistry } from './event-registry';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import logger from '../utils/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('EventRegistry', () => {
  it('stores and returns display events from registry input', () => {
    const registry = new EventRegistry(5);

    registry.addFromInput({
      eventId: 'evt-1',
      contractAddress: 'CABC',
      eventName: 'TaskCreated',
      ledger: 100,
      type: 'contract',
      topic: [xdr.ScVal.scvSymbol('TaskCreated')],
      value: xdr.ScVal.scvU32(42),
      txHash: 'hash-1',
    });

    const events = registry.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt-1',
      contractAddress: 'CABC',
      eventName: 'TaskCreated',
      ledger: 100,
      type: 'contract',
      txHash: 'hash-1',
    });
    expect(events[0].topic).toEqual(['TaskCreated']);
    expect(events[0].value).toBe('42');
  });

  it('derives eventName from topic when eventName is missing', () => {
    const registry = new EventRegistry(5);

    registry.addFromInput({
      eventId: 'evt-2',
      contractAddress: 'CABC',
      eventName: null,
      ledger: 101,
      type: 'contract',
      topic: [xdr.ScVal.scvSymbol('WorkSubmitted')],
      value: xdr.ScVal.scvU32(7),
    });

    expect(registry.getEvents()[0].eventName).toBe('WorkSubmitted');
  });

  it('caps stored events at maxEvents', () => {
    const registry = new EventRegistry(3);

    for (let i = 0; i < 5; i++) {
      registry.addFromInput({
        eventId: `evt-${i}`,
        contractAddress: 'CABC',
        eventName: null,
        ledger: i,
        type: 'contract',
        topic: [],
        value: xdr.ScVal.scvU32(i),
      });
    }

    const events = registry.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0].eventId).toBe('evt-2');
    expect(events[2].eventId).toBe('evt-4');
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'Event registry at capacity, evicting oldest events',
      expect.objectContaining({ maxEvents: 3, evicted: 1 }),
    );
    expect(mockedLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not add the same event more than once during retention', () => {
    const registry = new EventRegistry(5);
    const input = {
      eventId: 'evt-duplicate',
      contractAddress: 'CABC',
      eventName: 'TaskCreated',
      ledger: 100,
      type: 'contract',
      topic: [xdr.ScVal.scvSymbol('TaskCreated')],
      value: xdr.ScVal.scvU32(42),
    };

    const first = registry.addFromInput(input);
    const second = registry.addFromInput({ ...input, ledger: 101 });

    expect(second).toBe(first);
    expect(registry.count()).toBe(1);
    expect(registry.has('evt-duplicate', 'CABC')).toBe(true);
    expect(registry.getEvents()[0].ledger).toBe(100);
  });

  it('keeps memory bounded during sustained event processing', () => {
    const registry = new EventRegistry(1000);

    for (let i = 0; i < 50_000; i++) {
      registry.addFromInput({
        eventId: `evt-${i}`,
        contractAddress: 'CABC',
        eventName: null,
        ledger: i,
        type: 'contract',
        topic: [],
        value: xdr.ScVal.scvU32(i),
      });
    }

    expect(registry.count()).toBe(1000);
    expect(registry.has('evt-49999', 'CABC')).toBe(true);
    expect(registry.has('evt-0', 'CABC')).toBe(false);
  });

  it('returns events whose ledger falls inside an inclusive range', () => {
    const registry = new EventRegistry(10);

    for (const ledger of [10, 20, 30]) {
      registry.addFromInput({
        eventId: `evt-${ledger}`,
        contractAddress: 'CABC',
        eventName: 'TaskCreated',
        ledger,
        type: 'contract',
        topic: [xdr.ScVal.scvSymbol('TaskCreated')],
        value: xdr.ScVal.scvU32(ledger),
      });
    }

    expect(registry.getEventsByLedgerRange(20, 30).map((event) => event.ledger)).toEqual([20, 30]);
  });
});
