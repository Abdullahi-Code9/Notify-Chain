/**
 * Correlation-ID context propagation (#986)
 *
 * Holds the active request's correlation ID in AsyncLocalStorage so that every
 * log line, error envelope and background job started while serving a request
 * is tagged with the same ID — without threading it through every call site.
 *
 *   runWithCorrelationContext({ correlationId, requestId }, () => handle(req, res));
 *
 *   // anywhere downstream, including after awaits:
 *   getCorrelationId(); // → the request's correlation ID
 *
 * Work that is deferred onto a queue or timer and runs outside the request's
 * async chain should either capture the ID explicitly or wrap its callback
 * with `bindCorrelationContext`.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface CorrelationContext {
  correlationId: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Run `fn` with `context` as the active correlation context. */
export function runWithCorrelationContext<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Run `fn` tagged with `correlationId`, keeping any active requestId. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  const current = storage.getStore();
  return storage.run({ ...current, correlationId }, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Captures the current correlation context and returns a function that
 * restores it when invoked — for callbacks handed to timers, emitters, or job
 * queues that run outside the originating async chain.
 */
export function bindCorrelationContext<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const captured = storage.getStore();
  if (!captured) return fn;
  return (...args: A) => storage.run(captured, () => fn(...args));
}
