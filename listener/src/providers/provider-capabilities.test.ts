import {
  adaptPayloadForProvider,
  DISCORD_CAPABILITY_PROFILE,
  SMS_CAPABILITY_PROFILE,
  WEBHOOK_CAPABILITY_PROFILE,
  NotificationCapability,
} from './provider-capabilities';

describe('Provider Capability Metadata & Graceful Degradation (Issue #708)', () => {
  const samplePayload = {
    title: '🚨 Payment Received',
    body: 'You received 500 XLM from Alice.',
    markdownContent: '**🚨 Payment Received**\nYou received `500 XLM` from Alice.',
    actions: [{ label: 'View Transaction', url: 'https://stellar.expert/tx/123' }],
    attachments: [{ filename: 'receipt.pdf', url: 'https://example.com/receipt.pdf' }],
  };

  test('renders full rich formatting and embedded links on capable providers (Discord)', () => {
    const formatted = adaptPayloadForProvider(samplePayload, DISCORD_CAPABILITY_PROFILE);

    expect(formatted.hasDegradedFeatures).toBe(false);
    expect(formatted.omittedFeatures).toEqual([]);
    expect(formatted.renderedText).toContain('**🚨 Payment Received**');
    expect(formatted.renderedText).toContain('[View Transaction](https://stellar.expert/tx/123)');
  });

  test('gracefully degrades markdown and embeds on plain providers (SMS)', () => {
    const formatted = adaptPayloadForProvider(samplePayload, SMS_CAPABILITY_PROFILE);

    expect(formatted.hasDegradedFeatures).toBe(true);
    expect(formatted.omittedFeatures).toContain(NotificationCapability.RICH_FORMATTING);
    expect(formatted.omittedFeatures).toContain(NotificationCapability.EMBEDDED_LINKS);
    expect(formatted.omittedFeatures).toContain(NotificationCapability.ATTACHMENTS);
    expect(formatted.renderedText).not.toContain('**');
    expect(formatted.renderedText).toContain('View Transaction: https://stellar.expert/tx/123');
    expect(formatted.renderedText).toContain('Attachments omitted: receipt.pdf');
  });

  test('preserves generic webhook capabilities without hard dependencies', () => {
    const formatted = adaptPayloadForProvider(samplePayload, WEBHOOK_CAPABILITY_PROFILE);

    expect(formatted.omittedFeatures).toContain(NotificationCapability.ATTACHMENTS);
    expect(formatted.renderedText).toContain('**🚨 Payment Received**');
  });
});
