import { sendWebhook, DnsRebindingError } from './webhook-sender';
import { DnsResolver } from './dns-rebinding-guard';

function resolverFor(values: Record<string, string[]>): DnsResolver {
  return {
    resolve4: async (hostname) => values[hostname] ?? ['93.184.216.34'],
    resolve6: async () => [],
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('webhook DNS rebinding and redirect guard (#1206)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('blocks a private original destination before connecting', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://private.example/hook', {}, {
        dnsResolver: resolverFor({ 'private.example': ['10.0.0.5'] }),
      }),
    ).rejects.toBeInstanceOf(DnsRebindingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates redirect targets independently and blocks private ones', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirect('https://private.example/hook'));
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://public.example/hook', {}, {
        dnsResolver: resolverFor({ 'private.example': ['127.0.0.1'] }),
      }),
    ).rejects.toBeInstanceOf(DnsRebindingError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('blocks a DNS change that turns a redirect target private', async () => {
    const resolve4 = jest
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['169.254.169.254']);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirect('https://changed.example/hook'));
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://public.example/hook', {}, {
        dnsResolver: { resolve4, resolve6: async () => [] },
      }),
    ).rejects.toBeInstanceOf(DnsRebindingError);

    expect(resolve4).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a validated redirect and keeps public destinations supported', async () => {
    const ok = new Response('{"ok":true}', { status: 200 });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirect('https://second.example/hook'))
      .mockResolvedValueOnce(ok);
    global.fetch = fetchMock as any;

    const result = await sendWebhook('https://public.example/hook', { n: 1 }, {
      dnsResolver: resolverFor({}),
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://second.example/hook');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      redirect: 'manual',
      method: 'POST',
    });
  });
});
