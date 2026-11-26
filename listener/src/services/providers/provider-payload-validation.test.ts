/**
 * Tests for the provider capability contract and pre-delivery payload-limit
 * validation (Task 1).
 *
 * Coverage:
 * - Every concrete provider exposes capabilities via `getCapabilities()` and
 *   declares supported formats + payload limits.
 * - `validatePayloadLimits` rejects each declared limit (body, title,
 *   attachments, field count, serialized size) and accepts compliant payloads.
 * - `ProviderRegistry.deliver` rejects unsupported formats with
 *   `UNSUPPORTED_FORMAT` and oversized payloads with `PAYLOAD_LIMIT_EXCEEDED`,
 *   without ever calling the provider.
 * - Extensibility: a custom provider with its own capabilities and limits is
 *   enforced by the registry without any orchestration changes.
 */

import {
  NotificationFormat,
  ProviderCapability,
  NotificationProvider,
  ProviderMetadata,
  DeliveryPayload,
} from '../../types/provider-capabilities';
import { ProviderRegistry } from '../provider-registry';
import { DiscordNotificationProvider } from './discord-provider';
import { WebhookNotificationProvider } from './webhook-provider';
import { validatePayloadLimits } from './payload-limits';

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Prevent real HTTP calls from the concrete providers.
jest.mock('../webhook-sender', () => ({
  sendWebhook: jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    headers: { get: () => null },
    text: () => Promise.resolve(''),
  }),
}));

function makePayload(overrides: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    payload: { body: 'hello' },
    targetRecipient: 'https://example.com/hook',
    notificationType: 'test',
    requestId: 'req-limits-001',
    ...overrides,
  };
}

/** A provider whose capabilities are reported only through `getCapabilities()`. */
function makeCustomProvider(metadata: ProviderMetadata): NotificationProvider & {
  deliver: jest.Mock;
} {
  const deliver = jest.fn().mockResolvedValue({ success: true, degradedCapabilities: [] });
  return {
    metadata,
    hasCapability: (capability: ProviderCapability) => metadata.capabilities.has(capability),
    supportsFormat: (format: NotificationFormat) => metadata.supportedFormats.has(format),
    getCapabilities: () => metadata,
    deliver,
  } as NotificationProvider & { deliver: jest.Mock };
}

