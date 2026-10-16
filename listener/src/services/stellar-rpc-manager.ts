import * as StellarSDK from '@stellar/stellar-sdk';
import logger, * as loggerModule from '../utils/logger';
import { RpcEndpointStatus, RpcFallbackConfig } from '../types';

function sanitizeUrl(rawUrl: string): string {
  if (typeof (loggerModule as any).sanitizeUrl === 'function') {
    return (loggerModule as any).sanitizeUrl(rawUrl);
  }
  const queryStart = rawUrl.indexOf('?');
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

export interface RpcManagerOptions {
  primaryUrl: string;
  fallbackUrls?: string[];
  failureThreshold?: number;
  cooldownMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  serverFactory?: (url: string) => StellarSDK.rpc.Server;
}

interface InternalEndpointState {
  url: string;
  isPrimary: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastError: string | null;
  server: StellarSDK.rpc.Server;
}

export interface FailureEvaluation {
  isFailure: boolean;
  reason: string;
}

/**
 * Determines whether an error qualifies as an RPC service unavailability condition
 * that warrants failover (network errors, timeouts, 5xx, 429, server RPC errors).
 * Client errors (e.g. invalid arguments) are explicitly rejected as failure conditions.
 */
export function isRpcFailureCondition(error: unknown): FailureEvaluation {
  if (!error) {
    return { isFailure: false, reason: 'Unknown empty error' };
  }

  const errObj = error as Record<string, any>;
  const name = String(errObj.name || '');
  const message = String(errObj.message || error);
  const code = String(errObj.code || errObj.cause?.code || '');
  const status = Number(errObj.status || errObj.statusCode || errObj.response?.status || 0);

  // 1. Timeouts (request timeouts, abort signals)
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    message.toLowerCase().includes('timed out') ||
    message.toLowerCase().includes('timeout')
  ) {
    return {
      isFailure: true,
      reason: `RPC request timed out (${message || name})`,
    };
  }

  // 2. Network connectivity / DNS / Socket errors
  const networkErrorCodes = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'EAI_AGAIN',
  ];

  if (networkErrorCodes.includes(code)) {
    return {
      isFailure: true,
      reason: `Network connection error: ${code} (${message})`,
    };
  }

  const networkMessagePatterns = [
    'econnrefused',
    'enotfound',
    'econnreset',
    'etimedout',
    'ehostunreach',
    'socket hang up',
    'fetch failed',
    'network error',
    'connection refused',
    'failed to fetch',
    'connect etimedout',
  ];

  const lowerMessage = message.toLowerCase();
  for (const pattern of networkMessagePatterns) {
    if (lowerMessage.includes(pattern)) {
      return {
        isFailure: true,
        reason: `Network failure: ${pattern} (${message})`,
      };
    }
  }

  // 3. HTTP Server Status Codes (5xx)
  if (status >= 500 && status < 600) {
    return {
      isFailure: true,
      reason: `HTTP ${status} server error from RPC endpoint`,
    };
  }

  // 4. Rate limiting (HTTP 429 Too Many Requests)
  if (status === 429 || lowerMessage.includes('too many requests') || lowerMessage.includes('rate limit')) {
    return {
      isFailure: true,
      reason: 'RPC service rate limit exceeded (HTTP 429 / Rate Limited)',
    };
  }

  // HTTP 5xx embedded in message strings
  if (
    lowerMessage.includes('500 internal server error') ||
    lowerMessage.includes('502 bad gateway') ||
    lowerMessage.includes('503 service unavailable') ||
    lowerMessage.includes('504 gateway timeout') ||
    lowerMessage.includes('bad gateway') ||
    lowerMessage.includes('service unavailable')
  ) {
    return {
      isFailure: true,
      reason: `HTTP server error response: ${message}`,
    };
  }

  // 5. JSON-RPC Protocol Server Errors
  // Code -32603: Internal JSON-RPC error
  // Codes -32000 to -32099: Server-defined implementation errors
  const rpcCode = Number(errObj.rpcCode || errObj.error?.code || 0);
  if (rpcCode === -32603 || (rpcCode <= -32000 && rpcCode >= -32099)) {
    return {
      isFailure: true,
      reason: `JSON-RPC server error code ${rpcCode}: ${message}`,
    };
  }

  // Node desynchronized or catchup failure
  if (
    lowerMessage.includes('node is syncing') ||
    lowerMessage.includes('behind ledger') ||
    lowerMessage.includes('service is temporarily unavailable')
  ) {
    return {
      isFailure: true,
      reason: `Stellar RPC node unready/unsynced: ${message}`,
    };
  }

  // Explicit client application error codes should NOT trigger failover
  // E.g., -32602 (Invalid params), -32601 (Method not found), -32600 (Invalid Request)
  if (rpcCode === -32602 || rpcCode === -32601 || rpcCode === -32600) {
    return {
      isFailure: false,
      reason: `Client JSON-RPC error code ${rpcCode}`,
    };
  }

  return {
    isFailure: false,
    reason: `Non-availability error: ${message}`,
  };
}

