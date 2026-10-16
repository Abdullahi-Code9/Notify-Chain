/**
 * API Version Registry (#984)
 *
 * Centralises the API versioning strategy for the NotifyChain Listener.
 *
 * ## Versioning convention
 * URL-path prefix: `/api/vN/` (e.g. `/api/v1/events`)
 * Every response carries: `X-API-Version: vN`
 * Unversioned `/api/` routes remain functional for backward compatibility.
 *
 * ## Route lifecycle
 *
 *   active     — Stable and fully supported. No additional headers.
 *   deprecated — Still functional. Emits Deprecation + Sunset + Link headers.
 *   sunset     — Returns 410 Gone. Clients must have migrated.
 *
 * ## Breaking-change policy
 * 1. Introduce the new behaviour at `/api/v2/<endpoint>`.
 * 2. Keep `/api/v1/<endpoint>` (and `/api/<endpoint>`) unchanged.
 * 3. Mark the v1 route `deprecated` with a Sunset date ≥ 6 months out.
 * 4. After the Sunset date, change status to `sunset` (410 Gone).
 * 5. Document the change in CHANGELOG.md and docs/api-versioning.md.
 *
 * ## Migration path for existing consumers
 * - Unversioned `/api/*` callers: no action required — routes remain active.
 * - `/api/v1/*` callers: watch for `Deprecation: true` response headers.
 *   When present, migrate to the `/api/v2/*` URL listed in the `Link` header
 *   before the `Sunset` date.
 */

import http from 'http';

// ─── Version constants ────────────────────────────────────────────────────────

/** The current stable API version. Increment when introducing breaking changes. */
export const CURRENT_API_VERSION = 'v1';

/** All supported API version prefixes in the URL path. */
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = ['v1'] as const;

// ─── Route lifecycle types ────────────────────────────────────────────────────

export type RouteStatus = 'active' | 'deprecated' | 'sunset';

export interface VersionedRoute {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** Canonical (unversioned) path, e.g. `/api/events` */
  path: string;
  /** API version this entry describes */
  version: string;
  /** Lifecycle status */
  status: RouteStatus;
  /** ISO 8601 date when the route was deprecated (status = 'deprecated'). */
  deprecatedSince?: string;
  /** ISO 8601 date after which the route will stop working (status = 'deprecated'). */
  sunsetDate?: string;
  /** URL of the successor route in the next API version (shown in Link header). */
  successorUrl?: string;
  /** Human-readable reason for deprecation. */
  deprecationReason?: string;
}

// ─── Route catalog ────────────────────────────────────────────────────────────

/**
 * The canonical route catalog.
 *
 * All public routes that belong to a versioned API surface are listed here.
 * This is the single source of truth for the versioning policy.
 *
 * Rules:
 *  - Every new route starts as `active`.
 *  - When a breaking change is introduced, add a `deprecated` entry with a
 *    Sunset date at least 6 months in the future, and a `successorUrl`.
 *  - After the Sunset date passes, change status to `sunset`.
 */
