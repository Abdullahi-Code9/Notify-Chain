# ADR-0001: Rate Limiting for API and RPC Requests

## Metadata

- **Status**: Accepted
- **Date**: 2026-09-30
- **Authors**: @lynndabel
- **Related Issues**: N/A
- **Supersedes**: N/A
- **Superseded By**: N/A

## Context

NotifyChain's backend services are exposed to external consumers via HTTP APIs and make outgoing RPC requests to the Stellar network. Without rate limiting, these services are vulnerable to:

1. **API Abuse**: Malicious or misconfigured clients could overwhelm the HTTP API with excessive requests, causing:
   - Denial of service for legitimate users
   - Excessive resource consumption (CPU, memory, database connections)
   - Increased costs from infrastructure scaling

2. **RPC Abuse**: The EventSubscriber polls the Stellar RPC for events. Without limits:
   - Excessive polling could trigger RPC provider rate limits
   - Resource consumption could spike during backfill or reorg scenarios
   - Costs could escalate with pay-as-you-go RPC providers

The existing codebase had rate limiting for HTTP API requests but no mechanism for limiting outgoing RPC requests from the EventSubscriber.

## Decision

We implement a dual-layer rate limiting system:

### Layer 1: HTTP API Rate Limiting (Existing)

- **Algorithm**: Sliding window with in-memory tracking
- **Scope**: Incoming HTTP requests to `/api/*` endpoints
- **Implementation**: `listener/src/api/rate-limiter.ts`
- **Features**:
  - Per-client identification (API key, Bearer token, IP address)
  - Configurable global and per-client limits
  - Database logging of violations
  - Real-time metrics endpoint
  - Standard rate limit headers (`X-RateLimit-*`, `Retry-After`)

### Layer 2: RPC Rate Limiting (New)

- **Algorithm**: Token bucket with throttling
- **Scope**: Outgoing RPC requests from EventSubscriber
- **Implementation**: `listener/src/services/rpc-rate-limiter.ts`
- **Features**:
  - Configurable sustained rate (`maxRequestsPerSecond`)
  - Burst capacity for short spikes (`burstSize`)
  - Configurable throttle delay when limits exceeded
  - Metrics tracking (total, allowed, throttled requests)
  - Can be disabled via configuration

### Configuration

Both layers are configured via environment variables:

```env
# HTTP API Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
RATE_LIMIT_CLIENT_OVERRIDES={}

# RPC Rate Limiting
RPC_RATE_LIMIT_ENABLED=true
RPC_RATE_LIMIT_MAX_REQUESTS_PER_SECOND=10
RPC_RATE_LIMIT_BURST_SIZE=20
RPC_RATE_LIMIT_THROTTLE_DELAY_MS=1000
```

### Integration Points

- **HTTP API**: Middleware in `listener/src/api/events-server.ts` before all routes
- **RPC**: Called in `EventSubscriber.getContractEvents()` before each RPC call

## Consequences

### Positive

- **Protection**: Both incoming and outgoing requests are protected from abuse
- **Configurability**: Operators can tune limits based on their infrastructure capacity
- **Observability**: Metrics and logging provide visibility into rate limiting behavior
- **Graceful Degradation**: Throttling prevents hard failures; requests are delayed rather than rejected
- **Backward Compatibility**: Rate limiting can be disabled if needed

### Negative

- **Latency**: Rate limiting adds minimal latency (~1-2ms for HTTP, variable for RPC throttling)
- **Complexity**: Additional configuration parameters increase operational complexity
- **Memory**: In-memory tracking consumes memory proportional to active clients
- **RPC Throttling**: During backfill or high-volume scenarios, event ingestion may be slower

### Risks

- **Misconfiguration**: Overly aggressive limits could block legitimate traffic
  - **Mitigation**: Default values are conservative; monitor metrics before tightening
- **Memory Exhaustion**: Large number of unique clients could exhaust memory
  - **Mitigation**: Automatic cache cleanup every 5 minutes; consider Redis for distributed deployments
- **RPC Provider Limits**: Our rate limiter may not align with RPC provider's actual limits
  - **Mitigation**: Document recommended settings for common RPC providers

## Alternatives Considered

| Alternative | Description | Rejected Because |
|-------------|-------------|------------------|
| Fixed Window | Simple counter that resets at fixed intervals | Bursts at window boundaries; less accurate than sliding window |
| Leaky Bucket | Requests queue at fixed rate; excess dropped | More complex to implement; sliding window provides similar protection for HTTP |
| Redis-based Distributed | Shared state across multiple instances | Adds infrastructure dependency; not needed for current single-instance deployments |
| No RPC Rate Limiting | Only limit HTTP API, trust RPC provider | Doesn't protect against excessive polling during backfill/reorg; could trigger provider limits |

## Implementation

### HTTP API Rate Limiting

- **Core**: `listener/src/api/rate-limiter.ts` - `RateLimiter` class
- **Integration**: `listener/src/api/events-server.ts` - middleware
- **Configuration**: `listener/src/config.ts` - `loadRateLimitConfig()`
- **Types**: `listener/src/types/index.ts` - `RateLimitConfig` interface
- **Tests**: `listener/src/api/rate-limiter.test.ts` - 16 test cases
- **Documentation**: `listener/RATE-LIMITING-GUIDE.md`, `RATE-LIMITING-IMPLEMENTATION.md`

### RPC Rate Limiting

- **Core**: `listener/src/services/rpc-rate-limiter.ts` - `RpcRateLimiter` class
- **Integration**: `listener/src/services/event-subscriber.ts` - call in `getContractEvents()`
- **Configuration**: `listener/src/config.ts` - `loadRpcRateLimitConfig()`
- **Types**: `listener/src/types/index.ts` - `RpcRateLimitConfig` interface
- **Tests**: `listener/src/services/rpc-rate-limiter.test.ts` - 14 test cases
- **Documentation**: Updated `.env.example` with RPC rate limiting section

### Key Design Decisions

1. **Separate Algorithms**: HTTP uses sliding window (accurate for API limits), RPC uses token bucket (better for sustained rate with bursts)
2. **Throttling vs Rejection**: RPC requests are throttled (delayed) rather than rejected to ensure event processing eventually completes
3. **Metrics Tracking**: Both layers track metrics for monitoring and debugging
4. **Configurable Defaults**: Conservative defaults that can be adjusted per deployment

## References

- [Rate Limiting Implementation Summary](../../RATE-LIMITING-IMPLEMENTATION.md)
- [Rate Limiting User Guide](../../listener/RATE-LIMITING-GUIDE.md)
- [Backend Architecture Documentation](../../BACKEND_ARCHITECTURE.md)
- [Architecture Overview](../../ARCHITECTURE_OVERVIEW.md)

---

## Notes

- Future enhancement: Consider Redis-based distributed rate limiting for multi-instance deployments
- Monitor `blockedRequests / totalRequests` ratio; alert if >10% (potential DoS) or >50% (configuration issue)
- RPC rate limiter is particularly important during backfill scenarios where large numbers of historical events are fetched
