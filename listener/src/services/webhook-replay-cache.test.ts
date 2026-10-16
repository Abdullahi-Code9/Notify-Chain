import { WebhookReplayCache, buildReplayCacheKey } from './webhook-replay-cache';

describe('WebhookReplayCache', () => {
  it('claims a key the first time and rejects the second claim inside the TTL', () => {
    const cache = new WebhookReplayCache();
    expect(cache.claim('a', 60_000)).toBe(true);
    expect(cache.claim('a', 60_000)).toBe(false);
  });

  it('allows the key again once the TTL has elapsed', () => {
    let now = 1_000_000;
    const cache = new WebhookReplayCache({ now: () => now });

    expect(cache.claim('a', 5_000)).toBe(true);

    now += 4_999;
    expect(cache.claim('a', 5_000)).toBe(false);

    now += 2; // TTL has now passed
    expect(cache.claim('a', 5_000)).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    const cache = new WebhookReplayCache();
    expect(cache.claim('a', 60_000)).toBe(true);
    expect(cache.claim('b', 60_000)).toBe(true);
    expect(cache.claim('a', 60_000)).toBe(false);
  });

  it('never grows beyond maxEntries', () => {
    const cache = new WebhookReplayCache({ maxEntries: 5 });
    for (let i = 0; i < 50; i++) {
      cache.claim(`key-${i}`, 60_000);
    }
    expect(cache.size).toBeLessThanOrEqual(5);
  });

  it('prefers evicting expired entries over live ones', () => {
    let now = 0;
    const cache = new WebhookReplayCache({ maxEntries: 3, now: () => now });

    // Two short-lived entries, then one long-lived.
    cache.claim('short-1', 1_000);
    cache.claim('short-2', 1_000);
    cache.claim('long', 1_000_000_000);

    now = 5_000; // short-* have expired, long has not
    cache.claim('fresh', 1_000_000_000);

    expect(cache.claim('short-1', 1_000_000_000)).toBe(true); // swept, so free
    expect(cache.claim('long', 1_000_000_000)).toBe(false); // still retained
  });

  it('sweep() removes only expired entries', () => {
    let now = 0;
    const cache = new WebhookReplayCache({ now: () => now });
    cache.claim('dead', 1_000);
    cache.claim('alive', 1_000_000);

    now = 2_000;
    cache.sweep();

    expect(cache.size).toBe(1);
    expect(cache.claim('alive', 1_000_000)).toBe(false);
    expect(cache.claim('dead', 1_000_000)).toBe(true);
  });

  it('clear() releases everything', () => {
    const cache = new WebhookReplayCache();
    cache.claim('a', 60_000);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.claim('a', 60_000)).toBe(true);
  });
});

describe('buildReplayCacheKey', () => {
  it('scopes the signature to the key id so two senders cannot collide', () => {
    expect(buildReplayCacheKey('key-a', 'sha256=abc')).not.toBe(
      buildReplayCacheKey('key-b', 'sha256=abc')
    );
  });

  it('is case-insensitive on the signature so hex casing cannot create a bypass', () => {
    expect(buildReplayCacheKey('key-a', 'sha256=ABCDEF')).toBe(
      buildReplayCacheKey('key-a', 'sha256=abcdef')
    );
  });
});
