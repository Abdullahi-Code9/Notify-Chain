/**
 * Tests for DNS Rebinding Guard (#994)
 *
 * Verifies that:
 *  - Private/loopback/link-local IPv4 ranges are blocked
 *  - Public IPv4 addresses are allowed
 *  - Private/loopback IPv6 addresses are blocked
 *  - IP literals in URLs bypass DNS and are validated directly
 *  - Hostname DNS results are resolved and validated
 *  - CHANGING DNS RESULTS (the DNS rebinding scenario) are caught —
 *    a hostname that initially resolves to a public IP but later to a
 *    private one must be blocked on the second call
 *  - Malformed URLs are rejected
 *  - All resolved addresses must be safe (any private address fails the whole request)
 */

import {
  ipv4ToInt,
  isInCidr,
  findBlockedIPv4Range,
  findBlockedIPv6Prefix,
  validateResolvedAddress,
  validateWebhookDestination,
  guardWebhookUrl,
  extractHostname,
  isIpAddress,
  DnsResolver,
} from './dns-rebinding-guard';

// ─── Mock logger ──────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Helper: build a mock DnsResolver ────────────────────────────────────────

function mockResolver(ipv4: string[], ipv6: string[] = []): DnsResolver {
  return {
    resolve4: jest.fn<Promise<string[]>, []>().mockResolvedValue(ipv4),
    resolve6: jest.fn<Promise<string[]>, []>().mockResolvedValue(ipv6),
  };
}

/** Returns a resolver that throws ENODATA for both record types. */
function nxdomainResolver(): DnsResolver {
  const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  return {
    resolve4: jest.fn<Promise<string[]>, []>().mockRejectedValue(err),
    resolve6: jest.fn<Promise<string[]>, []>().mockRejectedValue(err),
  };
}

// ─── ipv4ToInt ────────────────────────────────────────────────────────────────

describe('ipv4ToInt', () => {
  it('converts 10.0.0.1 correctly', () => {
    expect(ipv4ToInt('10.0.0.1')).toBe((10 << 24) | (0 << 16) | (0 << 8) | 1);
  });

  it('converts 127.0.0.1 correctly', () => {
    // 127.0.0.1 = 127<<24 | 0<<16 | 0<<8 | 1 = 2130706432 + 1 = 2130706433
    expect(ipv4ToInt('127.0.0.1')).toBe(((127 << 24) | 1) >>> 0);
  });

  it('converts 255.255.255.255 correctly', () => {
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
  });

  it('returns NaN for non-IPv4 strings', () => {
    expect(ipv4ToInt('not-an-ip')).toBeNaN();
    expect(ipv4ToInt('::1')).toBeNaN();
    expect(ipv4ToInt('')).toBeNaN();
  });

  it('returns NaN when an octet is out of range', () => {
    expect(ipv4ToInt('256.0.0.1')).toBeNaN();
    expect(ipv4ToInt('10.0.0.999')).toBeNaN();
  });
});

// ─── isInCidr ─────────────────────────────────────────────────────────────────

describe('isInCidr', () => {
  it('matches an IP exactly in the network', () => {
    expect(isInCidr('10.0.0.1', '10.0.0.0', 8)).toBe(true);
    expect(isInCidr('10.255.255.255', '10.0.0.0', 8)).toBe(true);
  });

  it('rejects an IP outside the network', () => {
    expect(isInCidr('11.0.0.1', '10.0.0.0', 8)).toBe(false);
    expect(isInCidr('192.168.0.1', '10.0.0.0', 8)).toBe(false);
  });

  it('matches 172.16.0.0/12 correctly', () => {
    expect(isInCidr('172.16.0.1', '172.16.0.0', 12)).toBe(true);
    expect(isInCidr('172.31.255.255', '172.16.0.0', 12)).toBe(true);
    expect(isInCidr('172.32.0.0', '172.16.0.0', 12)).toBe(false);
  });

  it('matches 192.168.0.0/16 correctly', () => {
    expect(isInCidr('192.168.1.100', '192.168.0.0', 16)).toBe(true);
    expect(isInCidr('192.169.0.1', '192.168.0.0', 16)).toBe(false);
  });

  it('returns false for invalid IP strings', () => {
    expect(isInCidr('invalid', '10.0.0.0', 8)).toBe(false);
  });
});

