# HTTP request framing security (#1208)

The listener API accepts raw HTTP requests through Node's `http.createServer`.
Request boundaries must be interpreted identically by every component in the
path; otherwise a front proxy and the application can disagree about where one
request ends and the next begins (HTTP request smuggling).

## Enforcement

`listener/src/middleware/request-framing.ts` runs before body size limiting and
before routing. For `POST`, `PUT` and `PATCH`:

- `Content-Length` and `Transfer-Encoding` must never both be present.
- Repeated `Content-Length` values are accepted only when all values are the
  same decimal byte count; conflicting values are rejected.
- `Transfer-Encoding` must be exactly `chunked`; unsupported codings and
  multiple encodings are rejected.
- Accepted headers are canonicalized to a single value so downstream body
  handling sees one interpretation.

Rejections return HTTP 400 with `code: BAD_REQUEST` and a stable `reason`, and
the socket is destroyed before the body is read. Legitimate clients sending a
fixed-length body or a single `Transfer-Encoding: chunked` are unaffected.

## Trusted proxy requirements

Only a proxy that enforces the same framing rules may be placed in front of the
listener:

1. Reject requests carrying both `Content-Length` and `Transfer-Encoding`, and
   requests with conflicting or repeated `Content-Length` values.
2. Do not add, rewrite, or remove framing headers; forward the client's headers
   unchanged. In particular, do not convert chunked bodies to fixed-length ones
   without re-framing the body itself.
3. Terminate exactly one HTTP hop at the proxy and open a fresh connection to
   the listener. Proxy chains must apply the same policy at every hop.
4. Treat `X-Forwarded-For` as trustworthy only from that designated proxy; the
   listener currently uses the first value for client attribution.

Any deployment that cannot meet these requirements must terminate TLS and HTTP
directly at the listener rather than forwarding ambiguous requests.
