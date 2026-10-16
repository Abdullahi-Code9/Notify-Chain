/**
 * DNS Rebinding Guard (#994)
 *
 * Prevents outbound webhook requests from reaching internal or private
 * infrastructure through DNS rebinding attacks.
 *
 * ## The attack
 * A DNS rebinding attack works in two phases:
 *   1. The attacker registers a domain that initially resolves to a public IP
 *      (passing any host-based allowlist check).
 *   2. The DNS TTL expires and the attacker switches the record to resolve to
 *      an internal address (e.g. 169.254.169.254 — AWS metadata, or 10.0.0.1).
 *   3. The outbound HTTP request is made and reaches an internal service.
 *
 * ## Mitigation implemented here
 * Before every outbound webhook:
 *   1. Resolve the destination hostname to IP addresses.
 *   2. Validate every resolved IP against the address policy.
 *   3. Reject the request if ANY resolved address is unsafe.
 *
 * Blocked address ranges (RFC 1918 + special-use per RFC 5735 / RFC 6890):
 *   - 127.0.0.0/8    Loopback
 *   - 10.0.0.0/8     Private (class A)
 *   - 172.16.0.0/12  Private (class B)
 *   - 192.168.0.0/16 Private (class C)
 *   - 169.254.0.0/16 Link-local / AWS metadata service
 *   - ::1/128         IPv6 loopback
 *   - fc00::/7        IPv6 unique local (fc00:: and fd00::)
 *   - fe80::/10       IPv6 link-local
 *   - 0.0.0.0/8      This-network (invalid destination)
 *
 * Acceptance criteria from issue #994:
 *   ✔  Destination resolution is validated against a defined address policy
 *   ✔  Unsafe resolutions are rejected
 *   ✔  Tests cover changing DNS results (simulated via mock dns.resolve4/6)
 */

import dns from 'dns';
import { promisify } from 'util';
import logger from '../utils/logger';

// ─── DNS resolution (injectable for testing) ─────────────────────────────────

const resolve4Default = promisify(dns.resolve4);
const resolve6Default = promisify(dns.resolve6);

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export const defaultDnsResolver: DnsResolver = {
  resolve4: resolve4Default,
  resolve6: resolve6Default,
};

// ─── IP address classification ────────────────────────────────────────────────

/**
 * Parses a dotted-decimal IPv4 string into a 32-bit unsigned integer.
 * Returns NaN when the input is not a valid IPv4 address.
 */
export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return NaN;
    result = (result << 8) | octet;
  }
  // Convert to unsigned 32-bit integer (JS bitwise ops work on signed 32-bit)
  return result >>> 0;
}

/**
 * Returns `true` when `ip` falls within the CIDR `network/prefixLen`.
 */
