/**
 * Unit tests for the provider capability declaration system.
 *
 * Coverage:
 * - ProviderCapability enum values are stable
 * - Providers declare capabilities and respond correctly to hasCapability()
 * - Unsupported features are listed in DeliveryResult.degradedCapabilities
 *   and delivery still succeeds for the supported path
 * - ProviderRegistry register / lookup / findByCapability / deliver
 * - The scheduler delegates to the registry (pipeline independence from
 *   concrete provider classes)
 * - resetProviderRegistry cleans up between tests
 */

import {
  ProviderCapability,
  NotificationProvider,
  ProviderMetadata,
  DeliveryPayload,
  DeliveryResult,
} from '../../types/provider-capabilities';
import {
  ProviderRegistry,
  getProviderRegistry,
  setProviderRegistry,
  resetProviderRegistry,
} from '../provider-registry';
import { DiscordNotificationProvider } from '../providers/discord-provider';
import { WebhookNotificationProvider } from '../providers/webhook-provider';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    payload: { message: 'hello' },
    targetRecipient: 'https://example.com/hook',
    notificationType: 'test',
    requestId: 'req-test-123',
    ...overrides,
  };
}

/** Minimal stub that always returns success */
function makeStubProvider(
  id: string,
  capabilities: ProviderCapability[] = []
): NotificationProvider {
  const capSet = new Set(capabilities);
  return {
    metadata: {
      id,
      name: `Stub(${id})`,
      version: '0.0.1',
      capabilities: capSet,
    },
    hasCapability: (c: ProviderCapability) => capSet.has(c),
    deliver: jest.fn().mockResolvedValue({ success: true, degradedCapabilities: [] }),
  };
}

// ---------------------------------------------------------------------------
// Mock logger to silence output during tests
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock fetch / sendWebhook so providers don't make real HTTP calls
// ---------------------------------------------------------------------------
jest.mock('../webhook-sender', () => ({
  sendWebhook: jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    text: () => Promise.resolve(''),
  }),
}));

