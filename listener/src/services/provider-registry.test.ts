// listener/src/services/provider-registry.test.ts
import { ProviderRegistry, getProviderRegistry, resetProviderRegistry, setProviderRegistry } from './provider-registry';
import { MockNotificationProvider } from './__mocks__/mock-notification-provider';
import { ProviderCapability } from '../types/provider-capabilities';

describe('ProviderRegistry with MockNotificationProvider', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    // Ensure a fresh singleton for each test
    resetProviderRegistry();
    registry = getProviderRegistry();
  });

  afterAll(() => {
    resetProviderRegistry();
  });

  test('register and deliver successful mock notification', async () => {
    const mock = new MockNotificationProvider('mock', 'Mock Provider', '1.0.0', {
      succeed: true,
      capabilities: new Set([ProviderCapability.RICH_FORMATTING]),
    });
    registry.register(mock);

    const payload = {
      payload: { message: 'test' },
      targetRecipient: 'dummy://recipient',
      notificationType: 'mock',
      requestedFeatures: new Set([ProviderCapability.RICH_FORMATTING]),
    };

    const result = await registry.deliver('mock', payload);
    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toHaveLength(0);
  });

  test('delivery failure when mock is configured to fail', async () => {
    const mock = new MockNotificationProvider('mockFail', 'Failing Mock', '1.0.0', {
      succeed: false,
      errorMessage: 'simulated failure',
    });
    registry.register(mock);

    const payload = {
      payload: { message: 'fail' },
      targetRecipient: 'dummy://recipient',
      notificationType: 'mockFail',
    };

    const result = await registry.deliver('mockFail', payload);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('simulated failure');
  });

  test('degrades unsupported capabilities', async () => {
    const mock = new MockNotificationProvider('partial', 'Partial Mock', '1.0.0', {
      succeed: true,
      capabilities: new Set([ProviderCapability.RICH_FORMATTING]),
    });
    registry.register(mock);

    const payload = {
      payload: { message: 'partial' },
      targetRecipient: 'dummy://recipient',
      notificationType: 'partial',
      requestedFeatures: new Set([ProviderCapability.RICH_FORMATTING, ProviderCapability.ATTACHMENTS]),
    };

    const result = await registry.deliver('partial', payload);
    expect(result.success).toBe(true);
    expect(result.degradedCapabilities).toContain(ProviderCapability.ATTACHMENTS);
    expect(result.degradedCapabilities).not.toContain(ProviderCapability.RICH_FORMATTING);
  });
});
