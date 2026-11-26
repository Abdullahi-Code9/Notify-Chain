import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NotificationDestinationsPage } from './NotificationDestinationsPage';
import {
  DestinationApiError,
  createHttpDestinationsClient,
  type DestinationsClient,
} from '../services/destinationsApi';
import type { DestinationUpdate, NotificationDestination } from '../types/destination';
import { maskSecret, validateDestination } from '../utils/destinationValidation';

const STORED_SECRET_TAIL = 'f00d';

function makeDestinations(): NotificationDestination[] {
  return [
    {
      id: 'webhook-main',
      provider: 'webhook',
      displayName: 'Primary webhook',
      enabled: true,
      status: 'connected',
      settings: { url: 'https://example.com/hook' },
      secrets: { signingSecret: { isSet: true, last4: STORED_SECRET_TAIL } },
      lastError: null,
      lastTestedAt: null,
    },
    {
      id: 'discord-ops',
      provider: 'discord',
      displayName: 'Ops Discord',
      enabled: true,
      status: 'error',
      settings: {},
      secrets: { webhookUrl: { isSet: true } },
      lastError: 'Discord rejected the webhook (HTTP 401).',
    },
    {
      id: 'email',
      provider: 'email',
      displayName: 'Email',
      enabled: false,
      status: 'not_configured',
      settings: {},
      secrets: { apiKey: { isSet: false } },
    },
  ];
}

function makeClient(overrides: Partial<DestinationsClient> = {}): jest.Mocked<DestinationsClient> {
  return {
    list: jest.fn(async () => makeDestinations()),
    update: jest.fn(async (id: string, update: DestinationUpdate) => ({
      ...makeDestinations().find((d) => d.id === id)!,
      enabled: update.enabled,
      settings: update.settings,
    })),
    sendTest: jest.fn(async () => ({ success: true, message: 'Delivered', latencyMs: 42 })),
    ...overrides,
  } as jest.Mocked<DestinationsClient>;
}

async function renderPage(client = makeClient()) {
  render(<NotificationDestinationsPage client={client} />);
  await screen.findByRole('heading', { name: 'Primary webhook' });
  return client;
}

function card(name: string) {
  return screen.getByRole('region', { name });
}

describe('NotificationDestinationsPage (#1107)', () => {
  it('lists every provider with its connection status', async () => {
    await renderPage();
    expect(within(card('Primary webhook')).getByText('Connected')).toBeInTheDocument();
    expect(within(card('Ops Discord')).getByText('Configuration error')).toBeInTheDocument();
    expect(within(card('Email')).getByText('Not configured')).toBeInTheDocument();
  });

  it('surfaces configuration errors reported by the listener', async () => {
    await renderPage();
    expect(within(card('Ops Discord')).getByRole('alert')).toHaveTextContent(
      'Discord rejected the webhook (HTTP 401).',
    );
  });

  it('masks stored secrets and never pre-fills secret inputs', async () => {
    await renderPage();
    const webhook = card('Primary webhook');
    expect(within(webhook).getByTestId('secret-webhook-main-signingSecret')).toHaveTextContent(
      `••••••••${STORED_SECRET_TAIL}`,
    );
    const secretInput = within(webhook).getByLabelText('Signing secret') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    expect(secretInput.value).toBe('');
  });

  it('submits only replaced secrets and clears them after saving', async () => {
    const client = await renderPage();
    const webhook = card('Primary webhook');
    const secretInput = within(webhook).getByLabelText('Signing secret') as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: 'brand-new-secret-value' } });
    fireEvent.click(within(webhook).getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
    expect(client.update).toHaveBeenCalledWith('webhook-main', {
      enabled: true,
      settings: { url: 'https://example.com/hook' },
      secrets: { signingSecret: 'brand-new-secret-value' },
    });
    await waitFor(() => expect(secretInput.value).toBe(''));
    expect(within(webhook).getByRole('status')).toHaveTextContent('Settings saved.');
  });

  it('omits secrets from the update when none were replaced', async () => {
    const client = await renderPage();
    fireEvent.click(within(card('Primary webhook')).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(client.update).toHaveBeenCalled());
    expect(client.update.mock.calls[0][1]).not.toHaveProperty('secrets');
  });

  it('shows client-side validation errors and does not submit', async () => {
    const client = await renderPage();
    const webhook = card('Primary webhook');
    fireEvent.change(within(webhook).getByLabelText('Endpoint URL'), {
      target: { value: 'http://insecure.example.com' },
    });
    fireEvent.click(within(webhook).getByRole('button', { name: 'Save settings' }));

    expect(await within(webhook).findByText('Must be an HTTPS URL.')).toBeInTheDocument();
    expect(client.update).not.toHaveBeenCalled();
  });

  it('shows server-side field errors', async () => {
    const client = makeClient({
      update: jest.fn(async () => {
        throw new DestinationApiError('Validation failed', 422, { url: 'Host is not reachable.' });
      }),
    });
    await renderPage(client);
    const webhook = card('Primary webhook');
    fireEvent.click(within(webhook).getByRole('button', { name: 'Save settings' }));

    expect(await within(webhook).findByText('Host is not reachable.')).toBeInTheDocument();
    expect(within(webhook).getByText('Validation failed')).toBeInTheDocument();
  });

  it('reports test notification success', async () => {
    const client = await renderPage();
    const webhook = card('Primary webhook');
    fireEvent.click(within(webhook).getByRole('button', { name: 'Send test notification' }));

    expect(await within(webhook).findByText(/Test notification delivered: Delivered \(42 ms\)/)).toBeInTheDocument();
    expect(client.sendTest).toHaveBeenCalledWith('webhook-main');
  });

  it('reports test notification failure', async () => {
    const client = makeClient({
      sendTest: jest.fn(async () => ({ success: false, message: 'Endpoint returned HTTP 500' })),
    });
    await renderPage(client);
    const webhook = card('Primary webhook');
    fireEvent.click(within(webhook).getByRole('button', { name: 'Send test notification' }));

    expect(
      await within(webhook).findByText(/Test notification failed: Endpoint returned HTTP 500/),
    ).toBeInTheDocument();
  });

  it('reports a transport failure during a test as a failure', async () => {
    const client = makeClient({
      sendTest: jest.fn(async () => {
        throw new DestinationApiError('Unable to reach the listener API. Check that it is running.');
      }),
    });
    await renderPage(client);
    const webhook = card('Primary webhook');
    fireEvent.click(within(webhook).getByRole('button', { name: 'Send test notification' }));

    expect(await within(webhook).findByText(/Unable to reach the listener API/)).toBeInTheDocument();
  });

  it('disables test notifications for unconfigured destinations', async () => {
    await renderPage();
    expect(
      within(card('Email')).getByRole('button', { name: 'Send test notification' }),
    ).toBeDisabled();
  });

  it('shows a load error with retry', async () => {
    const list = jest
      .fn()
      .mockRejectedValueOnce(new DestinationApiError('Destination configuration API is not available on the listener (HTTP 404).', 404))
      .mockResolvedValueOnce(makeDestinations());
    render(<NotificationDestinationsPage client={makeClient({ list })} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 404');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Primary webhook' })).toBeInTheDocument();
  });
});

