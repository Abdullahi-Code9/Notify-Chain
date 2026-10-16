# API Usage Examples

NotifyChain exposes a small HTTP JSON API for creating, scheduling, and inspecting notifications. The examples below cover the common workflows.

All requests are sent to the API base URL (default: `http://localhost:8080`) and must include an `Authorization: Bearer <token>` or `X-API-Key: <api-key>` header when authentication is enabled.

## Contents Type

All request bodies are JSON and must be sent with `Content-Type: application/json`. Responses are JSON with an appropriate HTTP status code.

## Creating Notifications

Create a notification that is delivered immediately.

```bash
curl -X POST http://localhost:8080/api/v1/notifications \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{
    "channel": "email",
    "recipient": "user@example.com",
    "template": "welcome",
    "data": {
      "name": "Alice"
    }
  }'
```

Expected response (`201 Created`):

```json
{
  "id": "b3bc1ae2-7f4d-4c19-8a2b-1f0e5d3c4b6a",
  "channel": "email",
  "recipient": "user@example.com",
  "template": "welcome",
  "status": "queued",
  "created_at": "2024-01-15T10:30:00Z",
  "scheduled_at": null
}
```

## Scheduling Notifications

Provide a scheduled_at timestamp (RFC 3339, UTC) to defer delivery.

```bash
curl -X POST http://localhost:8080/api/v1/notifications \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $TOKEN' \
  -d '{
    "channel": "sms",
    "recipient": "+15551234567",
    "template": "reminder",
    "data": {
      "event": "conference"
    },
    "scheduled_at": "2024-02-01T09:00:00Z"
  }'
```

Expected response (`201 Created`):

```json
{
  "id": "c4d5e6f7-8a9b-4c2d-1e3f-4a5b6c7d8e9f",
  "channel": "sms",
  "recipient": "+15551234567",
  "template": "reminder",
  "status": "scheduled",
  "created_at": "2024-01-15T10:30:00Z",
  "scheduled_at": "2024-02-01T09:00:00Z"
}
```

To cancel a scheduled notification before it is delivered:

```bash
curl -X DELETE http://localhost:8080/api/v1/notifications/c4d5e6f7-8a9b-4c2d-1e3f-4a5b6c7d8e9f \
  -H 'Authorization: Bearer $TOKEN'
```

Expected response (`204 No Content`).

## Querying Event History

List notification events with filters and pagination.

```bash
curl -G 'http://localhost:8080/api/v1/events?status=delivered&limit=20' \
  -H 'Authorization: Bearer $TOKEN'
```

Expected response (`200 OK`):

```json
{
  "events": [
    {
      "id": "e1f2a3b4-5c6d-7e8f-9a0b-1c2d3e4f5ga6",
      "notification_id": "b3bc1ae2-7f4d-4c19-8a2b-1f0e5d3c4b6a",
      "type": "delivered",
      "channel": "email",
      "occurred_at": "2024-01-15T10:30:05Z",
      "details": {
        "provider": "sesp"
      }
    }
  ],
  "next_cursor": "eyJpZCI6ImUxZjJhM2I0LTVjNmQtN2U4Zi1hMGItLTFjMmQzNTRmNWFhNiJ9",
  "has_more": false
}
```

Query a cursor page:

```bash
curl -G 'http:localhost:8080/api/v1/events?limit=20&cursor=eyJpZCI6ImUxZjJhM2I0LTVjNmQtN2U4Zi1hMGItLTFjMmQzNTRmNWFhNiJ9' \
  -H 'Authorization: Bearer $TOKEN'
```

## Checking Delivery Status

Fetch the current status of a notification.

```bash
curl -G http://localhost:8080/api/v1/notifications/b3bc1ae2-7f4d-4c19-8a2b-1f0e5d3c4b6a \
  -H 'Authorization: Bearer $TOKEN'
```

Expected response (`200 OK`):

```json
{
  "id": "b3bc1ae2-7f4d-4c19-8a2b-1f0e5d3c4b6a",
  "channel": "email",
  "recipient": "user@example.com",
  "template": "welcome",
  "status": "delivered",
  "created_at": "2024-01-15T10:30:00Z",
  "scheduled_at": null,
  "delivered_at": "2024-01-15T10:30:05Z",
  "attempts": 1
}
```

Possible status values: `queued`, `scheduled`, `processing`, `delivered`, `failed`, `cancelled`.

## Handling API Errors

Error responses use the appropriate HTTP status code and a consistent JSON body:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Recipient is required",
    "details": [
      {
        "field": "recipient",
        "issue": "missing"
      }
    ]
  }
}
```

Common error codes:

| HTTP Status | Error Code           | Description                                         |
|-------------|--------------------|--------------------------------------------------------|
| 400         | `validation_error`   | The request body failed validation.                     |
| 401         | `unauthorized`       | Missing or invalid credentials.                         |
| 403         | `forbidden`         | Authenticated but not allowed to access the resource.    |
| 404         | `not_found`        | The requested notification or event does not exist.      |
| 409         | `conflict`          | The request conflicts with the current state.             |
| 422         | `unprocessable_entity` | The request was well-formed but could not be processed. |
| 429         | `rate_limited`      | Too many requests; retry after the `Retry-After` delay.    |
| 500         | `internal_error`    | Unexpected server error.                               |

## Handling Errors in Code

The following Python example uses the standard library and shows retry behavior for rate limits and transient server errors.

```python
import json
import time
import urllib
from typing import Any, Dict

BASE_URL = "http://localhost:8080/api/v1"


def request(method: str, path: str, token: str, payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
    data = json.encode(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = json.loads(read.read()) if (body := exc.read()) else {}
        raise ApiError(exc.code, body.get("error", {})) from exc


class ApiError(Exception):
    def __init__(self, status: int, error: Dict[str, Any]):
        super().__init__(error.get("message", "API error"))
        self.status = status
        self.code = error.get("code")
        self.details = error.get("details", [])


def create_notification(token: str, payload: Dict[str, Any], retries: int = 3) -> Dict[str, Any]:
    for attempt in range(retries):
        try:
            return request("POST", "/notifications", token, payload)
        except ApiError as err:
            if err.status in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
    raise RuntimeError("retries exhausted")
```

## Related Documentation

- Authentication and authorization requirements.
- Channel configuration for email, SMS, and webhook delivery.
- Template reference and variable substitution rules.
