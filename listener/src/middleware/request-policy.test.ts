import { DEFAULT_MAX_BODY_BYTES } from './body-limit';
import {
  ENDPOINT_BODY_LIMITS,
  IMPORT_ENDPOINT,
  IMPORT_MIME_TYPES,
  canonicalRequestPath,
  resolveRequestPolicy,
} from './request-policy';

describe('endpoint request policy (#1138)', () => {
  it('normalises versioned and trailing-slash paths', () => {
    expect(canonicalRequestPath('/api/v1/notifications/import/')).toBe(IMPORT_ENDPOINT);
    expect(canonicalRequestPath('/api/notifications/import?dryRun=true')).toBe(IMPORT_ENDPOINT);
  });

  it('uses larger ceilings for bulk endpoints', () => {
    expect(resolveRequestPolicy('POST', IMPORT_ENDPOINT).maxBytes).toBe(
      ENDPOINT_BODY_LIMITS[IMPORT_ENDPOINT],
    );
    expect(resolveRequestPolicy('POST', IMPORT_ENDPOINT).maxBytes).toBeGreaterThan(
      DEFAULT_MAX_BODY_BYTES,
    );
    expect(resolveRequestPolicy('POST', '/api/schedule').maxBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it('accepts CSV only on the import endpoint', () => {
    expect(resolveRequestPolicy('POST', IMPORT_ENDPOINT).allowedContentTypes).toEqual([
      ...IMPORT_MIME_TYPES,
    ]);
    expect(resolveRequestPolicy('POST', '/api/schedule').allowedContentTypes).toEqual([
      'application/json',
    ]);
  });

  it('keeps the configured default for requests without a body', () => {
    expect(resolveRequestPolicy('GET', IMPORT_ENDPOINT).maxBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolveRequestPolicy('OPTIONS', IMPORT_ENDPOINT, 512).maxBytes).toBe(512);
  });
});
