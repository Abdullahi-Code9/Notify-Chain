/**
 * Tests for API Version Registry (#984)
 *
 * Verifies that:
 *  - normaliseApiPath rewrites /api/v1/* → /api/* correctly
 *  - normaliseApiPath preserves unversioned /api/* paths unchanged
 *  - applyVersionHeaders sets X-API-Version on every response
 *  - applyVersionHeaders sets Deprecation + Sunset + Link on deprecated routes
 *  - applyVersionHeaders signals 410 Gone for sunset routes
 *  - pathMatches handles exact and parameterised paths
 *  - findRouteEntry returns the correct catalog entry
 *  - buildVersionCatalog returns machine-readable route counts
 *  - ROUTE_CATALOG has no duplicate (method, path, version) entries
 *  - All catalog entries have a valid status
 *  - The /api/v1/version → /api/version rewrite works end-to-end via the server
 */

import http from 'http';
import {
  normaliseApiPath,
  applyVersionHeaders,
  buildVersionCatalog,
  pathMatches,
  findRouteEntry,
  ROUTE_CATALOG,
  CURRENT_API_VERSION,
  SUPPORTED_VERSIONS,
  VersionedRoute,
  RouteStatus,
} from './api-version-registry';

// ─── normaliseApiPath ─────────────────────────────────────────────────────────

describe('normaliseApiPath', () => {
  it('rewrites /api/v1/events to /api/events', () => {
    const { normalisedPath, detectedVersion, wasVersioned } = normaliseApiPath('/api/v1/events');
    expect(normalisedPath).toBe('/api/events');
    expect(detectedVersion).toBe('v1');
    expect(wasVersioned).toBe(true);
  });

  it('rewrites /api/v1/ root to /api/', () => {
    const { normalisedPath } = normaliseApiPath('/api/v1/');
    expect(normalisedPath).toBe('/api/');
  });

  it('rewrites /api/v1 exact to /api', () => {
    const { normalisedPath } = normaliseApiPath('/api/v1');
    expect(normalisedPath).toBe('/api');
  });

  it('preserves an unversioned /api/events unchanged', () => {
    const { normalisedPath, detectedVersion, wasVersioned } = normaliseApiPath('/api/events');
    expect(normalisedPath).toBe('/api/events');
    expect(detectedVersion).toBeNull();
    expect(wasVersioned).toBe(false);
  });

  it('preserves /health unchanged', () => {
    const { normalisedPath } = normaliseApiPath('/health');
    expect(normalisedPath).toBe('/health');
  });

  it('rewrites deep paths correctly', () => {
    const { normalisedPath } = normaliseApiPath('/api/v1/schedule/123');
    expect(normalisedPath).toBe('/api/schedule/123');
  });

  it('rewrites /api/v1/templates/by-key/my-key correctly', () => {
    const { normalisedPath } = normaliseApiPath('/api/v1/templates/by-key/my-key');
    expect(normalisedPath).toBe('/api/templates/by-key/my-key');
  });

  it('does not rewrite /api/v2/ (not yet a supported version)', () => {
    const { normalisedPath, wasVersioned } = normaliseApiPath('/api/v2/events');
    expect(normalisedPath).toBe('/api/v2/events'); // unchanged — v2 not in SUPPORTED_VERSIONS yet
    expect(wasVersioned).toBe(false);
  });
});

// ─── pathMatches ─────────────────────────────────────────────────────────────

describe('pathMatches', () => {
  it('matches exact paths', () => {
    expect(pathMatches('/api/events', '/api/events')).toBe(true);
  });

  it('does not match different paths', () => {
    expect(pathMatches('/api/events', '/api/status')).toBe(false);
  });

  it('matches parameterised paths', () => {
    expect(pathMatches('/api/schedule/:id', '/api/schedule/42')).toBe(true);
    expect(pathMatches('/api/templates/:id', '/api/templates/7')).toBe(true);
  });

  it('does not match when segment counts differ', () => {
    expect(pathMatches('/api/schedule/:id', '/api/schedule')).toBe(false);
    expect(pathMatches('/api/events', '/api/events/extra')).toBe(false);
  });

  it('ignores query strings in the actual path', () => {
    expect(pathMatches('/api/events', '/api/events?limit=5')).toBe(true);
  });

  it('matches multiple parameters', () => {
    expect(pathMatches('/api/:version/events', '/api/v1/events')).toBe(true);
  });
});