// ─── findBlockedIPv4Range ─────────────────────────────────────────────────────

describe('findBlockedIPv4Range', () => {
  const blockedAddresses = [
    '127.0.0.1',      // loopback
    '10.0.0.1',       // RFC-1918 class A
    '10.255.255.255',
    '172.16.0.1',     // RFC-1918 class B
    '172.31.255.255',
    '192.168.0.1',    // RFC-1918 class C
    '192.168.100.200',
    '169.254.0.1',    // link-local (AWS metadata prefix)
    '169.254.169.254', // AWS instance metadata service
    '0.0.0.1',        // this-network
    '100.64.0.1',     // shared address space
    '255.255.255.255', // broadcast
  ];

  test.each(blockedAddresses)('%s is blocked', (ip) => {
    expect(findBlockedIPv4Range(ip)).not.toBeNull();
  });

  const safeAddresses = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',  // example.com
    '185.199.108.153', // GitHub
    '151.101.1.69',   // fastly CDN
  ];

  test.each(safeAddresses)('%s is allowed', (ip) => {
    expect(findBlockedIPv4Range(ip)).toBeNull();
  });
});

// ─── findBlockedIPv6Prefix ────────────────────────────────────────────────────

describe('findBlockedIPv6Prefix', () => {
  const blockedIPv6 = [
    '::1',
    'fc00::1',
    'fd00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::abcd:ef01',
    'fe90::1',
    'fea0::1',
    'feb0::1',
    '::ffff:192.168.1.1',
  ];

  test.each(blockedIPv6)('%s is blocked', (ip) => {
    expect(findBlockedIPv6Prefix(ip)).not.toBeNull();
  });

  const safeIPv6 = [
    '2001:db8::1',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2a00:1450:4001:81e::200e',
  ];

  test.each(safeIPv6)('%s is allowed', (ip) => {
    expect(findBlockedIPv6Prefix(ip)).toBeNull();
  });
});

// ─── validateResolvedAddress ──────────────────────────────────────────────────

describe('validateResolvedAddress', () => {
  it('returns safe:true for a public IPv4 address', () => {
    expect(validateResolvedAddress('8.8.8.8').safe).toBe(true);
  });

  it('returns safe:false for a private IPv4 address', () => {
    const result = validateResolvedAddress('10.0.0.1');
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('10.0.0.1');
    expect(result.reason).toMatch(/RFC-1918/);
  });

  it('returns safe:false for the AWS metadata service IP', () => {
    const result = validateResolvedAddress('169.254.169.254');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/link-local/i);
  });

  it('returns safe:false for localhost', () => {
    expect(validateResolvedAddress('127.0.0.1').safe).toBe(false);
  });

  it('returns safe:true for a public IPv6 address', () => {
    expect(validateResolvedAddress('2001:db8::1').safe).toBe(true);
  });

  it('returns safe:false for the IPv6 loopback', () => {
    expect(validateResolvedAddress('::1').safe).toBe(false);
  });

  it('returns safe:false for IPv6 unique-local (fd-prefix)', () => {
    expect(validateResolvedAddress('fd00::1').safe).toBe(false);
  });

  it('trims whitespace before checking', () => {
    expect(validateResolvedAddress('  8.8.8.8  ').safe).toBe(true);
    expect(validateResolvedAddress('  10.0.0.1  ').safe).toBe(false);
  });
});

// ─── extractHostname ──────────────────────────────────────────────────────────

describe('extractHostname', () => {
  it('extracts a hostname from an https URL', () => {
    expect(extractHostname('https://example.com/webhook')).toBe('example.com');
  });

  it('extracts a hostname from an http URL with port', () => {
    expect(extractHostname('http://api.example.com:8080/notify')).toBe('api.example.com');
  });

  it('extracts an IPv4 literal from a URL', () => {
    expect(extractHostname('http://192.168.1.1/webhook')).toBe('192.168.1.1');
  });

  it('returns null for a malformed URL', () => {
    expect(extractHostname('not-a-url')).toBeNull();
    expect(extractHostname('')).toBeNull();
  });
});

