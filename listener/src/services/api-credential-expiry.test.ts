import {
  ApiCredentialService,
  CredentialValidationError,
} from './api-credential-service';

describe('API credential expiry (#1207)', () => {
  it('stops authorizing an expired credential even on a verification cache hit', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new ApiCredentialService({
      now: () => now,
      verifyCacheTtlMs: 60 * 60 * 1000,
    });

    const created = await service.create({
      name: 'short-lived dashboard integration',
      scopes: ['events:read'],
      expiresAt: '2026-01-01T00:01:00.000Z',
    });

    expect(await service.verify(created.apiKey)).not.toBeNull();

    now = new Date('2026-01-01T00:02:00.000Z');
    expect(await service.verify(created.apiKey)).toBeNull();
    expect(service.hasActiveCredentials()).toBe(false);
  });

  it('rejects an expiry that is not a future ISO timestamp', async () => {
    const service = new ApiCredentialService();

    await expect(
      service.create({
        name: 'bad expiry',
        scopes: ['events:read'],
        expiresAt: 'yesterday',
      }),
    ).rejects.toBeInstanceOf(CredentialValidationError);

    await expect(
      service.create({
        name: 'past expiry',
        scopes: ['events:read'],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(CredentialValidationError);
  });
});
