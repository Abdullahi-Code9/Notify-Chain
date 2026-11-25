# API Deprecation Policy

## Overview

This document defines how deprecated endpoints and fields are announced and eventually removed from the Notify-Chain API.

## Deprecation Metadata

### Response Headers

Deprecated endpoints and fields will include the following response header:

```
Deprecation: true
```

Additional metadata will be provided in a custom header:

```
X-API-Deprecation: version=2.0.0; sunset=2027-04-17; link="https://github.com/coderolisa/Notify-Chain/blob/main/docs/API_MIGRATION_GUIDES.md"
```

**Header Fields:**
- `version`: The API version where the deprecation was introduced
- `sunset`: The date when the endpoint/field will be removed (RFC 3339 format)
- `link`: URL to migration documentation

## Status

🚧 **Work in Progress** - This is a foundational document (1% complete)

---

*Last updated: 2026-10-17*