// ---------------------------------------------------------------------------
// 1. validatePayloadLimits — unit behaviour
// ---------------------------------------------------------------------------
describe('validatePayloadLimits', () => {
  it('accepts any payload when no limits are declared', () => {
    expect(validatePayloadLimits({ body: 'x'.repeat(1_000_000) }, undefined).valid).toBe(true);
  });

  it('accepts a payload exactly at the limit boundary', () => {
    const limits = { maxBodyLength: 5 };
    expect(validatePayloadLimits({ body: 'abcde' }, limits).valid).toBe(true);
  });

  it('flags a body that exceeds maxBodyLength', () => {
    const result = validatePayloadLimits({ body: 'abcdef' }, { maxBodyLength: 5 });
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({ limit: 'maxBodyLength', actual: 6, max: 5 });
  });

  it('measures the body from the first recognised body field', () => {
    const result = validatePayloadLimits({ title: 'ok', message: 'toolong' }, { maxBodyLength: 3 });
    expect(result.valid).toBe(false);
    expect(result.violations[0].limit).toBe('maxBodyLength');
  });

  it('flags a title that exceeds maxTitleLength', () => {
    const result = validatePayloadLimits({ title: 'too long' }, { maxTitleLength: 3 });
    expect(result.violations[0].limit).toBe('maxTitleLength');
  });

  it('falls back to the subject field for the title limit', () => {
    const result = validatePayloadLimits({ subject: 'too long' }, { maxTitleLength: 3 });
    expect(result.violations[0].limit).toBe('maxTitleLength');
  });

  it('flags too many attachments', () => {
    const result = validatePayloadLimits(
      { body: 'x', attachments: [{}, {}, {}] },
      { maxAttachmentCount: 2 }
    );
    expect(result.violations[0]).toMatchObject({ limit: 'maxAttachmentCount', actual: 3, max: 2 });
  });

  it('flags too many top-level fields', () => {
    const result = validatePayloadLimits({ a: 1, b: 2, c: 3 }, { maxFieldCount: 2 });
    expect(result.violations[0]).toMatchObject({ limit: 'maxFieldCount', actual: 3, max: 2 });
  });

  it('flags a serialized payload that exceeds maxPayloadBytes', () => {
    const result = validatePayloadLimits({ body: 'x'.repeat(100) }, { maxPayloadBytes: 10 });
    expect(result.violations[0].limit).toBe('maxPayloadBytes');
  });

  it('reports every violated limit', () => {
    const result = validatePayloadLimits(
      { title: 'long title', body: 'long body', attachments: [{}] },
      { maxBodyLength: 1, maxTitleLength: 1, maxAttachmentCount: 0 }
    );
    expect(result.violations.map((v) => v.limit).sort()).toEqual(
      ['maxAttachmentCount', 'maxBodyLength', 'maxTitleLength'].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Capability exposure per provider
// ---------------------------------------------------------------------------
describe('Provider capability exposure', () => {
  it('Discord exposes capabilities via getCapabilities()', () => {
    const provider = new DiscordNotificationProvider({
      webhookUrl: 'https://discord.com/api/webhooks/1/token',
      webhookId: '1',
    });
    const capabilities = provider.getCapabilities();
    expect(capabilities).toBe(provider.metadata);
    expect(capabilities.supportedFormats.has(NotificationFormat.EMBED)).toBe(true);
    expect(capabilities.payloadLimits?.maxBodyLength).toBe(2_000);
  });

  it('Webhook exposes capabilities via getCapabilities()', () => {
    const provider = new WebhookNotificationProvider();
    const capabilities = provider.getCapabilities();
    expect(capabilities).toBe(provider.metadata);
    expect(capabilities.supportedFormats.has(NotificationFormat.JSON)).toBe(true);
    expect(capabilities.payloadLimits?.maxPayloadBytes).toBe(65_536);
  });
});

// ---------------------------------------------------------------------------
// 3. Registry pre-delivery validation — formats
// ---------------------------------------------------------------------------
describe('ProviderRegistry pre-delivery validation — formats', () => {
  it('rejects an unsupported format without calling the provider', async () => {
    const registry = new ProviderRegistry();
    const provider = makeCustomProvider({
      id: 'custom',
      name: 'Custom',
      version: '1.0.0',
      capabilities: new Set<ProviderCapability>(),
      supportedFormats: new Set([NotificationFormat.PLAIN_TEXT]),
      defaultFormat: NotificationFormat.PLAIN_TEXT,
    });
    registry.register(provider);

    const result = await registry.deliver(
      'custom',
      makePayload({ formatPreference: NotificationFormat.JSON })
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UNSUPPORTED_FORMAT');
    expect(provider.deliver).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Registry pre-delivery validation — payload limits
// ---------------------------------------------------------------------------
describe('ProviderRegistry pre-delivery validation — payload limits', () => {
  it('rejects a payload exceeding a declared limit and does not dispatch', async () => {
    const registry = new ProviderRegistry();
    const provider = makeCustomProvider({
      id: 'custom',
      name: 'Custom',
      version: '1.0.0',
      capabilities: new Set<ProviderCapability>(),
      supportedFormats: new Set([NotificationFormat.PLAIN_TEXT]),
      defaultFormat: NotificationFormat.PLAIN_TEXT,
      payloadLimits: { maxBodyLength: 5 },
    });
    registry.register(provider);

    const result = await registry.deliver(
      'custom',
      makePayload({ payload: { body: 'way too long' } })
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PAYLOAD_LIMIT_EXCEEDED');
    expect(result.errorMessage).toContain('body length');
    expect(result.errorMessage).toContain('exceeds the provider maximum of 5');
    expect(provider.deliver).not.toHaveBeenCalled();
  });

  it('dispatches a payload that satisfies the declared limits', async () => {
    const registry = new ProviderRegistry();
    const provider = makeCustomProvider({
      id: 'custom',
      name: 'Custom',
      version: '1.0.0',
      capabilities: new Set<ProviderCapability>(),
      supportedFormats: new Set([NotificationFormat.PLAIN_TEXT]),
      defaultFormat: NotificationFormat.PLAIN_TEXT,
      payloadLimits: { maxBodyLength: 100, maxFieldCount: 5 },
    });
    registry.register(provider);

    const result = await registry.deliver('custom', makePayload({ payload: { body: 'short' } }));

    expect(result.success).toBe(true);
    expect(provider.deliver).toHaveBeenCalledTimes(1);
  });

  it('enforces Discord and Webhook payload limits without orchestration changes', async () => {
    const discordRegistry = new ProviderRegistry();
    discordRegistry.register(
      new DiscordNotificationProvider({
        webhookUrl: 'https://discord.com/api/webhooks/1/token',
        webhookId: '1',
      })
    );
    const discordResult = await discordRegistry.deliver(
      'discord',
      makePayload({ targetRecipient: 'https://discord.com/api/webhooks/1/token', payload: { content: 'x'.repeat(2_001) } })
    );
    expect(discordResult.success).toBe(false);
    expect(discordResult.errorCode).toBe('PAYLOAD_LIMIT_EXCEEDED');
  });

  it('does not validate limits when a provider declares none', async () => {
    const registry = new ProviderRegistry();
    const provider = makeCustomProvider({
      id: 'nolimits',
      name: 'NoLimits',
      version: '1.0.0',
      capabilities: new Set<ProviderCapability>(),
      supportedFormats: new Set([NotificationFormat.PLAIN_TEXT]),
      defaultFormat: NotificationFormat.PLAIN_TEXT,
    });
    registry.register(provider);

    const result = await registry.deliver(
      'nolimits',
      makePayload({ payload: { body: 'x'.repeat(10_000) } })
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Extensibility — a future provider just implements the contract
// ---------------------------------------------------------------------------
describe('Provider extensibility', () => {
  it('enforces a new provider’s limits purely from its declared capabilities', async () => {
    const registry = new ProviderRegistry();
    const provider = makeCustomProvider({
      id: 'future-sms',
      name: 'Future SMS',
      version: '2.0.0',
      capabilities: new Set<ProviderCapability>(),
      supportedFormats: new Set([NotificationFormat.PLAIN_TEXT]),
      defaultFormat: NotificationFormat.PLAIN_TEXT,
      payloadLimits: { maxBodyLength: 160, maxAttachmentCount: 0 },
    });
    registry.register(provider);

    const tooLong = await registry.deliver(
      'future-sms',
      makePayload({ payload: { body: 'x'.repeat(161) } })
    );
    expect(tooLong.errorCode).toBe('PAYLOAD_LIMIT_EXCEEDED');

    const withAttachment = await registry.deliver(
      'future-sms',
      makePayload({ payload: { body: 'ok', attachments: [{}] } })
    );
    expect(withAttachment.errorCode).toBe('PAYLOAD_LIMIT_EXCEEDED');
    expect(provider.deliver).not.toHaveBeenCalled();

    const ok = await registry.deliver('future-sms', makePayload({ payload: { body: 'ok' } }));
    expect(ok.success).toBe(true);
  });
});