export const ROUTE_CATALOG: ReadonlyArray<VersionedRoute> = [
  // ── v1 active routes ──────────────────────────────────────────────────────
  { method: 'GET', path: '/api/events', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/status', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/indexing/health', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/analytics', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/analytics/history', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/rate-limit/metrics', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/webhooks', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/notifications/validate-batch', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/notifications/import', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/notifications/history', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/notifications/search', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/notifications/health', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/schedule', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/stats', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/execution-metrics', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/retry-distribution', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/retry-statistics', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/queue', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/jobs', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/jobs/failures', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/schedule/:id', version: 'v1', status: 'active' },
  { method: 'DELETE', path: '/api/schedule/:id', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/search/suggestions', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/preferences/:userId', version: 'v1', status: 'active' },
  { method: 'PUT', path: '/api/preferences/:userId', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/templates', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/templates', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/templates/:id', version: 'v1', status: 'active' },
  { method: 'PUT', path: '/api/templates/:id', version: 'v1', status: 'active' },
  { method: 'DELETE', path: '/api/templates/:id', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/templates/render', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/templates/stats', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/templates/by-key/:uniqueKey', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/templates/:id/audit', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/archive', version: 'v1', status: 'active' },
  { method: 'GET', path: '/api/archive/:id', version: 'v1', status: 'active' },
  { method: 'POST', path: '/api/archive/run', version: 'v1', status: 'active' },

  // ── Example deprecated route (template for future use) ───────────────────
  // When a v2 breaking change is ready, add an entry like this:
  //
  // {
  //   method: 'GET',
  //   path: '/api/events',
  //   version: 'v1',
  //   status: 'deprecated',
  //   deprecatedSince: '2027-01-01',
  //   sunsetDate: '2027-07-01',
  //   successorUrl: '/api/v2/events',
  //   deprecationReason: 'Response shape changed in v2 to include pagination metadata',
  // },
] as const;

// ─── Path normalisation ───────────────────────────────────────────────────────

/**
 * Normalises a versioned path to its canonical (unversioned) form.
 *
 * Examples:
 *   /api/v1/events  →  /api/events
 *   /api/v2/events  →  /api/events   (used when v2 rewrite is added)
 *   /api/events     →  /api/events   (already canonical)
 *
 * The returned object also carries `detectedVersion` so callers can
 * decide which version-specific behaviour to apply.
 */
export function normaliseApiPath(pathname: string): {
  normalisedPath: string;
  detectedVersion: string | null;
  wasVersioned: boolean;
} {
  for (const version of SUPPORTED_VERSIONS) {
    const prefix = `/api/${version}/`;
    const exact = `/api/${version}`;
    if (pathname.startsWith(prefix)) {
      return {
        normalisedPath: pathname.replace(prefix, '/api/'),
        detectedVersion: version,
        wasVersioned: true,
      };
    }
    if (pathname === exact) {
      return { normalisedPath: '/api', detectedVersion: version, wasVersioned: true };
    }
  }
  return { normalisedPath: pathname, detectedVersion: null, wasVersioned: false };
}

// ─── Deprecation header middleware ────────────────────────────────────────────

/**
 * Applies RFC 8594-style deprecation headers to `res` when the matching
 * route entry has `status: 'deprecated'`.
 *
 * Headers added on deprecated routes:
 *   Deprecation: true
 *   Sunset: <RFC 7231 HTTP-date>
 *   Link: </api/v2/endpoint>; rel="successor-version"
 *
 * Returns `true` when sunset has passed and the caller should return 410 Gone.
 *
 * @param method          - HTTP method of the incoming request.
 * @param canonicalPath   - Unversioned canonical path (after normalisation).
 * @param res             - Response object to add headers to.
 */
export function applyVersionHeaders(
  method: string,
  canonicalPath: string,
  res: http.ServerResponse,
): { shouldReturn410: boolean } {
  res.setHeader('X-API-Version', CURRENT_API_VERSION);

  const entry = findRouteEntry(method, canonicalPath);
  if (!entry || entry.status === 'active') {
    return { shouldReturn410: false };
  }

  if (entry.status === 'sunset') {
    return { shouldReturn410: true };
  }

  // status === 'deprecated'
  res.setHeader('Deprecation', 'true');

  if (entry.sunsetDate) {
    // Convert ISO date to RFC 7231 HTTP-date format
    try {
      res.setHeader('Sunset', new Date(entry.sunsetDate).toUTCString());
    } catch {
      res.setHeader('Sunset', entry.sunsetDate);
    }
  }

  if (entry.successorUrl) {
    res.setHeader('Link', `<${entry.successorUrl}>; rel="successor-version"`);
  }

  if (entry.deprecationReason) {
    res.setHeader('X-Deprecation-Reason', entry.deprecationReason);
  }

  return { shouldReturn410: false };
}

// ─── Route lookup helpers ─────────────────────────────────────────────────────

/**
 * Finds the catalog entry for `method` + `canonicalPath`.
 * Supports parameterised paths like `/api/schedule/:id`.
 */
export function findRouteEntry(method: string, canonicalPath: string): VersionedRoute | undefined {
  const upperMethod = method.toUpperCase();
  return ROUTE_CATALOG.find((entry) => {
    if (entry.method.toUpperCase() !== upperMethod) return false;
    return pathMatches(entry.path, canonicalPath);
  });
}

/**
 * Returns `true` when `pattern` (which may contain `:param` segments)
 * matches `actualPath`.
 *
 * Examples:
 *   pathMatches('/api/schedule/:id', '/api/schedule/42')   → true
 *   pathMatches('/api/events',       '/api/events')         → true
 *   pathMatches('/api/events',       '/api/events?limit=5') → true (ignores query)
 */
export function pathMatches(pattern: string, actualPath: string): boolean {
  // Strip query string from actualPath
  const cleanPath = actualPath.split('?')[0] ?? actualPath;

  const patternSegments = pattern.split('/');
  const actualSegments = cleanPath.split('/');

  if (patternSegments.length !== actualSegments.length) return false;

  return patternSegments.every((seg, i) => {
    return seg.startsWith(':') || seg === actualSegments[i];
  });
}

// ─── Version catalog endpoint ─────────────────────────────────────────────────

/**
 * Returns a JSON-serialisable summary of the versioning strategy.
 * Exposed at `GET /api/version` for introspection.
 */
export function buildVersionCatalog(): {
  currentVersion: string;
  supportedVersions: readonly string[];
  policy: {
    unversionedRoutesDeprecated: boolean;
    minDeprecationNoticeMonths: number;
    minSunsetNoticeMonths: number;
  };
  routes: {
    active: number;
    deprecated: number;
    sunset: number;
    total: number;
  };
  deprecatedRoutes: ReadonlyArray<{
    method: string;
    path: string;
    version: string;
    sunsetDate?: string;
    successorUrl?: string;
    deprecationReason?: string;
  }>;
} {
  const active = ROUTE_CATALOG.filter((r) => r.status === 'active').length;
  const deprecated = ROUTE_CATALOG.filter((r) => r.status === 'deprecated');
  const sunset = ROUTE_CATALOG.filter((r) => r.status === 'sunset').length;

  return {
    currentVersion: CURRENT_API_VERSION,
    supportedVersions: SUPPORTED_VERSIONS,
    policy: {
      unversionedRoutesDeprecated: false,
      minDeprecationNoticeMonths: 6,
      minSunsetNoticeMonths: 3,
    },
    routes: {
      active,
      deprecated: deprecated.length,
      sunset,
      total: ROUTE_CATALOG.length,
    },
    deprecatedRoutes: deprecated.map((r) => ({
      method: r.method,
      path: r.path,
      version: r.version,
      sunsetDate: r.sunsetDate,
      successorUrl: r.successorUrl,
      deprecationReason: r.deprecationReason,
    })),
  };
}