/**
 * Manages Stellar RPC endpoint pool with health tracking, failure condition detection,
 * automatic failover, and structured logging of endpoint switching.
 */
export class StellarRpcManager {
  private endpoints: InternalEndpointState[] = [];
  private activeIndex: number = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private requestTimeoutMs: number;
  private maxRetries: number;
  private serverFactory: (url: string) => StellarSDK.rpc.Server;

  constructor(options: RpcManagerOptions) {
    const primary = options.primaryUrl.trim();
    if (!primary) {
      throw new Error('StellarRpcManager requires a non-empty primaryUrl');
    }

    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.serverFactory =
      options.serverFactory ?? ((url: string) => new StellarSDK.rpc.Server(url));

    // Deduplicate endpoints and preserve order: primary first, followed by unique fallbacks
    const seenUrls = new Set<string>();
    const allUrls: Array<{ url: string; isPrimary: boolean }> = [];

    seenUrls.add(primary);
    allUrls.push({ url: primary, isPrimary: true });

    if (options.fallbackUrls && Array.isArray(options.fallbackUrls)) {
      for (const rawUrl of options.fallbackUrls) {
        const trimmed = rawUrl.trim();
        if (trimmed && !seenUrls.has(trimmed)) {
          seenUrls.add(trimmed);
          allUrls.push({ url: trimmed, isPrimary: false });
        }
      }
    }

    this.maxRetries = options.maxRetries ?? allUrls.length;

    this.endpoints = allUrls.map(({ url, isPrimary }) => ({
      url,
      isPrimary,
      status: 'healthy',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      lastError: null,
      server: this.serverFactory(url),
    }));

    this.activeIndex = 0;

    logger.info('StellarRpcManager initialized', {
      primaryEndpoint: sanitizeUrl(primary),
      fallbackCount: this.endpoints.length - 1,
      fallbackEndpoints: this.endpoints.slice(1).map((e) => sanitizeUrl(e.url)),
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }

  /**
   * Returns the active endpoint URL.
   */
  public getActiveEndpoint(): string {
    return this.endpoints[this.activeIndex].url;
  }

  /**
   * Returns the Stellar SDK RPC Server instance for the active endpoint.
   */
  public getActiveServer(): StellarSDK.rpc.Server {
    return this.endpoints[this.activeIndex].server;
  }

  /**
   * Returns all configured endpoint URLs in priority order.
   */
  public getAllEndpoints(): string[] {
    return this.endpoints.map((e) => e.url);
  }

  /**
   * Returns current operational status snapshot for all endpoints.
   */
  public getEndpointStatuses(): RpcEndpointStatus[] {
    this.checkCooldowns();
    return this.endpoints.map((e) => ({
      url: e.url,
      isPrimary: e.isPrimary,
      status: e.status,
      consecutiveFailures: e.consecutiveFailures,
      totalRequests: e.totalRequests,
      totalSuccesses: e.totalSuccesses,
      totalFailures: e.totalFailures,
      lastFailureTime: e.lastFailureTime,
      lastSuccessTime: e.lastSuccessTime,
      lastError: e.lastError,
    }));
  }

  /**
   * Check if any unhealthy endpoints have passed their cooldown period and mark them eligible for retry.
   */
  private checkCooldowns(): void {
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (
        ep.status === 'unhealthy' &&
        ep.lastFailureTime !== null &&
        now - ep.lastFailureTime >= this.cooldownMs
      ) {
        ep.status = 'degraded';
        logger.info('Stellar RPC endpoint cooled down, marked degraded for probing', {
          endpoint: sanitizeUrl(ep.url),
          cooldownMs: this.cooldownMs,
          elapsedMs: now - ep.lastFailureTime,
        });
      }
    }
  }

  /**
   * Record a successful request on an endpoint (defaulting to the active endpoint).
   */
  public recordSuccess(targetUrl?: string): void {
    const target = targetUrl
      ? this.endpoints.find((e) => e.url === targetUrl)
      : this.endpoints[this.activeIndex];

    if (!target) return;

    target.totalRequests++;
    target.totalSuccesses++;
    const wasUnhealthyOrDegraded =
      target.status === 'unhealthy' || target.status === 'degraded' || target.consecutiveFailures > 0;

    target.consecutiveFailures = 0;
    target.status = 'healthy';
    target.lastSuccessTime = Date.now();
    target.lastError = null;

    if (wasUnhealthyOrDegraded) {
      logger.info('Stellar RPC endpoint recovered', {
        endpoint: sanitizeUrl(target.url),
        isPrimary: target.isPrimary,
        totalSuccesses: target.totalSuccesses,
      });
    }
  }

  /**
   * Record a failed request on an endpoint and trigger failover if threshold is reached.
   */
  public recordFailure(
    targetUrl: string,
    error: unknown
  ): { switched: boolean; previousUrl?: string; newUrl?: string; reason: string } {
    const targetIndex = this.endpoints.findIndex((e) => e.url === targetUrl);
    const target = targetIndex !== -1 ? this.endpoints[targetIndex] : this.endpoints[this.activeIndex];

    const evaluation = isRpcFailureCondition(error);
    const reason = evaluation.reason;

    target.totalRequests++;
    target.totalFailures++;
    target.consecutiveFailures++;
    target.lastFailureTime = Date.now();
    target.lastError = reason;

    if (target.consecutiveFailures >= this.failureThreshold) {
      target.status = 'unhealthy';
    } else {
      target.status = 'degraded';
    }

    // If active endpoint is now unhealthy (or has failed), evaluate failover
    if (targetIndex === this.activeIndex && target.status === 'unhealthy') {
      const switchResult = this.switchToNextEndpoint(
        `Consecutive failures (${target.consecutiveFailures}) reached threshold (${this.failureThreshold}): ${reason}`
      );
      return {
        switched: true,
        previousUrl: switchResult.previousUrl,
        newUrl: switchResult.newUrl,
        reason,
      };
    }

    return {
      switched: false,
      reason,
    };
  }

  /**
   * Selects the next viable endpoint and switches the active endpoint, logging the transition.
   */
  public switchToNextEndpoint(reason: string): { previousUrl: string; newUrl: string } {
    const previousIndex = this.activeIndex;
    const previousEndpoint = this.endpoints[previousIndex];
    const poolSize = this.endpoints.length;

    if (poolSize <= 1) {
      // Single endpoint configured: cannot switch to another endpoint
      logger.warn('Stellar RPC failover triggered but no fallback endpoints configured', {
        endpoint: sanitizeUrl(previousEndpoint.url),
        reason,
        consecutiveFailures: previousEndpoint.consecutiveFailures,
        failureThreshold: this.failureThreshold,
      });
      return { previousUrl: previousEndpoint.url, newUrl: previousEndpoint.url };
    }

    this.checkCooldowns();

    // Priority 1: Next healthy endpoint in ring order
    let nextIndex = -1;
    for (let i = 1; i < poolSize; i++) {
      const candidateIndex = (previousIndex + i) % poolSize;
      if (this.endpoints[candidateIndex].status === 'healthy') {
        nextIndex = candidateIndex;
        break;
      }
    }

    // Priority 2: Next degraded endpoint (below failure threshold or cooled down)
    if (nextIndex === -1) {
      for (let i = 1; i < poolSize; i++) {
        const candidateIndex = (previousIndex + i) % poolSize;
        if (this.endpoints[candidateIndex].status === 'degraded') {
          nextIndex = candidateIndex;
          break;
        }
      }
    }

    // Priority 3: Cooled down primary endpoint
    if (nextIndex === -1) {
      const primary = this.endpoints[0];
      const now = Date.now();
      if (
        primary.lastFailureTime !== null &&
        now - primary.lastFailureTime >= this.cooldownMs
      ) {
        primary.status = 'degraded';
        nextIndex = 0;
      }
    }

    // Priority 4: Endpoint with the oldest lastFailureTime
    if (nextIndex === -1) {
      let oldestTime = Infinity;
      let oldestIdx = (previousIndex + 1) % poolSize;

      for (let i = 0; i < poolSize; i++) {
        if (i === previousIndex) continue;
        const time = this.endpoints[i].lastFailureTime ?? 0;
        if (time < oldestTime) {
          oldestTime = time;
          oldestIdx = i;
        }
      }
      nextIndex = oldestIdx;
    }

    this.activeIndex = nextIndex;
    const newEndpoint = this.endpoints[nextIndex];

    // Acceptance Criteria: Endpoint switching is logged
    logger.warn('Stellar RPC failover triggered: switching active endpoint', {
      previousEndpoint: sanitizeUrl(previousEndpoint.url),
      newEndpoint: sanitizeUrl(newEndpoint.url),
      reason,
      consecutiveFailures: previousEndpoint.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      activeEndpointIndex: nextIndex,
      totalEndpoints: poolSize,
      availableEndpoints: this.endpoints.map((ep) => ({
        url: sanitizeUrl(ep.url),
        status: ep.status,
        consecutiveFailures: ep.consecutiveFailures,
      })),
    });

    return {
      previousUrl: previousEndpoint.url,
      newUrl: newEndpoint.url,
    };
  }

  /**
   * Executes an asynchronous RPC operation against the active endpoint.
   * If a failure condition occurs, records the failure, executes failover to
   * fallback endpoints, logs the switch, and retries the operation.
   */
  public async executeWithFallback<T>(
    operation: (server: StellarSDK.rpc.Server, endpointUrl: string) => Promise<T>,
    options?: { timeoutMs?: number; operationName?: string }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const operationName = options?.operationName ?? 'StellarRpcOperation';
    const totalAttemptsAllowed = Math.max(1, Math.min(this.maxRetries, this.endpoints.length));

    const errorsCollected: Array<{ endpoint: string; error: string }> = [];

    for (let attempt = 1; attempt <= totalAttemptsAllowed; attempt++) {
      const currentEndpoint = this.endpoints[this.activeIndex];
      const endpointUrl = currentEndpoint.url;
      const server = currentEndpoint.server;

      try {
        const result = await this.withTimeout(
          operation(server, endpointUrl),
          timeoutMs,
          operationName,
          endpointUrl
        );

        this.recordSuccess(endpointUrl);
        return result;
      } catch (err) {
        const evalResult = isRpcFailureCondition(err);

        // If error is NOT an RPC availability failure (e.g. client validation error), rethrow immediately
        if (!evalResult.isFailure) {
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        errorsCollected.push({ endpoint: endpointUrl, error: errMsg });

        // Record failure
        const failResult = this.recordFailure(endpointUrl, err);

        // If we have remaining attempts and fallback endpoints available, switch and retry
        if (attempt < totalAttemptsAllowed && this.endpoints.length > 1) {
          // If recordFailure didn't already switch (because threshold not reached yet),
          // switch immediately for this failed operation retry
          if (!failResult.switched) {
            this.switchToNextEndpoint(
              `Operation "${operationName}" failed on endpoint ${sanitizeUrl(endpointUrl)}: ${evalResult.reason}`
            );
          }
          continue;
        }

        // No more attempts or single endpoint
        break;
      }
    }

    const failureSummary = errorsCollected
      .map((e) => `[${sanitizeUrl(e.endpoint)}]: ${e.error}`)
      .join('; ');

    throw new Error(
      `Stellar RPC operation "${operationName}" failed across ${errorsCollected.length} endpoint(s): ${failureSummary}`
    );
  }

  /**
   * Wraps a promise in a timeout with clean unref.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    operationName: string,
    endpointUrl: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          const timeoutErr = new Error(
            `RPC operation "${operationName}" against ${sanitizeUrl(endpointUrl)} timed out after ${ms}ms`
          );
          timeoutErr.name = 'TimeoutError';
          reject(timeoutErr);
        }, ms);

        if (timer && typeof (timer as any).unref === 'function') {
          (timer as any).unref();
        }
      }),
    ]);
  }

  /**
   * Explicitly sets the active endpoint (useful for tests and manual failover).
   */
  public setActiveEndpoint(url: string): void {
    const index = this.endpoints.findIndex((e) => e.url === url.trim());
    if (index === -1) {
      throw new Error(`Endpoint "${url}" is not configured in this StellarRpcManager`);
    }
    const previous = this.endpoints[this.activeIndex];
    this.activeIndex = index;
    logger.warn('Stellar RPC active endpoint manually switched', {
      previousEndpoint: sanitizeUrl(previous.url),
      newEndpoint: sanitizeUrl(url),
    });
  }

  /**
   * Resets all endpoint metrics and sets active index back to primary.
   */
  public reset(): void {
    for (const ep of this.endpoints) {
      ep.status = 'healthy';
      ep.consecutiveFailures = 0;
      ep.lastError = null;
      ep.lastFailureTime = null;
    }
    this.activeIndex = 0;
  }
}
