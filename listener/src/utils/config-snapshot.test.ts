import { createDiagnosticSnapshot } from './config-snapshot';

describe('Diagnostic Configuration Snapshot (Issue #695)', () => {
  test('generates valid diagnostic snapshot without leaking secrets', () => {
    const mockEnv = {
      NODE_ENV: 'production',
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_SECRET_KEY: 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKD45DCAHSKV2U2B6P6IRKD45',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/SecretWebhookToken',
      CONTRACT_ADDRESSES: JSON.stringify([
        { address: 'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA64P7TV5A4W' },
      ]),
      POLL_INTERVAL_MS: '3000',
    };

    const snapshot = createDiagnosticSnapshot(mockEnv);

    expect(snapshot.system.nodeEnv).toBe('production');
    expect(snapshot.network.pollIntervalMs).toBe(3000);
    expect(snapshot.contracts.configuredCount).toBe(1);
    expect(snapshot.contracts.addresses).toContain(
      'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA64P7TV5A4W'
    );
    expect(snapshot.providers.discordEnabled).toBe(true);
    expect(snapshot.security.credentialsRedacted).toBe(true);

    // Strict Security Invariant: Ensure raw secret string is NOT in the JSON serialization
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('SecretWebhookToken');
    expect(serialized).not.toContain('SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKD45DCAHSKV2U2B6P6IRKD45');
  });
});
