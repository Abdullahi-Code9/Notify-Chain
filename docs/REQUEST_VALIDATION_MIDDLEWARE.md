# Request Validation Middleware (#851)

The Request Validation Middleware provides centralized, declarative validation for incoming HTTP request bodies and parameters before they reach business logic and persistence layers.

## Overview & Acceptance Criteria

- **Consistent Rejection of Invalid Payloads**: All incoming requests to mutating and parameterized endpoints are intercepted, inspected against declarative schemas, and rejected early if malformed or containing invalid values.
- **Standardized Response Format**: Validation errors conform to the standard NotifyChain API error envelope (`sendErr`), providing machine-readable error codes (`BAD_REQUEST`, `PARSE_ERROR`, `PAYLOAD_TOO_LARGE`) and field-level issue diagnostics.
- **Backward Compatibility**: Existing valid payloads and legacy clients continue to work without modification, returning expected response structures and HTTP status codes (200, 201).

---

## 1. Architecture & Middleware Design

The validation system is located at `listener/src/middleware/request-validator.ts` and integrates with:
- `listener/src/utils/response.ts` (`sendErr`, `ErrorCode.BAD_REQUEST`)
- `listener/src/utils/validation.ts` (`InputValidator`, `ValidationIssue`, `ValidationError`)
- `listener/src/api/error-handler.ts` (`handleApiError`)
- `listener/src/api/events-server.ts`

### Request Lifecycle

```
[ Incoming Request ]
        │
        ▼
[ Size Limit Check ] ──── (Exceeds Limit) ───► HTTP 413 PAYLOAD_TOO_LARGE
        │
        ▼
[ JSON Parse Guard ] ──── (Malformed JSON) ──► HTTP 400 PARSE_ERROR
        │
        ▼
[ Schema Validation ] ─── (Invalid Fields) ──► HTTP 400 BAD_REQUEST + Issues
        │
        ▼ (Valid)
[ Business Logic & Controller ]
```

---

## 2. Standardized Error Response Format

When validation fails, the API responds with a consistent HTTP 400 (or 413 / 422 where appropriate) with a standardized payload envelope:

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed: Field 'executeAt' must be a valid date or ISO string",
    "details": [
      {
        "field": "executeAt",
        "message": "executeAt is not a valid date"
      },
      {
        "field": "targetRecipient",
        "message": "Field 'targetRecipient' is required"
      }
    ]
  }
}
```

### Malformed JSON Error Example

```json
{
  "success": false,
  "error": {
    "code": "PARSE_ERROR",
    "message": "Malformed JSON payload in request body",
    "details": [
      {
        "field": "body",
        "message": "Unexpected token } in JSON at position 42"
      }
    ]
  }
}
```

---

## 3. Centralized Schemas

The middleware provides pre-configured schemas in `Schemas`:

### `Schemas.scheduleNotification` (POST `/api/schedule`)
| Field | Type | Required | Rules / Constraints |
|-------|------|----------|---------------------|
| `executeAt` | `date` | Yes | Valid date, future ISO string, or timestamp |
| `payload` | `object` | Yes | Non-empty JSON object containing notification data |
| `targetRecipient` | `string` | Yes | Non-empty string recipient identifier |
| `notificationType` | `string` | No | One of: `discord`, `email`, `webhook`, `sms` |
| `maxRetries` | `integer` | No | Integer between `0` and `20` |
| `priority` | `integer` | No | Integer between `1` and `10` |
| `metadata` | `object` | No | Additional JSON metadata |
| `contractAddress` | `string` | No | Valid Stellar contract address |
| `eventId` | `string` | No | Reference event ID |

### `Schemas.createTemplate` (POST `/api/templates`)
| Field | Type | Required | Rules / Constraints |
|-------|------|----------|---------------------|
| `id` | `string` | Yes | Non-empty string template ID |
| `name` | `string` | Yes | Non-empty human-readable template name |
| `type` | `string` | Yes | Template category/channel |
| `body` | `string` | Yes | Template template text |
| `subject` | `string` | No | Subject line (for email) |
| `variables` | `any` | No | Variable mappings or list |
| `metadata` | `object` | No | Additional template metadata |

### `Schemas.batchValidate` (POST `/api/notifications/validate-batch`)
| Field | Type | Required | Rules / Constraints |
|-------|------|----------|---------------------|
| `notifications` | `array` | Yes | Array with between `1` and `1000` items |

### `Schemas.dataExport` (GET/POST `/api/admin/export`)
| Field | Type | Required | Rules / Constraints |
|-------|------|----------|---------------------|
| `type` | `string` | No | One of: `notifications`, `events`, `all` |
| `format` | `string` | No | One of: `json`, `csv` |
| `limit` | `integer` | No | Integer between `1` and `10000` |
| `offset` | `integer` | No | Integer >= 0 |
| `fromDate` | `date` | No | Valid ISO date string |
| `toDate` | `date` | No | Valid ISO date string |

---

## 4. Usage in Handlers

```typescript
import { validatePayload, Schemas } from '../middleware/request-validator';
import { sendErr, ErrorCode } from '../utils/response';

// Inside request handler:
const validation = validatePayload(body, Schemas.scheduleNotification);
if (!validation.valid) {
  sendErr(
    res,
    400,
    `Validation failed: ${validation.issues[0]?.message}`,
    ErrorCode.BAD_REQUEST,
    validation.issues
  );
  return;
}

// Proceed with typed validation.data
const { executeAt, payload, targetRecipient } = validation.data!;
```

Or using the streaming parser:

```typescript
import { parseAndValidateBody, Schemas } from '../middleware/request-validator';

const data = await parseAndValidateBody(req, res, Schemas.createTemplate, {
  requestId,
  correlationId,
  maxSizeBytes: 256 * 1024,
});

if (!data) return; // Validation failed, error response already sent

// Proceed with validated template
await templateService.create(data);
```
