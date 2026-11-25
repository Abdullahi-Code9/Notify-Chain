/**
 * Tests for per-channel format preferences (feature: per-channel format selection).
 *
 * Acceptance criteria verified here:
 * 1. Each adapter declares a non-empty `supportedFormats` set and a `defaultFormat`
 *    that is always a member of `supportedFormats`.
 * 2. `supportsFormat()` returns true for declared formats and false for others.
 * 3. `ProviderRegistry.deliver` rejects an unknown format string with
 *    errorCode `UNSUPPORTED_FORMAT` without calling the provider.
 * 4. `ProviderRegistry.deliver` rejects a valid format the specific provider
 *    does not support with errorCode `UNSUPPORTED_FORMAT`.
 * 5. When `formatPreference` is omitted, delivery proceeds (default backward-compat).
 * 6. When `formatPreference` is a supported format, delivery proceeds normally.
 * 7. Discord supports `embed`, `markdown`, and `plain_text`; defaults to `embed`.
 * 8. Webhook supports `json` and `plain_text`; defaults to `json`.
 * 9. Discord does NOT support `json` or `html`.
 * 10. Webhook does NOT support `embed`, `markdown`, or `html`.
 */

import {
  NotificationFormat,
  ProviderCapability,
  NotificationProvider,
  ProviderMetadata,
  DeliveryPayload,
  DeliveryResult,
} from '../../types/provider-capabilities';
import {
  ProviderRegistry,
  resetProviderRegistry,
} from '../provider-registry';
import { DiscordNotificationProvider } from './discord-provider';
import { WebhookNotificationProvider } from './webhook-provider';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    payload: { content: 'hello' },
    targetRecipient: 'https://example.com/hook',
    notificationType: 'test',
    requestId: 'req-fmt-001',
    ...overrides,
  };
}

/** Stub provider that reports delivery success and honours format declarations. */
function makeStubProvider(
  id: string,
  formats: NotificationFormat[],
  defaultFormat: NotificationFormat
): NotificationProvider {
  const fmtSet = new Set(formats);
  const capSet = new Set<ProviderCapability>();
  return {
    metadata: {
      id,
      name: `Stub(${id})`,
      version: '0.0.1',
      capabilities: capSet,
      supportedFormats: fmtSet,
      defaultFormat,
    } as ProviderMetadata,
    hasCapability: () => false,
    supportsFormat: (f: NotificationFormat) => fmtSet.has(f),
    deliver: jest.fn().mockResolvedValue({ success: true, degradedCapabilities: [] }),
  };
}

// ---------------------------------------------------------------------------
// Silence logger in tests
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Prevent real HTTP calls from Discord / Webhook providers
jest.mock('../webhook-sender', () => ({
  sendWebhook: jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
  }),
}));