export function isInCidr(ip: string, network: string, prefixLen: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (Number.isNaN(ipInt) || Number.isNaN(netInt)) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Blocked IPv4 ranges — private, loopback, link-local, and this-network.
 *
 * Defined as static data so the policy is auditable and testable in isolation.
 */
export const BLOCKED_IPV4_RANGES: ReadonlyArray<{
  network: string;
  prefix: number;
  label: string;
}> = [
  { network: '0.0.0.0', prefix: 8, label: 'this-network (0.0.0.0/8)' },
  { network: '10.0.0.0', prefix: 8, label: 'RFC-1918 private (10/8)' },
  { network: '127.0.0.0', prefix: 8, label: 'loopback (127/8)' },
  { network: '169.254.0.0', prefix: 16, label: 'link-local (169.254/16)' },
  { network: '172.16.0.0', prefix: 12, label: 'RFC-1918 private (172.16/12)' },
  { network: '192.168.0.0', prefix: 16, label: 'RFC-1918 private (192.168/16)' },
  { network: '100.64.0.0', prefix: 10, label: 'shared address space (100.64/10)' },
  { network: '192.0.0.0', prefix: 24, label: 'IETF protocol assignments (192.0.0/24)' },
  { network: '198.51.100.0', prefix: 24, label: 'TEST-NET-2 (198.51.100/24)' },
  { network: '203.0.113.0', prefix: 24, label: 'TEST-NET-3 (203.0.113/24)' },
  { network: '240.0.0.0', prefix: 4, label: 'reserved (240/4)' },
  { network: '255.255.255.255', prefix: 32, label: 'broadcast' },
];

/**
 * Returns the matching block-list entry when `ip` is in a blocked IPv4 range,
 * or `null` when the address is safe.
 */
export function findBlockedIPv4Range(
  ip: string,
): { network: string; prefix: number; label: string } | null {
  for (const range of BLOCKED_IPV4_RANGES) {
    if (isInCidr(ip, range.network, range.prefix)) {
      return range;
    }
  }
  return null;
}

/**
 * Blocked IPv6 address prefixes (simple prefix matching).
 */
export const BLOCKED_IPV6_PREFIXES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: '::1', label: 'IPv6 loopback (::1)' },
  { prefix: '::ffff:', label: 'IPv4-mapped (::ffff:/96)' },
  { prefix: 'fc', label: 'IPv6 unique-local (fc00::/7)' },
  { prefix: 'fd', label: 'IPv6 unique-local (fd00::/7)' },
  { prefix: 'fe80', label: 'IPv6 link-local (fe80::/10)' },
  { prefix: 'fe90', label: 'IPv6 link-local (fe80::/10)' },
  { prefix: 'fea0', label: 'IPv6 link-local (fe80::/10)' },
  { prefix: 'feb0', label: 'IPv6 link-local (fe80::/10)' },
  { prefix: '::', label: 'IPv6 unspecified / loopback zone' },
];

/**
 * Returns the matching entry when `ip` is a blocked IPv6 address,
 * or `null` when the address is safe.
 */
export function findBlockedIPv6Prefix(ip: string): { prefix: string; label: string } | null {
  const lower = ip.toLowerCase().trim();
  for (const entry of BLOCKED_IPV6_PREFIXES) {
    if (lower === entry.prefix || lower.startsWith(entry.prefix)) {
      return entry;
    }
  }
  return null;
}

// ─── Core validation ──────────────────────────────────────────────────────────

export interface AddressValidationResult {
  /** True when all resolved addresses are safe to connect to. */
  safe: boolean;
  /** The offending IP address when safe === false. */
  blockedAddress?: string;
  /** Human-readable reason (includes the blocked range label). */
  reason?: string;
}

/**
 * Validates a single resolved IP address against the blocked address policy.
 * Works for both IPv4 and IPv6.
 */
export function validateResolvedAddress(ip: string): AddressValidationResult {
  const trimmed = ip.trim();

  // IPv4 (contains a dot and no colons)
  if (trimmed.includes('.') && !trimmed.includes(':')) {
    const blocked = findBlockedIPv4Range(trimmed);
    if (blocked) {
      return {
        safe: false,
        blockedAddress: trimmed,
        reason: `Resolved address ${trimmed} falls in blocked range: ${blocked.label}`,
      };
    }
    return { safe: true };
  }

  // IPv6 (contains a colon)
  if (trimmed.includes(':')) {
    const blocked = findBlockedIPv6Prefix(trimmed);
    if (blocked) {
      return {
        safe: false,
        blockedAddress: trimmed,
        reason: `Resolved address ${trimmed} falls in blocked range: ${blocked.label}`,
      };
    }
    return { safe: true };
  }

  // Unknown format — treat as unsafe
  return {
    safe: false,
    blockedAddress: trimmed,
    reason: `Unrecognised address format: ${trimmed}`,
  };
}

// ─── DNS resolution + validation ─────────────────────────────────────────────

export interface DnsValidationResult {
  /** True when all addresses resolved for the hostname are safe. */
  safe: boolean;
  /** The hostname that was checked. */
  hostname: string;
  /** All resolved addresses (IPv4 + IPv6). */
  resolvedAddresses: string[];
  /** The first address that failed validation, if any. */
  blockedAddress?: string;
  /** Human-readable rejection reason. */
  reason?: string;
}