// ─── isIpAddress ──────────────────────────────────────────────────────────────

describe('isIpAddress', () => {
  it('identifies an IPv4 address', () => {
    expect(isIpAddress('192.168.1.1')).toBe(true);
    expect(isIpAddress('8.8.8.8')).toBe(true);
  });

  it('identifies an IPv6 address (with colons)', () => {
    expect(isIpAddress('2001:db8::1')).toBe(true);
    expect(isIpAddress('::1')).toBe(true);
  });

  it('returns false for a hostname', () => {
    expect(isIpAddress('example.com')).toBe(false);
    expect(isIpAddress('api.example.com')).toBe(false);
  });
});

// ─── validateWebhookDestination ───────────────────────────────────────────────

describe('validateWebhookDestination', () => {
  it('allows a hostname that resolves to a public IPv4 address', async () => {
    const resolver = mockResolver(['93.184.216.34']);
    const result = await validateWebhookDestination('example.com', resolver);
    expect(result.safe).toBe(true);
    expect(result.resolvedAddresses).toContain('93.184.216.34');
  });

  it('blocks a hostname that resolves to a private IPv4 address', async () => {
    const resolver = mockResolver(['10.0.0.1']);
    const result = await validateWebhookDestination('internal.example.com', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('10.0.0.1');
    expect(result.reason).toMatch(/RFC-1918/);
  });

  it('blocks the AWS metadata service IP (169.254.169.254)', async () => {
    const resolver = mockResolver(['169.254.169.254']);
    const result = await validateWebhookDestination('metadata.example.com', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('169.254.169.254');
  });

  it('blocks when ANY of multiple resolved addresses is private', async () => {
    // Even if one IP is public, a private IP in the same record set must block
    const resolver = mockResolver(['93.184.216.34', '10.0.0.1']);
    const result = await validateWebhookDestination('multi.example.com', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('10.0.0.1');
    expect(result.resolvedAddresses).toHaveLength(2);
  });

  it('allows a hostname that resolves to only public addresses', async () => {
    const resolver = mockResolver(['93.184.216.34', '93.184.216.35'], ['2001:db8::1']);
    const result = await validateWebhookDestination('example.com', resolver);
    expect(result.safe).toBe(true);
  });

  it('blocks when the hostname resolves to no addresses (NXDOMAIN)', async () => {
    const result = await validateWebhookDestination('nonexistent.invalid', nxdomainResolver());
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/no addresses/);
  });

  it('blocks a hostname that resolves to a private IPv6 address', async () => {
    const resolver = mockResolver([], ['fd00::1']);
    const result = await validateWebhookDestination('ipv6.example.com', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('fd00::1');
  });

  // ── DNS REBINDING — THE KEY SCENARIO ─────────────────────────────────────
  // The test below simulates the attack: a domain initially resolves to a
  // public IP, then the attacker changes the DNS record to a private IP.
  // Because we re-resolve on every call, the second call is blocked.

  describe('DNS rebinding simulation — changing DNS results', () => {
    it('first resolves to a public IP (allowed), then to a private IP (blocked)', async () => {
      let callCount = 0;
      const rebindingResolver: DnsResolver = {
        resolve4: jest.fn<Promise<string[]>, []>().mockImplementation(async () => {
          callCount += 1;
          if (callCount === 1) return ['93.184.216.34']; // First call: public
          return ['169.254.169.254'];                    // Subsequent calls: AWS metadata (rebind!)
        }),
        resolve6: jest.fn<Promise<string[]>, []>().mockResolvedValue([]),
      };

      const firstResult = await validateWebhookDestination('rebind.example.com', rebindingResolver);
      expect(firstResult.safe).toBe(true);
      expect(firstResult.resolvedAddresses).toContain('93.184.216.34');

      const secondResult = await validateWebhookDestination('rebind.example.com', rebindingResolver);
      expect(secondResult.safe).toBe(false);
      expect(secondResult.blockedAddress).toBe('169.254.169.254');
      expect(secondResult.reason).toMatch(/link-local/i);
    });

    it('detects a TTL-expiry rebind to a loopback address', async () => {
      let calls = 0;
      const resolver: DnsResolver = {
        resolve4: jest.fn<Promise<string[]>, []>().mockImplementation(async () => {
          calls++;
          return calls === 1 ? ['8.8.8.8'] : ['127.0.0.1'];
        }),
        resolve6: jest.fn<Promise<string[]>, []>().mockResolvedValue([]),
      };

      const r1 = await validateWebhookDestination('dns-rebind.example.com', resolver);
      expect(r1.safe).toBe(true);

      const r2 = await validateWebhookDestination('dns-rebind.example.com', resolver);
      expect(r2.safe).toBe(false);
      expect(r2.blockedAddress).toBe('127.0.0.1');
    });

    it('detects a rebind to an RFC-1918 private address (class C)', async () => {
      let calls = 0;
      const resolver: DnsResolver = {
        resolve4: jest.fn<Promise<string[]>, []>().mockImplementation(async () => {
          calls++;
          return calls === 1 ? ['1.1.1.1'] : ['192.168.1.100'];
        }),
        resolve6: jest.fn<Promise<string[]>, []>().mockResolvedValue([]),
      };

      const r1 = await validateWebhookDestination('evil.example.com', resolver);
      expect(r1.safe).toBe(true);

      const r2 = await validateWebhookDestination('evil.example.com', resolver);
      expect(r2.safe).toBe(false);
      expect(r2.reason).toMatch(/RFC-1918/);
    });
  });
});

// ─── guardWebhookUrl ──────────────────────────────────────────────────────────

describe('guardWebhookUrl', () => {
  it('allows an https URL resolving to a public IP', async () => {
    const resolver = mockResolver(['93.184.216.34']);
    const result = await guardWebhookUrl('https://example.com/webhook', resolver);
    expect(result.safe).toBe(true);
    expect(result.hostname).toBe('example.com');
  });

  it('blocks an https URL resolving to a private IP', async () => {
    const resolver = mockResolver(['10.0.0.1']);
    const result = await guardWebhookUrl('https://internal.corp/api', resolver);
    expect(result.safe).toBe(false);
  });

  it('blocks a URL with a private IPv4 literal (no DNS lookup needed)', async () => {
    // No resolver call should be made for IP literals
    const resolver = mockResolver([]);
    const result = await guardWebhookUrl('http://192.168.1.1/hook', resolver);
    expect(result.safe).toBe(false);
    expect(result.hostname).toBe('192.168.1.1');
  });

  it('blocks a URL with the loopback IP literal', async () => {
    const resolver = mockResolver([]);
    const result = await guardWebhookUrl('http://127.0.0.1:3000/hook', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('127.0.0.1');
  });

  it('blocks a URL with the AWS metadata IP literal', async () => {
    const resolver = mockResolver([]);
    const result = await guardWebhookUrl('http://169.254.169.254/latest/meta-data/', resolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('169.254.169.254');
  });

  it('allows a URL with a public IP literal', async () => {
    const resolver = mockResolver([]);
    const result = await guardWebhookUrl('https://8.8.8.8/webhook', resolver);
    expect(result.safe).toBe(true);
  });

  it('rejects a malformed URL', async () => {
    const resolver = mockResolver([]);
    const result = await guardWebhookUrl('this is not a url', resolver);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/Malformed webhook URL/);
  });

  it('populates resolvedAddresses in the result', async () => {
    const resolver = mockResolver(['8.8.8.8', '8.8.4.4']);
    const result = await guardWebhookUrl('https://dns.google/webhook', resolver);
    expect(result.safe).toBe(true);
    expect(result.resolvedAddresses).toEqual(expect.arrayContaining(['8.8.8.8', '8.8.4.4']));
  });

  it('blocks when DNS returns both IPv4 public and IPv6 private addresses', async () => {
    const mixedResolver: DnsResolver = {
      resolve4: jest.fn<Promise<string[]>, []>().mockResolvedValue(['93.184.216.34']),
      resolve6: jest.fn<Promise<string[]>, []>().mockResolvedValue(['fd00::1']),
    };
    const result = await guardWebhookUrl('https://mixed.example.com/hook', mixedResolver);
    expect(result.safe).toBe(false);
    expect(result.blockedAddress).toBe('fd00::1');
  });
});
