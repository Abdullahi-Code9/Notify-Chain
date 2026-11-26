import { MAX_WEBHOOK_REDIRECTS, sendWebhook } from './webhook-sender';

const publicDnsResolver = {
  resolve4: jest.fn().mockResolvedValue(['93.184.216.34']),
  resolve6: jest.fn().mockResolvedValue([]),
};

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('sendWebhook SSRF redirect protection (#1205)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('follows redirects only after revalidating the new destination', async () => {
    const ok = new Response('ok', { status: 200 });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://other.example.com/hook'))
      .mockResolvedValueOnce(ok);
    global.fetch = fetchMock as any;

    const result = await sendWebhook('https://example.com/hook', { a: 1 }, {
      dnsResolver: publicDnsResolver,
    });

    expect(result).toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://other.example.com/hook');
  });

  it('blocks redirects to private IP literals', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://127.0.0.1/admin'));
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://example.com/hook', {}, { dnsResolver: publicDnsResolver }),
    ).rejects.toThrow(/UnsafeNotificationUrlError|blocked range/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks redirects that switch to an unsupported scheme', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('file:///etc/passwd'));
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://example.com/hook', {}, { dnsResolver: publicDnsResolver }),
    ).rejects.toThrow(/Unsupported/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces a redirect limit', async () => {
    const fetchMock = jest.fn().mockResolvedValue(redirectResponse('https://loop.example/h'));
    global.fetch = fetchMock as any;

    await expect(
      sendWebhook('https://example.com/hook', {}, { dnsResolver: publicDnsResolver }),
    ).rejects.toThrow(/Too many webhook redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_WEBHOOK_REDIRECTS + 1);
  });
});
