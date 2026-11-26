import { canGrantScopes, isCredentialOwner } from './credentials-api';
import type { AuthPrincipal } from './api-key-auth';
const scoped: AuthPrincipal = { type: 'credential', credentialId: 'a'.repeat(16), name: 'x', scopes: ['events:read'], clientId: 'c' };
describe('credential privilege boundaries (#1261)', () => {
  it('rejects scopes the caller does not hold', () => {
    expect(canGrantScopes(scoped, ['events:read'])).toBe(true);
    expect(canGrantScopes(scoped, ['credentials:manage'])).toBe(false);
  });
  it('enforces ownership for scoped callers only', () => {
    expect(isCredentialOwner(scoped, 'a'.repeat(16))).toBe(true);
    expect(isCredentialOwner(scoped, 'b'.repeat(16))).toBe(false);
    expect(isCredentialOwner({ type: 'legacy', clientId: 'l' }, 'b'.repeat(16))).toBe(true);
  });
});