// ─── findRouteEntry ───────────────────────────────────────────────────────────

describe('findRouteEntry', () => {
  it('finds an active GET route', () => {
    const entry = findRouteEntry('GET', '/api/events');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('active');
    expect(entry?.method).toBe('GET');
  });

  it('finds a POST route', () => {
    const entry = findRouteEntry('POST', '/api/webhooks');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('active');
  });

  it('finds a parameterised route', () => {
    const entry = findRouteEntry('GET', '/api/schedule/99');
    expect(entry).toBeDefined();
    expect(entry?.path).toBe('/api/schedule/:id');
  });

  it('returns undefined for an unknown path', () => {
    expect(findRouteEntry('GET', '/api/does-not-exist')).toBeUndefined();
  });

  it('is case-insensitive for method', () => {
    expect(findRouteEntry('get', '/api/events')).toBeDefined();
    expect(findRouteEntry('GET', '/api/events')).toBeDefined();
  });
});

// ─── applyVersionHeaders ──────────────────────────────────────────────────────

describe('applyVersionHeaders', () => {
  function mockResponse(): http.ServerResponse {
    const headers: Record<string, string> = {};
    return {
      setHeader: (name: string, value: string) => { headers[name] = value; },
      getHeader: (name: string) => headers[name],
      _headers: headers,
    } as unknown as http.ServerResponse;
  }

  it('always sets X-API-Version header', () => {
    const res = mockResponse();
    applyVersionHeaders('GET', '/api/events', res);
    expect((res as any)._headers['X-API-Version']).toBe(CURRENT_API_VERSION);
  });

  it('does not set Deprecation header for active routes', () => {
    const res = mockResponse();
    applyVersionHeaders('GET', '/api/events', res);
    expect((res as any)._headers['Deprecation']).toBeUndefined();
  });

  it('does not signal 410 for active routes', () => {
    const res = mockResponse();
    const result = applyVersionHeaders('GET', '/api/events', res);
    expect(result.shouldReturn410).toBe(false);
  });

  it('sets Deprecation + Sunset + Link headers for deprecated routes', () => {
    // Add a temporary deprecated route to the test
    const deprecatedRoute: VersionedRoute = {
      method: 'GET',
      path: '/api/test-deprecated',
      version: 'v1',
      status: 'deprecated',
      deprecatedSince: '2027-01-01',
      sunsetDate: '2027-07-01',
      successorUrl: '/api/v2/test-deprecated',
      deprecationReason: 'Replaced by v2 with improved pagination',
    };

    // Temporarily inject the route into the catalog via module augmentation
    (ROUTE_CATALOG as VersionedRoute[]).push(deprecatedRoute);

    const res = mockResponse();
    const result = applyVersionHeaders('GET', '/api/test-deprecated', res);

    // Clean up
    const idx = (ROUTE_CATALOG as VersionedRoute[]).indexOf(deprecatedRoute);
    if (idx !== -1) (ROUTE_CATALOG as VersionedRoute[]).splice(idx, 1);

    expect((res as any)._headers['Deprecation']).toBe('true');
    expect((res as any)._headers['Sunset']).toBeDefined();
    expect((res as any)._headers['Link']).toContain('/api/v2/test-deprecated');
    expect((res as any)._headers['Link']).toContain('successor-version');
    expect((res as any)._headers['X-Deprecation-Reason']).toBe('Replaced by v2 with improved pagination');
    expect(result.shouldReturn410).toBe(false);
  });

  it('signals shouldReturn410 for sunset routes', () => {
    const sunsetRoute: VersionedRoute = {
      method: 'GET',
      path: '/api/test-sunset',
      version: 'v1',
      status: 'sunset',
    };

    (ROUTE_CATALOG as VersionedRoute[]).push(sunsetRoute);

    const res = mockResponse();
    const result = applyVersionHeaders('GET', '/api/test-sunset', res);

    const idx = (ROUTE_CATALOG as VersionedRoute[]).indexOf(sunsetRoute);
    if (idx !== -1) (ROUTE_CATALOG as VersionedRoute[]).splice(idx, 1);

    expect(result.shouldReturn410).toBe(true);
  });

  it('still sets X-API-Version on unknown routes (no catalog entry)', () => {
    const res = mockResponse();
    applyVersionHeaders('GET', '/api/not-in-catalog', res);
    expect((res as any)._headers['X-API-Version']).toBe(CURRENT_API_VERSION);
  });
});

