import http from 'http';
import { DisplayEvent } from '../types/display-event';
import { EventRegistry } from '../store/event-registry';
import { handleEventStream, formatSseEvent } from './event-stream';

function event(eventId: string, ledger = 1): DisplayEvent {
  return {
    eventId,
    contractAddress: 'CABC',
    eventName: 'TaskCreated',
    ledger,
    type: 'contract',
    topic: ['TaskCreated'],
    value: '1',
    txHash: `hash-${eventId}`,
    receivedAt: ledger,
  };
}

/** Minimal registry so this test does not load the Stellar SDK mock. */
function fakeRegistry(initial: DisplayEvent[] = []) {
  const events = [...initial];
  const listeners = new Set<(item: DisplayEvent) => void>();
  const registry = {
    getEvents: () => events.slice(),
    subscribe(listener: (item: DisplayEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(item: DisplayEvent) {
      events.push(item);
      for (const listener of listeners) listener(item);
    },
  };
  return registry;
}

function mockResponse() {
  const chunks: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  return {
    statusCode: 0,
    chunks,
    setHeader: jest.fn(),
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    on: (name: string, cb: () => void) => {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
    },
    emit(name: string) {
      for (const cb of listeners.get(name) ?? []) cb();
    },
  };
}

function mockRequest(headers: http.IncomingHttpHeaders = {}) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    headers,
    on: (name: string, cb: () => void) => {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
    },
    emit(name: string) {
      for (const cb of listeners.get(name) ?? []) cb();
    },
  };
}

describe('event stream', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes new events in the documented SSE format', () => {
    const registry = fakeRegistry();
    const req = mockRequest();
    const res = mockResponse();

    handleEventStream(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      registry as unknown as EventRegistry,
      { heartbeatMs: 1000 },
    );

    const stored = event('evt-1', 10);
    registry.add(stored);

    expect(res.chunks.join('')).toBe(formatSseEvent(stored));
    expect(res.chunks.join('')).toContain('id: CABC:evt-1\n');
    expect(res.chunks.join('')).toContain('event: notification\n');
    expect(res.chunks.join('')).toContain('"eventId":"evt-1"');
  });

  it('replays events after Last-Event-ID and skips the one already seen', () => {
    const registry = fakeRegistry([event('evt-1', 1), event('evt-2', 2)]);
    const req = mockRequest({ 'last-event-id': 'CABC:evt-1' });
    const res = mockResponse();

    handleEventStream(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      registry as unknown as EventRegistry,
    );

    expect(res.chunks).toEqual([formatSseEvent(event('evt-2', 2))]);
  });

  it('sends keepalive comments and drops the subscriber when the client leaves', () => {
    const registry = fakeRegistry();
    const req = mockRequest();
    const res = mockResponse();
    handleEventStream(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      registry as unknown as EventRegistry,
      { heartbeatMs: 5000 },
    );

    jest.advanceTimersByTime(5000);
    expect(res.chunks).toContain(': keepalive\n\n');

    req.emit('close');
    const before = res.chunks.length;
    registry.add(event('evt-after-close'));
    jest.advanceTimersByTime(5000);

    expect(res.chunks).toHaveLength(before);
  });
});
