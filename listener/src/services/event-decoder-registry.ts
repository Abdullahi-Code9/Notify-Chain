/**
 * Event Decoder Registry (Task 3)
 *
 * Replaces scattered `if/else` or `switch` chains for event decoding with a
 * clean, extensible registry pattern.  Decoders are registered independently
 * (plugin style) and unknown event types fall back to a `RawUndecodedEvent`
 * without crashing the ingestion pipeline.
 *
 * Concepts
 * --------
 * - An *EventDecoder<T>* knows how to parse the raw topic/value strings of one
 *   specific event name into a strongly-typed `T`.
 * - `DecodedEvent<T>` is the successful result: source metadata + the typed
 *   payload.
 * - `RawUndecodedEvent` is the fallback result: source identifiers and the
 *   verbatim raw payload are preserved so the event remains inspectable even
 *   when no decoder is registered (Task 2 requirement is satisfied here too).
 * - `EventDecodeResult<T>` is a discriminated union over the two above — the
 *   `kind` field lets callers branch without `instanceof` checks.
 *
 * Usage
 * -----
 * ```ts
 * // Register a decoder (e.g. in bootstrap):
 * getEventDecoderRegistry().register('notification_scheduled', notificationScheduledDecoder);
 *
 * // In the ingestion pipeline:
 * const result = getEventDecoderRegistry().decode(normalizedEvent);
 * if (result.kind === 'decoded') {
 *   // result.payload has the typed fields
 * } else {
 *   // result.rawTopic / result.rawValue preserved
 * }
 * ```
 */

import type { NormalizedEvent } from './event-normalization';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * The input passed to every decoder: the source event name plus the already-
 * formatted topic array and value string (from `normalizeSorobanEvent`).
 */
export interface DecoderInput {
  /** Normalised event name extracted from topic[0]. */
  eventName: string;
  /** Formatted topic strings — `topic[0]` is the event name symbol. */
  topic: string[];
  /** Formatted value string. */
  value: string;
  /** Raw ledger number for ordering context. */
  ledger: number;
  /** Transaction hash, or `null` when unavailable. */
  txHash: string | null;
  /** Payload version tag from the event data, or `null` when absent. */
  payloadVersion: number | null;
}

/**
 * A registered decoder for a single event type `T`.
 *
 * `decode` must not throw — it should return `null` on any parse failure so
 * the registry can fall back to `RawUndecodedEvent` without disrupting the
 * pipeline.
 */
export interface EventDecoder<T> {
  /**
   * Unique name that matches the on-chain Symbol emitted as topic[0]
   * (e.g. `"notification_scheduled"`).
   */
  readonly eventName: string;
  /**
   * Parse the input into a typed payload. Return `null` when the input
   * cannot be fully parsed (the registry treats `null` as a decode failure
   * and falls back to the raw event).
   */
  decode(input: DecoderInput): T | null;
}

/**
 * A successfully decoded event with a typed payload.
 * The `kind` field discriminates this from `RawUndecodedEvent`.
 */
export interface DecodedEvent<T = unknown> {
  kind: 'decoded';
  /** Unique event ID from the RPC response. */
  eventId: string;
  /** Contract address that emitted the event. */
  contractAddress: string;
  /** Decoded event name. */
  eventName: string;
  /** Ledger number. */
  ledger: number;
  /** Transaction hash. */
  txHash: string | null;
  /** The typed, decoder-specific payload. */
  payload: T;
}

/**
 * An event whose raw payload is preserved verbatim because no decoder is
 * registered for its event name, or the registered decoder returned `null`.
 *
 * The API intentionally distinguishes this from `DecodedEvent` so callers can
 * route, log, or forward raw events without losing their source identifiers.
 * (Satisfies the Task 2 inspectability requirement.)
 */
export interface RawUndecodedEvent {
  kind: 'raw';
  /** Unique event ID from the RPC response — always preserved. */
  eventId: string;
  /** Contract address that emitted the event — always preserved. */
  contractAddress: string;
  /**
   * Event name extracted from the first topic Symbol, or `null` when the
   * topic could not be parsed (e.g. completely unknown encoding).
   */
  eventName: string | null;
  /** Ledger number. */
  ledger: number;
  /** Transaction hash. */
  txHash: string | null;
  /** Verbatim topic array as received from the normalization layer. */
  rawTopic: string[];
  /** Verbatim formatted value string. */
  rawValue: string;
  /** Reason the event was not decoded. */
  reason: 'no_decoder' | 'decode_failed';
}

