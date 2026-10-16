# API Contract Tests

This directory contains automated contract tests that verify important listener API responses maintain their expected structure.

## Overview

Contract tests act as a safety net to catch breaking changes to documented API contracts. They verify that:
- Response structures match documentation
- Required fields are present
- Field types are correct
- Error responses follow expected formats

## Test Coverage

### Current Coverage (api-contract.test.ts)

The initial implementation covers approximately 2% of the overall API contract testing needs, focusing on the most critical endpoints:

#### Health & Status Endpoints
- **GET /health** - System health status with all service checks
- **GET /api/status** - Contract pause status verification
- **GET /api/indexing/health** - Indexing lag and processing status

#### Event Management
- **GET /api/events** - Contract event listing with pagination support
  - Verifies event structure (eventId, contractAddress, ledger, etc.)
  - Tests limit query parameter

#### Batch Validation
- **POST /api/notifications/validate-batch** - Batch notification validation
  - Tests valid batch responses
  - Tests invalid batch error handling

#### API Features
- **API Versioning** - Tests /api/v1/* route support and X-API-Version header
- **CORS** - Verifies OPTIONS request handling
- **Error Handling** - Tests 404 responses for unknown routes
- **Request Tracking** - Verifies X-Request-Id and X-Correlation-Id headers

## Running Tests

```bash
# Run all API contract tests
npm test -- api-contract.test.ts

# Run with coverage
npm test -- api-contract.test.ts --coverage

# Run in watch mode during development
npm test -- api-contract.test.ts --watch
```

## Response Format

All API responses follow the standardized envelope format:

**Success Response:**
```json
{
  "success": true,
  "data": { ... },
  "meta": { ... }  // optional
}
```

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { ... }  // optional
  }
}
```

## Future Expansion

To achieve full contract test coverage, additional tests should be added for:

### Scheduled Notifications
- POST /api/schedule - Create scheduled notification
- GET /api/schedule/:id - Retrieve notification by ID
- GET /api/schedule/stats - Queue statistics
- GET /api/schedule/execution-metrics - Delivery metrics
- GET /api/schedule/retry-distribution - Retry breakdown

### User Preferences
- GET /api/preferences/:userId - Get user preferences
- PUT /api/preferences/:userId - Update preferences

### Notification History
- GET /api/notifications/history - Delivery execution records with pagination

### Notification Search
- GET /api/notifications/search - Full-text and field-based search
- GET /api/search/suggestions - Autocomplete suggestions

### Template Management
- GET /api/templates - List templates
- POST /api/templates - Create template
- GET /api/templates/:id - Get template by ID
- GET /api/templates/by-key/:uniqueKey - Get by unique key
- PUT /api/templates/:id - Update template
- DELETE /api/templates/:id - Delete/deactivate template
- POST /api/templates/render - Render template with context

### Analytics
- GET /api/analytics - Current analytics snapshot
- GET /api/analytics/history - Historical metrics

### Webhooks
- POST /api/webhooks - Webhook delivery with signature verification

### Rate Limiting
- GET /api/rate-limit/metrics - Rate limit statistics

## Contributing

When adding new endpoints or modifying existing ones:

1. Update contract tests to match new response structures
2. Verify required fields are tested
3. Test both success and error cases
4. Ensure tests document expected behavior
5. Run tests to verify they pass before committing

## References

- Full API documentation: `listener/API.md`
- Response utilities: `listener/src/utils/response.ts`
- Error codes: `listener/API_ERROR_REFERENCE.md`
