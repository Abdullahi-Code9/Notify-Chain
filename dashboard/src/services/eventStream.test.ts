import { openEventStream, toEventStreamUrl } from './eventStream';
import type { BlockchainEvent } from '../types/event';

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

describe('event stream client', () => {
  it('maps the events URL onto the stream endpoint', () => {
    expect(toEventStreamUrl('http://localhost:8787/api/events')).toBe(
      'http://localhost:8787/api/events/stream',
    );
    expect(toEventStreamUrl('http://localhost:8787/api/events/history')).toBeNull();
  });

  it('delivers notification records and closes on cleanup', () => {
    const received: BlockchainEvent[] = [];
    const stop = openEventStream(
      'http://localhost:8787/api/events/stream',
      { onEvent: (event) => received.push(event), onFallback: () => undefined },
      FakeEventSource as unknown as new (url: string) => FakeEventSource,
    );

    FakeEventSource.latest?.onopen?.(new Event('open'));
    FakeEventSource.latest?.emit(
      'notification',
      JSON.stringify({
        eventId: 'evt-1',
        contractAddress: 'CABC',
        eventName: 'notification_scheduled',
        ledger: 1,
        type: 'contract',
        topic: [],
        value: '{}',
        receivedAt: 1,
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.notificationStatus).toBe('active');

    stop();
    expect(FakeEventSource.latest?.closed).toBe(true);
  });

  it('falls back when the first connection fails and does not fall back after a successful open', () => {
    const fallback = jest.fn();
    openEventStream(
      'http://localhost:8787/api/events/stream',
      { onEvent: () => undefined, onFallback: fallback },
      FakeEventSource as unknown as new (url: string) => FakeEventSource,
    );

    FakeEventSource.latest?.onerror?.(new Event('error'));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.latest?.closed).toBe(true);

    fallback.mockClear();
    openEventStream(
      'http://localhost:8787/api/events/stream',
      { onEvent: () => undefined, onFallback: fallback },
      FakeEventSource as unknown as new (url: string) => FakeEventSource,
    );
    FakeEventSource.latest?.onopen?.(new Event('open'));
    FakeEventSource.latest?.onerror?.(new Event('error'));
    expect(fallback).not.toHaveBeenCalled();
  });
});