// ---------------------------------------------------------------------------
// 1. NotificationFormat enum
// ---------------------------------------------------------------------------
describe('NotificationFormat enum', () => {
  it('defines the five expected format values', () => {
    expect(NotificationFormat.PLAIN_TEXT).toBe('plain_text');
    expect(NotificationFormat.MARKDOWN).toBe('markdown');
    expect(NotificationFormat.EMBED).toBe('embed');
    expect(NotificationFormat.JSON).toBe('json');
    expect(NotificationFormat.HTML).toBe('html');
    expect(Object.values(NotificationFormat)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 2. DiscordNotificationProvider — format declarations
// ---------------------------------------------------------------------------
describe('DiscordNotificationProvider — format preferences', () => {
  const discordConfig = {
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    webhookId: '123',
  };

  let provider: DiscordNotificationProvider;

  beforeEach(() => {
    provider = new DiscordNotificationProvider(discordConfig);
  });

  it('declares supportedFormats as a non-empty set', () => {
    expect(provider.metadata.supportedFormats.size).toBeGreaterThan(0);
  });

  it('default format is a member of supportedFormats', () => {
    expect(provider.metadata.supportedFormats.has(provider.metadata.defaultFormat)).toBe(true);
  });

  it('defaults to embed format', () => {
    expect(provider.metadata.defaultFormat).toBe(NotificationFormat.EMBED);
  });

  it('supports embed, markdown, and plain_text', () => {
    expect(provider.supportsFormat(NotificationFormat.EMBED)).toBe(true);
    expect(provider.supportsFormat(NotificationFormat.MARKDOWN)).toBe(true);
    expect(provider.supportsFormat(NotificationFormat.PLAIN_TEXT)).toBe(true);
  });

  it('does NOT support json or html', () => {
    expect(provider.supportsFormat(NotificationFormat.JSON)).toBe(false);
    expect(provider.supportsFormat(NotificationFormat.HTML)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. WebhookNotificationProvider — format declarations
// ---------------------------------------------------------------------------
describe('WebhookNotificationProvider — format preferences', () => {
  let provider: WebhookNotificationProvider;

  beforeEach(() => {
    provider = new WebhookNotificationProvider();
  });

  it('declares supportedFormats as a non-empty set', () => {
    expect(provider.metadata.supportedFormats.size).toBeGreaterThan(0);
  });

  it('default format is a member of supportedFormats', () => {
    expect(provider.metadata.supportedFormats.has(provider.metadata.defaultFormat)).toBe(true);
  });

  it('defaults to json format', () => {
    expect(provider.metadata.defaultFormat).toBe(NotificationFormat.JSON);
  });

  it('supports json and plain_text', () => {
    expect(provider.supportsFormat(NotificationFormat.JSON)).toBe(true);
    expect(provider.supportsFormat(NotificationFormat.PLAIN_TEXT)).toBe(true);
  });

  it('does NOT support embed, markdown, or html', () => {
    expect(provider.supportsFormat(NotificationFormat.EMBED)).toBe(false);
    expect(provider.supportsFormat(NotificationFormat.MARKDOWN)).toBe(false);
    expect(provider.supportsFormat(NotificationFormat.HTML)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. ProviderRegistry — format validation at delivery time
// ---------------------------------------------------------------------------
describe('ProviderRegistry — format preference validation', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    resetProviderRegistry();
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    resetProviderRegistry();
  });

  describe('when formatPreference is omitted (backward-compatibility)', () => {
    it('delivers successfully without a formatPreference', async () => {
      const stub = makeStubProvider('discord', [NotificationFormat.EMBED], NotificationFormat.EMBED);
      registry.register(stub);

      const result = await registry.deliver('discord', makePayload({ notificationType: 'discord' }));

      expect(result.success).toBe(true);
      expect(stub.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe('when formatPreference is a supported format', () => {
    it('delivers successfully when Discord receives embed format', async () => {
      const stub = makeStubProvider(
        'discord',
        [NotificationFormat.EMBED, NotificationFormat.MARKDOWN, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.EMBED
      );
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({ notificationType: 'discord', formatPreference: NotificationFormat.EMBED })
      );

      expect(result.success).toBe(true);
      expect(stub.deliver).toHaveBeenCalledTimes(1);
    });

    it('delivers successfully when Discord receives markdown format', async () => {
      const stub = makeStubProvider(
        'discord',
        [NotificationFormat.EMBED, NotificationFormat.MARKDOWN, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.EMBED
      );
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({ notificationType: 'discord', formatPreference: NotificationFormat.MARKDOWN })
      );

      expect(result.success).toBe(true);
    });

    it('delivers successfully when Webhook receives json format', async () => {
      const stub = makeStubProvider(
        'webhook',
        [NotificationFormat.JSON, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.JSON
      );
      registry.register(stub);

      const result = await registry.deliver(
        'webhook',
        makePayload({ notificationType: 'webhook', formatPreference: NotificationFormat.JSON })
      );

      expect(result.success).toBe(true);
    });

    it('delivers successfully when Webhook receives plain_text format', async () => {
      const stub = makeStubProvider(
        'webhook',
        [NotificationFormat.JSON, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.JSON
      );
      registry.register(stub);

      const result = await registry.deliver(
        'webhook',
        makePayload({ notificationType: 'webhook', formatPreference: NotificationFormat.PLAIN_TEXT })
      );

      expect(result.success).toBe(true);
    });
  });

  describe('when formatPreference is unsupported by the provider', () => {
    it('rejects discord delivery with json format — UNSUPPORTED_FORMAT', async () => {
      const stub = makeStubProvider(
        'discord',
        [NotificationFormat.EMBED, NotificationFormat.MARKDOWN, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.EMBED
      );
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({ notificationType: 'discord', formatPreference: NotificationFormat.JSON })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(result.errorMessage).toContain('json');
      expect(result.errorMessage).toContain('discord');
      // Provider should NOT be called when format is rejected
      expect(stub.deliver).not.toHaveBeenCalled();
    });

    it('rejects discord delivery with html format — UNSUPPORTED_FORMAT', async () => {
      const stub = makeStubProvider(
        'discord',
        [NotificationFormat.EMBED, NotificationFormat.MARKDOWN, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.EMBED
      );
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({ notificationType: 'discord', formatPreference: NotificationFormat.HTML })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(stub.deliver).not.toHaveBeenCalled();
    });

    it('rejects webhook delivery with embed format — UNSUPPORTED_FORMAT', async () => {
      const stub = makeStubProvider(
        'webhook',
        [NotificationFormat.JSON, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.JSON
      );
      registry.register(stub);

      const result = await registry.deliver(
        'webhook',
        makePayload({ notificationType: 'webhook', formatPreference: NotificationFormat.EMBED })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(result.errorMessage).toContain('embed');
      expect(result.errorMessage).toContain('webhook');
      expect(stub.deliver).not.toHaveBeenCalled();
    });

    it('rejects webhook delivery with markdown format — UNSUPPORTED_FORMAT', async () => {
      const stub = makeStubProvider(
        'webhook',
        [NotificationFormat.JSON, NotificationFormat.PLAIN_TEXT],
        NotificationFormat.JSON
      );
      registry.register(stub);

      const result = await registry.deliver(
        'webhook',
        makePayload({ notificationType: 'webhook', formatPreference: NotificationFormat.MARKDOWN })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(stub.deliver).not.toHaveBeenCalled();
    });
  });

  describe('when formatPreference is a completely unknown string', () => {
    it('rejects with UNSUPPORTED_FORMAT for an arbitrary unknown format string', async () => {
      const stub = makeStubProvider('discord', [NotificationFormat.EMBED], NotificationFormat.EMBED);
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({
          notificationType: 'discord',
          formatPreference: 'rich_card' as unknown as NotificationFormat,
        })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(stub.deliver).not.toHaveBeenCalled();
    });

    it('rejects with UNSUPPORTED_FORMAT for an empty string format', async () => {
      const stub = makeStubProvider('discord', [NotificationFormat.EMBED], NotificationFormat.EMBED);
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({
          notificationType: 'discord',
          formatPreference: '' as unknown as NotificationFormat,
        })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
      expect(stub.deliver).not.toHaveBeenCalled();
    });
  });

  describe('degradedCapabilities is always an array even on format errors', () => {
    it('returns an empty degradedCapabilities array on UNSUPPORTED_FORMAT rejection', async () => {
      const stub = makeStubProvider(
        'discord',
        [NotificationFormat.EMBED],
        NotificationFormat.EMBED
      );
      registry.register(stub);

      const result = await registry.deliver(
        'discord',
        makePayload({ notificationType: 'discord', formatPreference: NotificationFormat.JSON })
      );

      expect(Array.isArray(result.degradedCapabilities)).toBe(true);
      expect(result.degradedCapabilities).toHaveLength(0);
    });
  });

  describe('real adapters — integration style', () => {
    const discordConfig = {
      webhookUrl: 'https://discord.com/api/webhooks/123/token',
      webhookId: '123',
    };

    it('Discord provider: supported format (embed) is accepted by registry', async () => {
      const provider = new DiscordNotificationProvider(discordConfig);
      registry.register(provider);

      const result = await registry.deliver(
        'discord',
        makePayload({
          targetRecipient: discordConfig.webhookUrl,
          notificationType: 'discord',
          formatPreference: NotificationFormat.EMBED,
        })
      );

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
    });

    it('Discord provider: unsupported format (json) is rejected by registry', async () => {
      const provider = new DiscordNotificationProvider(discordConfig);
      registry.register(provider);

      const result = await registry.deliver(
        'discord',
        makePayload({
          targetRecipient: discordConfig.webhookUrl,
          notificationType: 'discord',
          formatPreference: NotificationFormat.JSON,
        })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
    });

    it('Webhook provider: supported format (json) is accepted by registry', async () => {
      const provider = new WebhookNotificationProvider();
      registry.register(provider);

      const result = await registry.deliver(
        'webhook',
        makePayload({
          targetRecipient: 'https://api.example.com/hook',
          notificationType: 'webhook',
          formatPreference: NotificationFormat.JSON,
        })
      );

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
    });

    it('Webhook provider: unsupported format (embed) is rejected by registry', async () => {
      const provider = new WebhookNotificationProvider();
      registry.register(provider);

      const result = await registry.deliver(
        'webhook',
        makePayload({
          targetRecipient: 'https://api.example.com/hook',
          notificationType: 'webhook',
          formatPreference: NotificationFormat.EMBED,
        })
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
    });

    it('Discord provider: omitting formatPreference is backward-compatible', async () => {
      const provider = new DiscordNotificationProvider(discordConfig);
      registry.register(provider);

      const result = await registry.deliver(
        'discord',
        makePayload({
          targetRecipient: discordConfig.webhookUrl,
          notificationType: 'discord',
          // no formatPreference
        })
      );

      expect(result.success).toBe(true);
    });

    it('Webhook provider: omitting formatPreference is backward-compatible', async () => {
      const provider = new WebhookNotificationProvider();
      registry.register(provider);

      const result = await registry.deliver(
        'webhook',
        makePayload({
          targetRecipient: 'https://api.example.com/hook',
          notificationType: 'webhook',
          // no formatPreference
        })
      );

      expect(result.success).toBe(true);
    });
  });
});
