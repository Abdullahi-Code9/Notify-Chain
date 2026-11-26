# NotifyChain OpenAPI Specification

Machine-readable reference for the NotifyChain Listener HTTP API.

| File | Purpose |
|------|---------|
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.0.3 specification for all public endpoints |

The specification is the canonical, machine-readable counterpart to the
human-readable docs in [`docs/API_ERROR_REFERENCE.md`](../API_ERROR_REFERENCE.md)
and [`docs/API_USAGE_EXAMPLES.md`](../API_USAGE_EXAMPLES.md).

## Coverage

The spec documents every route in the listener's canonical route catalog
(`listener/src/api/api-version-registry.ts`) plus additional public endpoints
implemented in `listener/src/api/events-server.ts` (credential management,
event history, SSE stream, data export, delivery/queue metrics, delivery
receipts, schedule cancel/resume, version catalog, and the `/health` probe).

For each operation it defines:

- **HTTP method and path** (including path/query/header parameters).
- **Request and response schemas** (`components.schemas`), using the standard
  success/error envelopes from `listener/src/utils/response.ts`.
- **Authentication** via the `ApiKeyAuth` scheme (`X-API-Key` header) and the
  HMAC-SHA256 webhook signing scheme (`X-Webhook-Signature` /
  `X-Webhook-Key-Id` / `X-Webhook-Timestamp`).
- **Error responses** for every status code the API emits, mapped to the stable
  machine-readable `error.code` values from
  `listener/src/errors/api-error-codes.ts`.
- **Representative examples** for requests and responses.

## Viewing / rendering

The spec is a standard OpenAPI 3.0.3 document and renders in any compliant
viewer. Common options:

- **Swagger Editor** — open <https://editor.swagger.io> and paste
  `openapi.yaml`, or use the hosted viewer.
- **Redoc** — `npx @redocly/cli preview-docs openapi.yaml`
- **Swagger UI (Docker)** —
  `docker run -p 8080:8080 -e SWAGGER_JSON=/openapi.yaml -v "$(pwd)/openapi.yaml:/openapi.yaml" swaggerapi/swagger-ui`
- **VS Code** — install an OpenAPI/Swagger extension and open the file.

## Validating

Validate the spec against the OpenAPI 3.0 schema with any standard tool, e.g.:

```bash
npx @apidevtools/swagger-cli validate openapi.yaml
# or
python -m openapi_spec_validator openapi.yaml
```

## Versioning

All endpoints accept both `/api/v1/*` and `/api/*` prefixes. See
[`docs/api-versioning.md`](../api-versioning.md) for the versioning and
deprecation policy. The `GET /api/version` endpoint exposes the live route
catalog and any deprecated routes with their sunset dates.

## Source of truth

When the API changes, update this spec alongside:

- Route catalog: `listener/src/api/api-version-registry.ts`
- Request dispatch: `listener/src/api/events-server.ts`
- Response envelope: `listener/src/utils/response.ts`
- Error codes: `listener/src/errors/api-error-codes.ts`
- Route-specific handlers in `listener/src/api/*.ts`