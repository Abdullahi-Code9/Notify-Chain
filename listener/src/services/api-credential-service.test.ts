import {
  ApiCredentialService,
  CredentialValidationError,
  InMemoryApiCredentialStore,
  parseApiKey,
} from './api-credential-service';

describe('ApiCredentialService', () => {
  let store: InMemoryApiCredentialStore;
  let service: ApiCredentialService;

  beforeEach(() => {
    store = new InMemoryApiCredentialStore();
    service = new ApiCredentialService({ store });
  });

  describe('create', () => {
    it('returns the full api key exactly once, in the creation result', async () => {
      const created = await service.create({ name: 'CI', scopes: ['events:read'] });

      expect(created.apiKey).toMatch(/^nck_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
      expect(parseApiKey(created.apiKey)?.id).toBe(created.id);
      expect(created.keyPrefix).toBe(`nck_${created.id}`);
      expect(created.scopes).toEqual(['events:read']);
    });

    it('stores only a salted scrypt hash, never the secret', async () => {
      const created = await service.create({ name: 'CI', scopes: ['events:read'] });
      const secret = parseApiKey(created.apiKey)!.secret;
      const record = store.get(created.id)!;

      expect(record.secretHash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
      expect(JSON.stringify(record)).not.toContain(secret);
    });

    it('uses a unique salt per credential', async () => {
      const a = await service.create({ name: 'a', scopes: ['events:read'] });
      const b = await service.create({ name: 'b', scopes: ['events:read'] });
      const saltOf = (id: string) => store.get(id)!.secretHash.split('$')[4];
      expect(saltOf(a.id)).not.toBe(saltOf(b.id));
    });

    it('de-duplicates scopes', async () => {
      const created = await service.create({
        name: 'dup',
        scopes: ['stats:read', 'stats:read', 'events:read'],
      });
      expect(created.scopes).toEqual(['stats:read', 'events:read']);
    });

    it.each([
      ['missing name', { scopes: ['events:read'] }],
      ['blank name', { name: '   ', scopes: ['events:read'] }],
      ['overlong name', { name: 'x'.repeat(101), scopes: ['events:read'] }],
      ['missing scopes', { name: 'n' }],
      ['empty scopes', { name: 'n', scopes: [] }],
      ['unknown scope', { name: 'n', scopes: ['admin:*'] }],
    ])('rejects %s', async (_label, input) => {
      await expect(service.create(input as never)).rejects.toBeInstanceOf(
        CredentialValidationError,
      );
    });
  });

  describe('read paths never expose secret material', () => {
    it('list() and get() omit apiKey and secretHash', async () => {
      const created = await service.create({ name: 'CI', scopes: ['events:read'] });
      const secret = parseApiKey(created.apiKey)!.secret;

      for (const view of [...service.list(), service.get(created.id)!]) {
        expect(view).not.toHaveProperty('apiKey');
        expect(view).not.toHaveProperty('secretHash');
        expect(JSON.stringify(view)).not.toContain(secret);
      }
    });

    it('get() returns null for unknown ids', () => {
      expect(service.get('0000000000000000')).toBeNull();
    });
  });

  describe('verify', () => {
    it('accepts the issued key and records last use', async () => {
      const created = await service.create({ name: 'CI', scopes: ['stats:read'] });
      const verified = await service.verify(created.apiKey);
      expect(verified?.id).toBe(created.id);
      expect(verified?.scopes).toEqual(['stats:read']);
      expect(verified?.lastUsedAt).not.toBeNull();
    });

    it('rejects a key with the right id but a wrong secret', async () => {
      const created = await service.create({ name: 'CI', scopes: ['stats:read'] });
      const forged = `nck_${created.id}_${'A'.repeat(43)}`;
      expect(await service.verify(forged)).toBeNull();
    });

    it('rejects unknown ids and malformed keys', async () => {
      expect(await service.verify(`nck_${'f'.repeat(16)}_${'A'.repeat(43)}`)).toBeNull();
      expect(await service.verify('nck_short')).toBeNull();
      expect(await service.verify('')).toBeNull();
    });

    it('rejects a revoked key even after a cached successful verification', async () => {
      const created = await service.create({ name: 'CI', scopes: ['stats:read'] });
      expect(await service.verify(created.apiKey)).not.toBeNull();

      const revoked = service.revoke(created.id);
      expect(revoked?.revokedAt).not.toBeNull();
      expect(await service.verify(created.apiKey)).toBeNull();
    });
  });

  describe('hasActiveCredentials', () => {
    it('tracks non-revoked credentials', async () => {
      expect(service.hasActiveCredentials()).toBe(false);
      const created = await service.create({ name: 'CI', scopes: ['events:read'] });
      expect(service.hasActiveCredentials()).toBe(true);
      service.revoke(created.id);
      expect(service.hasActiveCredentials()).toBe(false);
    });
  });

  it('revoke() returns null for unknown ids', () => {
    expect(service.revoke('0000000000000000')).toBeNull();
  });
});