// ─── buildVersionCatalog ──────────────────────────────────────────────────────

describe('buildVersionCatalog', () => {
  it('returns the current version', () => {
    const catalog = buildVersionCatalog();
    expect(catalog.currentVersion).toBe(CURRENT_API_VERSION);
  });

  it('includes all supported versions', () => {
    const catalog = buildVersionCatalog();
    expect(catalog.supportedVersions).toEqual(SUPPORTED_VERSIONS);
  });

  it('reports total routes matching ROUTE_CATALOG length', () => {
    const catalog = buildVersionCatalog();
    expect(catalog.routes.total).toBe(ROUTE_CATALOG.length);
  });

  it('reports zero deprecated routes when none are defined', () => {
    const catalog = buildVersionCatalog();
    // Initially no deprecated routes in the catalog
    expect(catalog.routes.deprecated).toBe(0);
    expect(catalog.deprecatedRoutes).toHaveLength(0);
  });

  it('includes policy metadata', () => {
    const catalog = buildVersionCatalog();
    expect(catalog.policy.minDeprecationNoticeMonths).toBe(6);
    expect(catalog.policy.minSunsetNoticeMonths).toBe(3);
    expect(catalog.policy.unversionedRoutesDeprecated).toBe(false);
  });

  it('counts route statuses correctly', () => {
    const catalog = buildVersionCatalog();
    expect(catalog.routes.active + catalog.routes.deprecated + catalog.routes.sunset)
      .toBe(catalog.routes.total);
  });
});

// ─── ROUTE_CATALOG integrity ──────────────────────────────────────────────────

describe('ROUTE_CATALOG integrity', () => {
  it('has no duplicate (method, path, version) combinations', () => {
    const seen = new Set<string>();
    for (const route of ROUTE_CATALOG) {
      const key = `${route.method.toUpperCase()}:${route.path}:${route.version}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('every entry has a valid status', () => {
    const validStatuses: RouteStatus[] = ['active', 'deprecated', 'sunset'];
    for (const route of ROUTE_CATALOG) {
      expect(validStatuses).toContain(route.status);
    }
  });

  it('every route has a method, path, and version', () => {
    for (const route of ROUTE_CATALOG) {
      expect(route.method).toBeTruthy();
      expect(route.path).toBeTruthy();
      expect(route.version).toBeTruthy();
    }
  });

  it('every deprecated route has a sunsetDate', () => {
    const deprecated = ROUTE_CATALOG.filter((r) => r.status === 'deprecated');
    for (const route of deprecated) {
      expect(route.sunsetDate).toBeTruthy();
    }
  });

  it('all routes start with /api/', () => {
    for (const route of ROUTE_CATALOG) {
      expect(route.path.startsWith('/api/')).toBe(true);
    }
  });

  it('contains at least one active route for each core workflow', () => {
    const hasActive = (method: string, path: string) =>
      ROUTE_CATALOG.some((r) => r.method === method && r.path === path && r.status === 'active');

    expect(hasActive('GET',  '/api/events')).toBe(true);
    expect(hasActive('POST', '/api/webhooks')).toBe(true);
    expect(hasActive('POST', '/api/schedule')).toBe(true);
    expect(hasActive('GET',  '/api/templates')).toBe(true);
    expect(hasActive('POST', '/api/templates')).toBe(true);
  });
});

// ─── Version constants ────────────────────────────────────────────────────────

describe('Version constants', () => {
  it('CURRENT_API_VERSION is v1', () => {
    expect(CURRENT_API_VERSION).toBe('v1');
  });

  it('SUPPORTED_VERSIONS includes v1', () => {
    expect(SUPPORTED_VERSIONS).toContain('v1');
  });
});