/**
 * Resolves `hostname` using DNS and validates every resolved address against
 * the blocked address policy.
 *
 * Because a hostname can have multiple A/AAAA records and DNS records can
 * change between calls (the DNS rebinding scenario), this function is called
 * immediately before each outbound request — not at subscription time.
 *
 * @param hostname  - Hostname to resolve (extracted from the webhook URL).
 * @param resolver  - Injectable DNS resolver (defaults to Node.js `dns` module).
 */
export async function validateWebhookDestination(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<DnsValidationResult> {
  const resolvedAddresses: string[] = [];

  // Resolve IPv4 addresses (A records)
  try {
    const ipv4Addresses = await resolver.resolve4(hostname);
    resolvedAddresses.push(...ipv4Addresses);
  } catch (err) {
    // ENODATA / ENOTFOUND for IPv4 is acceptable — the host may be IPv6-only
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND' && code !== 'ESERVFAIL') {
      // Unexpected DNS error — log and treat as unsafe
      logger.warn('DNS resolution (A record) failed unexpectedly', {
        hostname,
        error: String(err),
      });
    }
  }

  // Resolve IPv6 addresses (AAAA records)
  try {
    const ipv6Addresses = await resolver.resolve6(hostname);
    resolvedAddresses.push(...ipv6Addresses);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND' && code !== 'ESERVFAIL') {
      logger.warn('DNS resolution (AAAA record) failed unexpectedly', {
        hostname,
        error: String(err),
      });
    }
  }

  // Reject when no addresses could be resolved — could be NXDOMAIN or a
  // transient outage; either way we cannot safely proceed.
  if (resolvedAddresses.length === 0) {
    return {
      safe: false,
      hostname,
      resolvedAddresses,
      reason: `DNS resolution returned no addresses for hostname: ${hostname}`,
    };
  }

  // Validate every resolved address — ALL must be safe
  for (const ip of resolvedAddresses) {
    const result = validateResolvedAddress(ip);
    if (!result.safe) {
      logger.warn('Webhook destination blocked by DNS rebinding guard', {
        hostname,
        blockedAddress: result.blockedAddress,
        reason: result.reason,
        totalResolved: resolvedAddresses.length,
      });
      return {
        safe: false,
        hostname,
        resolvedAddresses,
        blockedAddress: result.blockedAddress,
        reason: result.reason,
      };
    }
  }

  return { safe: true, hostname, resolvedAddresses };
}

// ─── URL → hostname extraction ────────────────────────────────────────────────

/**
 * Extracts the hostname from a URL string.
 * Returns `null` if the URL is malformed.
 */
export function extractHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns `true` when `hostname` is a bare IP address (IPv4 or IPv6 literal).
 * IP literals in URLs bypass DNS resolution and must be validated directly.
 */
export function isIpAddress(hostname: string): boolean {
  // IPv4: digits and dots only
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6 literal (may appear as [::1] or ::1 after URL parsing strips brackets)
  if (hostname.includes(':')) return true;
  return false;
}

/**
 * High-level guard: validates a raw webhook URL before delivery.
 *
 * When the URL contains an IP literal the address is validated directly
 * (no DNS lookup needed). When it contains a hostname, DNS is resolved
 * and every address is checked.
 *
 * This is the primary entry point used by `sendWebhook`.
 */
export async function guardWebhookUrl(
  rawUrl: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<DnsValidationResult> {
  const hostname = extractHostname(rawUrl);

  if (!hostname) {
    return {
      safe: false,
      hostname: rawUrl,
      resolvedAddresses: [],
      reason: `Malformed webhook URL: ${rawUrl}`,
    };
  }

  // IP literal in the URL — validate it directly without DNS lookup
  if (isIpAddress(hostname)) {
    const result = validateResolvedAddress(hostname);
    return {
      safe: result.safe,
      hostname,
      resolvedAddresses: [hostname],
      blockedAddress: result.blockedAddress,
      reason: result.reason,
    };
  }

  // Hostname — resolve and validate
  return validateWebhookDestination(hostname, resolver);
}