/** Discriminated union returned by `EventDecoderRegistry.decode`. */
export type EventDecodeResult<T = unknown> = DecodedEvent<T> | RawUndecodedEvent;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Central registry that maps event names to their decoders.
 *
 * - Decoders are registered with `register()` — any number may be registered
 *   at any time (plugin / lazy-load friendly).
 * - `decode()` dispatches to the right decoder by `normalizedEvent.eventName`.
 * - Unknown event names (or decoders that return `null`) produce a
 *   `RawUndecodedEvent` so the ingestion pipeline never crashes.
 */
export class EventDecoderRegistry {
  // Use `unknown` internally; the generic flows through at the call site.
  private readonly decoders = new Map<string, EventDecoder<unknown>>();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a decoder. Overwrites any previously registered decoder for the
   * same `eventName`.
   */
  register<T>(decoder: EventDecoder<T>): this {
    const name = decoder.eventName;
    if (!name || typeof name !== 'string') {
      throw new Error('EventDecoderRegistry: decoder.eventName must be a non-empty string');
    }
    if (this.decoders.has(name)) {
      logger.warn('EventDecoderRegistry: overwriting existing decoder', { eventName: name });
    }
    this.decoders.set(name, decoder as EventDecoder<unknown>);
    logger.info('EventDecoderRegistry: decoder registered', { eventName: name });
    return this;
  }

  /**
   * Remove the decoder for `eventName`.
   * Returns `true` if a decoder was found and removed.
   */
  unregister(eventName: string): boolean {
    const removed = this.decoders.delete(eventName);
    if (removed) {
      logger.info('EventDecoderRegistry: decoder removed', { eventName });
    }
    return removed;
  }

  /**
   * Returns `true` when a decoder is registered for `eventName`.
   */
  has(eventName: string): boolean {
    return this.decoders.has(eventName);
  }

  /**
   * List all registered event names.
   */
  listRegistered(): string[] {
    return [...this.decoders.keys()];
  }

  // -------------------------------------------------------------------------
  // Decoding
  // -------------------------------------------------------------------------

  /**
   * Dispatch a normalised event to its registered decoder.
   *
   * - When no decoder exists for `normalizedEvent.eventName`, returns a
   *   `RawUndecodedEvent` with `reason: 'no_decoder'`.
   * - When the decoder returns `null` (parse failure), returns a
   *   `RawUndecodedEvent` with `reason: 'decode_failed'`.
   * - On success, returns a `DecodedEvent<T>` with the typed payload.
   *
   * This method never throws.
   */
  decode<T = unknown>(normalizedEvent: NormalizedEvent): EventDecodeResult<T> {
    const {
      eventId,
      contractAddress,
      eventName,
      ledger,
      txHash,
      topic,
      value,
      payloadVersion,
    } = normalizedEvent;

    const raw: Omit<RawUndecodedEvent, 'reason'> = {
      kind: 'raw',
      eventId,
      contractAddress,
      eventName,
      ledger,
      txHash,
      rawTopic: topic,
      rawValue: value,
    };

    if (!eventName || !this.decoders.has(eventName)) {
      logger.debug('EventDecoderRegistry: no decoder registered for event', {
        eventId,
        contractAddress,
        eventName,
      });
      return { ...raw, reason: 'no_decoder' } as RawUndecodedEvent;
    }

    const decoder = this.decoders.get(eventName)!;
    const input: DecoderInput = {
      eventName,
      topic,
      value,
      ledger,
      txHash,
      payloadVersion,
    };

    try {
      const payload = decoder.decode(input);
      if (payload === null) {
        logger.warn('EventDecoderRegistry: decoder returned null (decode failed)', {
          eventId,
          contractAddress,
          eventName,
        });
        return { ...raw, reason: 'decode_failed' } as RawUndecodedEvent;
      }
      return {
        kind: 'decoded',
        eventId,
        contractAddress,
        eventName,
        ledger,
        txHash,
        payload: payload as T,
      };
    } catch (err) {
      logger.error('EventDecoderRegistry: decoder threw an error, falling back to raw', {
        eventId,
        contractAddress,
        eventName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ...raw, reason: 'decode_failed' } as RawUndecodedEvent;
    }
  }

  /**
   * Remove all registered decoders. Primarily for test teardowns.
   */
  clear(): void {
    this.decoders.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _registry: EventDecoderRegistry | null = null;

/** Returns the module-level singleton decoder registry. */
export function getEventDecoderRegistry(): EventDecoderRegistry {
  if (!_registry) {
    _registry = new EventDecoderRegistry();
  }
  return _registry;
}

/** Replace the singleton. Use in tests or during bootstrap. */
export function setEventDecoderRegistry(registry: EventDecoderRegistry): void {
  _registry = registry;
}

/** Reset the singleton to `null`. Use in test teardowns. */
export function resetEventDecoderRegistry(): void {
  _registry = null;
}
