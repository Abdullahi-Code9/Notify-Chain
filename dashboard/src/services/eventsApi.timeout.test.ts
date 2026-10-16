import { fetchEvents, searchNotifications } from './eventsApi';

describe('listener API request timeouts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(globalThis, 'fetch', {
      writable: true,
      configurable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects fetchEvents when the listener API takes too long to respond', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                const abortError = new Error('The operation was aborted.');
                Object.assign(abortError, { name: 'AbortError' });
                reject(abortError);
              },
              { once: true }
            );
          }

          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ events: [] }),
            } as Response);
          }, 30_000);
        })
    );

    const request = expect(fetchEvents('http://localhost:8787/api/events')).rejects.toThrow(/timed out/i);

    await jest.advanceTimersByTimeAsync(10_001);

    await request;
  });

  it('rejects searchNotifications when the request exceeds the dashboard timeout', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                const abortError = new Error('The operation was aborted.');
                Object.assign(abortError, { name: 'AbortError' });
                reject(abortError);
              },
              { once: true }
            );
          }

          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ results: [], total: 0, limit: 20, offset: 0, itemCount: 0, totalPages: 0 }),
            } as Response);
          }, 30_000);
        })
    );

    const request = expect(searchNotifications('http://localhost:8787', { q: 'hello' })).rejects.toThrow(/timed out/i);

    await jest.advanceTimersByTimeAsync(10_001);

    await request;
  });
});