describe('destination validation helpers (#1107)', () => {
  it('masks secrets with a fixed-width mask', () => {
    expect(maskSecret(undefined)).toBe('Not set');
    expect(maskSecret({ isSet: false })).toBe('Not set');
    expect(maskSecret({ isSet: true })).toBe('••••••••');
    expect(maskSecret({ isSet: true, last4: 'abcd' })).toBe('••••••••abcd');
  });

  it('requires secrets only when none is stored', () => {
    expect(
      validateDestination('telegram', true, { chatId: '-1001234567890' }, {}, {}),
    ).toHaveProperty('botToken');
    expect(
      validateDestination(
        'telegram',
        true,
        { chatId: '-1001234567890' },
        {},
        { botToken: { isSet: true } },
      ),
    ).toEqual({});
  });

  it('rejects credentials embedded in URLs', () => {
    const errors = validateDestination(
      'webhook',
      true,
      { url: 'https://user:pass@example.com/hook' },
      {},
      { signingSecret: { isSet: true } },
    );
    expect(errors.url).toMatch(/Credentials must not be embedded/);
  });

  it('skips validation for disabled destinations', () => {
    expect(validateDestination('email', false, {}, {}, {})).toEqual({});
  });

  it('validates email and telegram formats', () => {
    expect(
      validateDestination('email', true, { fromAddress: 'nope' }, { apiKey: 'long-enough-key' }, {}),
    ).toHaveProperty('fromAddress');
    expect(
      validateDestination('telegram', true, { chatId: 'x' }, { botToken: '123456:ABCDEFGH' }, {}),
    ).toHaveProperty('chatId');
  });
});

describe('destination ownership display & HTTP client', () => {
  it('displays owner badge when destination includes ownerId', async () => {
    const owned = makeDestinations().map((d) => ({ ...d, ownerId: 'credential:abc123' }));
    await renderPage(makeClient({ list: jest.fn(async () => owned) }));
    expect(screen.getByTestId('owner-webhook-main')).toHaveTextContent('Owner: credential:abc123');
  });

  it('attaches X-API-Key and supports create/get/remove on HTTP client', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ destinations: [] }),
    })) as unknown as typeof fetch;

    const client = createHttpDestinationsClient('http://localhost:8787', fetchMock, {
      apiKey: 'nck_test_key',
    });

    await client.list();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/destinations',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'nck_test_key' }),
      }),
    );

    await client.create?.({
      provider: 'webhook',
      displayName: 'New Hook',
      settings: { url: 'https://example.com/new' },
      secrets: { signingSecret: 'secret-123456' },
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:8787/api/destinations',
      expect.objectContaining({ method: 'POST' }),
    );

    await client.remove?.('dest-1');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:8787/api/destinations/dest-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
