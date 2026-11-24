/**
 * Blockchain transaction metadata attached to processed contract events.
 *
 * A processed event always keeps its original, already-decoded payload
 * (`RawEventPayload`) untouched and carries an explicit `TransactionMetadata`
 * object alongside it. Metadata is best-effort: fields that cannot be resolved
 * are recorded as `null`, the overall completeness is captured by
 * `metadataStatus`, and `missingFields`/`reason` explain any gap so downstream
 * consumers never have to guess whether data was omitted or genuinely absent.
 */

/**
 * How complete the transaction metadata is.
 * - `complete`   — every identity/position field is present and no lookup failed.
 * - `partial`    — some fields are present but others could not be resolved.
 * - `unavailable` — no transaction identity could be derived at all.
 */
export type MetadataStatus = 'complete' | 'partial' | 'unavailable';

/** The transaction context offered by a chain/RPC lookup. */
export interface TransactionContext {
  sourceAccount?: string | null;
  operationType?: string | null;
  ledgerSequence?: number | null;
}

export interface TransactionMetadata {
  /** Transaction hash the event belongs to, when available. */
  txHash: string | null;
  /** Ledger sequence the transaction was included in. */
  ledgerSequence: number | null;
  /** Position of the transaction inside its ledger. */
  transactionIndex: number | null;
  /** Position of the operation that emitted the event inside its transaction. */
  operationIndex: number | null;
  /** Operation type (e.g. `invoke_host_function`), when resolvable. */
  operationType: string | null;
  /** Source account that submitted the transaction, when resolvable. */
  sourceAccount: string | null;
  /** Timestamp the ledger closed, as reported by the RPC response. */
  ledgerClosedAt: string | null;
  /** Whether the emitting contract call succeeded, when reported. */
  inSuccessfulContractCall: boolean | null;
  /** Overall completeness of the metadata. */
  metadataStatus: MetadataStatus;
  /** Required fields that could not be resolved (empty when status is `complete`). */
  missingFields: string[];
  /** Human-readable explanation when metadata is not `complete`. */
  reason?: string;
}

/**
 * The decoded event payload exactly as it was ingested, preserved next to the
 * enriched metadata so downstream consumers always retain the original data
 * (the raw payload is never mutated by metadata enrichment).
 */
export interface RawEventPayload {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: string[];
  value: string;
  txHash?: string;
}
