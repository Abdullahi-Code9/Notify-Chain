import { isSensitiveStorageKey } from './walletStore';

describe('browser credential storage policy (#1207)', () => {
  it.each([
    'api-key',
    'notify-chain:auth-token',
    'bearer_token',
    'sessionSecret',
    'nck_abc',
    'dashboard/password',
    'credentials',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveStorageKey(key)).toBe(true);
  });

  it.each([
    'notify-chain:wallet-id',
    'notify-chain:wallet-address',
    'notify-chain:active-rpc-url',
    'sortBy',
  ])('allows non-sensitive UI state key %s', (key) => {
    expect(isSensitiveStorageKey(key)).toBe(false);
  });
});