// ---------------------------------------------------------------------------
// 1. ProviderCapability enum
// ---------------------------------------------------------------------------
describe('ProviderCapability enum', () => {
  it('defines the six expected capability values', () => {
    const values = Object.values(ProviderCapability);
    expect(values).toContain('RICH_FORMATTING');
    expect(values).toContain('ATTACHMENTS');
    expect(values).toContain('MESSAGE_UPDATES');
    expect(values).toContain('THREADING');
    expect(values).toContain('INTERACTIVE_COMPONENTS');
    expect(values).toContain('NATIVE_SCHEDULING');
    expect(values).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 2. NotificationProvider contract
// ---------------------------------------------------------------------------
describe('NotificationProvider contract', () => {
  it('hasCapability returns true for declared capabilities', () => {
    const provider = makeStubProvider('test', [
      ProviderCapability.RICH_FORMATTING,
      ProviderCapability.ATTACHMENTS,
    ]);
    expect(provider.hasCapability(ProviderCapability.RICH_FORMATTING)).toBe(true);
    expect(provider.hasCapability(ProviderCapability.ATTACHMENTS)).toBe(true);
  });

  it('hasCapability returns false for undeclared capabilities', () => {
    const provider = makeStubProvider('test', [ProviderCapability.RICH_FORMATTING]);
    expect(provider.hasCapability(ProviderCapability.MESSAGE_UPDATES)).toBe(false);
    expect(provider.hasCapability(ProviderCapability.THREADING)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. DiscordNotificationProvider
// ---------------------------------------------------------------------------
describe('DiscordNotificationProvider', () => {
  const discordConfig = {
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    webhookId: '123',
  };

  it('declares the expected Discord capabilities', () => {
    const provider = new DiscordNotificationProvider(discordConfig);
    expect(provider.hasCapability(ProviderCapability.RICH_FORMATTING)).toBe(true);
    expect(provider.hasCapability(ProviderCapability.ATTACHMENTS)).toBe(true);
    expect(provider.hasCapability(ProviderCapability.MESSAGE_UPDATES)).toBe(true);
    expect(provider.hasCapability(ProviderCapability.THREADING)).toBe(true);
    expect(provider.hasCapability(ProviderCapability.INTERACTIVE_COMPONENTS)).toBe(true);
  });

  it('does NOT declare NATIVE_SCHEDULING', () => {
    const provider = new DiscordNotificationProvider(discordConfig);
    expect(provider.hasCapability(ProviderCapability.NATIVE_SCHEDULING)).toBe(false);
  });

  it('has id "discord"', () => {
    const provider = new DiscordNotificationProvider(discordConfig);
    expect(provider.metadata.id).toBe('discord');
  });

  it('delivers successfully when webhook returns 2xx', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({ ok: true, status: 204, text: () => Promise.resolve('') });

    const provider = new DiscordNotificationProvider(discordConfig);
    const result = await provider.deliver(makePayload({ targetRecipient: discordConfig.webhookUrl }));

    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toHaveLength(0);
  });

  it('returns success:false when webhook returns 4xx', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    });

    const provider = new DiscordNotificationProvider(discordConfig);
    const result = await provider.deliver(makePayload({ targetRecipient: discordConfig.webhookUrl }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('HTTP 400');
  });

  it('lists unsupported features in degradedCapabilities but still delivers', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({ ok: true, status: 204, text: () => Promise.resolve('') });

    const provider = new DiscordNotificationProvider(discordConfig);
    const result = await provider.deliver(
      makePayload({
        targetRecipient: discordConfig.webhookUrl,
        requestedFeatures: new Set([
          ProviderCapability.RICH_FORMATTING,    // supported
          ProviderCapability.NATIVE_SCHEDULING,  // NOT supported
        ]),
      })
    );

    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toContain(ProviderCapability.NATIVE_SCHEDULING);
    expect(result.degradedCapabilities).not.toContain(ProviderCapability.RICH_FORMATTING);
  });

  it('returns success:false and captures errorMessage on network error', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const provider = new DiscordNotificationProvider(discordConfig);
    const result = await provider.deliver(makePayload({ targetRecipient: discordConfig.webhookUrl }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// 4. WebhookNotificationProvider
// ---------------------------------------------------------------------------
describe('WebhookNotificationProvider', () => {
  it('declares ATTACHMENTS capability', () => {
    const provider = new WebhookNotificationProvider();
    expect(provider.hasCapability(ProviderCapability.ATTACHMENTS)).toBe(true);
  });

  it('does NOT declare RICH_FORMATTING, MESSAGE_UPDATES, THREADING, INTERACTIVE_COMPONENTS', () => {
    const provider = new WebhookNotificationProvider();
    expect(provider.hasCapability(ProviderCapability.RICH_FORMATTING)).toBe(false);
    expect(provider.hasCapability(ProviderCapability.MESSAGE_UPDATES)).toBe(false);
    expect(provider.hasCapability(ProviderCapability.THREADING)).toBe(false);
    expect(provider.hasCapability(ProviderCapability.INTERACTIVE_COMPONENTS)).toBe(false);
  });

  it('has id "webhook"', () => {
    const provider = new WebhookNotificationProvider();
    expect(provider.metadata.id).toBe('webhook');
  });

  it('delivers successfully when endpoint returns 2xx', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });

    const provider = new WebhookNotificationProvider();
    const result = await provider.deliver(makePayload());

    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toHaveLength(0);
  });

  it('returns success:false when endpoint returns 5xx', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });

    const provider = new WebhookNotificationProvider();
    const result = await provider.deliver(makePayload());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('HTTP 503');
  });

  it('degrades RICH_FORMATTING when requested — still delivers', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });

    const provider = new WebhookNotificationProvider();
    const result = await provider.deliver(
      makePayload({
        requestedFeatures: new Set([
          ProviderCapability.ATTACHMENTS,      // supported
          ProviderCapability.RICH_FORMATTING,  // NOT supported
          ProviderCapability.THREADING,        // NOT supported
        ]),
      })
    );

    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toContain(ProviderCapability.RICH_FORMATTING);
    expect(result.degradedCapabilities).toContain(ProviderCapability.THREADING);
    expect(result.degradedCapabilities).not.toContain(ProviderCapability.ATTACHMENTS);
  });

  it('returns success:false on network error', async () => {
    const { sendWebhook } = require('../webhook-sender');
    (sendWebhook as jest.Mock).mockRejectedValueOnce(new Error('timeout'));

    const provider = new WebhookNotificationProvider();
    const result = await provider.deliver(makePayload());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// 5. ProviderRegistry
// ---------------------------------------------------------------------------
describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register / has / get / listIds', () => {
    it('registers a provider and makes it retrievable', () => {
      const p = makeStubProvider('discord');
      registry.register(p);
      expect(registry.has('discord')).toBe(true);
      expect(registry.get('discord')).toBe(p);
    });

    it('listIds returns all registered provider ids', () => {
      registry.register(makeStubProvider('discord'));
      registry.register(makeStubProvider('webhook'));
      expect(registry.listIds()).toEqual(expect.arrayContaining(['discord', 'webhook']));
    });

    it('has() returns false for an unregistered id', () => {
      expect(registry.has('email')).toBe(false);
    });

    it('get() returns undefined for an unregistered id', () => {
      expect(registry.get('sms')).toBeUndefined();
    });

    it('overwriting a provider replaces the previous one', () => {
      const first = makeStubProvider('discord');
      const second = makeStubProvider('discord', [ProviderCapability.RICH_FORMATTING]);
      registry.register(first);
      registry.register(second);
      expect(registry.get('discord')).toBe(second);
    });
  });

  describe('unregister', () => {
    it('removes a registered provider and returns true', () => {
      registry.register(makeStubProvider('discord'));
      expect(registry.unregister('discord')).toBe(true);
      expect(registry.has('discord')).toBe(false);
    });

    it('returns false when the provider was not registered', () => {
      expect(registry.unregister('email')).toBe(false);
    });
  });

  describe('findByCapability', () => {
    it('returns providers that declare the capability', () => {
      const rich = makeStubProvider('discord', [
        ProviderCapability.RICH_FORMATTING,
        ProviderCapability.ATTACHMENTS,
      ]);
      const plain = makeStubProvider('webhook', [ProviderCapability.ATTACHMENTS]);
      registry.register(rich);
      registry.register(plain);

      const richProviders = registry.findByCapability(ProviderCapability.RICH_FORMATTING);
      expect(richProviders).toHaveLength(1);
      expect(richProviders[0].metadata.id).toBe('discord');
    });

    it('returns all providers that share a capability', () => {
      registry.register(
        makeStubProvider('discord', [ProviderCapability.ATTACHMENTS])
      );
      registry.register(
        makeStubProvider('webhook', [ProviderCapability.ATTACHMENTS])
      );
      const result = registry.findByCapability(ProviderCapability.ATTACHMENTS);
      expect(result).toHaveLength(2);
    });

    it('returns an empty array when no provider has the capability', () => {
      registry.register(makeStubProvider('webhook', [ProviderCapability.ATTACHMENTS]));
      expect(registry.findByCapability(ProviderCapability.THREADING)).toHaveLength(0);
    });
  });

  describe('deliver', () => {
    it('dispatches to the registered provider and returns its result', async () => {
      const provider = makeStubProvider('discord');
      (provider.deliver as jest.Mock).mockResolvedValueOnce({
        success: true,
        degradedCapabilities: [],
      });
      registry.register(provider);

      const result = await registry.deliver('discord', makePayload({ notificationType: 'discord' }));

      expect(result.success).toBe(true);
      expect(provider.deliver).toHaveBeenCalledTimes(1);
    });

    it('returns success:false with an error message for an unregistered provider', async () => {
      const result = await registry.deliver('telegram', makePayload({ notificationType: 'telegram' }));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('telegram');
      expect(result.degradedCapabilities).toHaveLength(0);
    });

    it('passes the full DeliveryPayload to the provider', async () => {
      const provider = makeStubProvider('discord');
      registry.register(provider);

      const payload = makePayload({
        notificationType: 'discord',
        requestedFeatures: new Set([ProviderCapability.RICH_FORMATTING]),
        requestId: 'req-xyz',
      });
      await registry.deliver('discord', payload);

      expect(provider.deliver).toHaveBeenCalledWith(payload);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Module-level singleton helpers
// ---------------------------------------------------------------------------
describe('getProviderRegistry / setProviderRegistry / resetProviderRegistry', () => {
  afterEach(() => {
    resetProviderRegistry();
  });

  it('getProviderRegistry returns the same instance on repeated calls', () => {
    const a = getProviderRegistry();
    const b = getProviderRegistry();
    expect(a).toBe(b);
  });

  it('setProviderRegistry replaces the singleton', () => {
    const custom = new ProviderRegistry();
    custom.register(makeStubProvider('discord'));
    setProviderRegistry(custom);

    expect(getProviderRegistry()).toBe(custom);
    expect(getProviderRegistry().has('discord')).toBe(true);
  });

  it('resetProviderRegistry creates a fresh empty registry on next get', () => {
    const original = getProviderRegistry();
    original.register(makeStubProvider('discord'));
    resetProviderRegistry();

    const fresh = getProviderRegistry();
    expect(fresh).not.toBe(original);
    expect(fresh.has('discord')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Pipeline independence from concrete provider classes
// ---------------------------------------------------------------------------
describe('Pipeline independence', () => {
  it('delivers through any provider implementing the interface, not a concrete class', async () => {
    /**
     * This test verifies the core acceptance criterion: the pipeline
     * (ProviderRegistry.deliver) only depends on the NotificationProvider
     * interface. A completely ad-hoc implementation satisfies the contract.
     */
    const adHocProvider: NotificationProvider = {
      metadata: {
        id: 'custom',
        name: 'Custom Provider',
        version: '1.0.0',
        capabilities: new Set([
          ProviderCapability.RICH_FORMATTING,
          ProviderCapability.NATIVE_SCHEDULING,
        ]),
      },
      hasCapability(c) {
        return this.metadata.capabilities.has(c);
      },
      async deliver(p): Promise<DeliveryResult> {
        const degraded: ProviderCapability[] = [];
        if (p.requestedFeatures) {
          for (const f of p.requestedFeatures) {
            if (!this.metadata.capabilities.has(f)) degraded.push(f);
          }
        }
        return { success: true, degradedCapabilities: degraded };
      },
    };

    const registry = new ProviderRegistry();
    registry.register(adHocProvider);

    const result = await registry.deliver(
      'custom',
      makePayload({
        notificationType: 'custom',
        requestedFeatures: new Set([
          ProviderCapability.RICH_FORMATTING,  // supported
          ProviderCapability.ATTACHMENTS,       // NOT declared
        ]),
      })
    );

    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toContain(ProviderCapability.ATTACHMENTS);
    expect(result.degradedCapabilities).not.toContain(ProviderCapability.RICH_FORMATTING);
  });

  it('can swap providers without changing the delivery call site', async () => {
    const registry = new ProviderRegistry();

    // First register a "slow" stub
    const slowProvider = makeStubProvider('email');
    (slowProvider.deliver as jest.Mock).mockResolvedValueOnce({ success: true, degradedCapabilities: [] });
    registry.register(slowProvider);

    await registry.deliver('email', makePayload({ notificationType: 'email' }));
    expect(slowProvider.deliver).toHaveBeenCalledTimes(1);

    // Swap to a "fast" stub — deliver call site is identical
    const fastProvider = makeStubProvider('email', [ProviderCapability.RICH_FORMATTING]);
    (fastProvider.deliver as jest.Mock).mockResolvedValueOnce({ success: true, degradedCapabilities: [] });
    registry.register(fastProvider);

    await registry.deliver('email', makePayload({ notificationType: 'email' }));
    expect(fastProvider.deliver).toHaveBeenCalledTimes(1);
    // Old provider was NOT called again
    expect(slowProvider.deliver).toHaveBeenCalledTimes(1);
  });
});
