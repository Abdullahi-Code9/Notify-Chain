import logger from '../utils/logger';
import {
  MetadataStatus,
  TransactionContext,
  TransactionMetadata,
} from '../types/transaction-metadata';

/**
 * The subset of an RPC event response this resolver needs. Declared structurally
 * (rather than using the SDK type directly) so callers can pass the real
 * `rpc.Api.EventResponse` without a cast while tests can pass plain objects.
 */
export interface EventResponseLike {
  id?: string;
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  transactionIndex?: number;
  operationIndex?: number;
  inSuccessfulContractCall?: boolean;
  txHash?: string;
}

/**
 * Best-effort source of the extra transaction context that is not carried on
 * the event itself (source account, operation type). Implementations may throw
 * or resolve `null`; the resolver degrades gracefully in both cases.
 */
export interface TransactionMetadataSource {
  fetchTransactionContext(txHash: string): Promise<TransactionContext | null>;
}

export interface TransactionMetadataResolverOptions {
  /** Optional lookup for enrichment fields; omitted means event-only metadata. */
  source?: TransactionMetadataSource;
  /** Upper bound for a single lookup before it is treated as failed. */
  timeoutMs?: number;
}

/** Default lookup timeout; lookups that exceed this are treated as unavailable. */
export const DEFAULT_METADATA_TIMEOUT_MS = 4000;

/** Identity fields; when both are absent the metadata is `unavailable`. */
const IDENTITY_FIELDS = ['txHash', 'ledgerSequence'] as const;

/** Fields that must be present for metadata to be considered `complete`. */
const REQUIRED_FIELDS = ['txHash', 'ledgerSequence', 'transactionIndex', 'operationIndex'] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

interface MetadataFields {
  txHash: string | null;
  ledgerSequence: number | null;
  transactionIndex: number | null;
  operationIndex: number | null;
  operationType: string | null;
  sourceAccount: string | null;
  ledgerClosedAt: string | null;
  inSuccessfulContractCall: boolean | null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function missingOf(fields: MetadataFields): RequiredField[] {
  return REQUIRED_FIELDS.filter((field) => fields[field] === null);
}

function computeStatus(fields: MetadataFields, lookupFailed: boolean): MetadataStatus {
  const hasIdentity = IDENTITY_FIELDS.some((field) => fields[field] !== null);
  if (!hasIdentity) {
    return 'unavailable';
  }
  const requiredPresent = REQUIRED_FIELDS.every((field) => fields[field] !== null);
  return requiredPresent && !lookupFailed ? 'complete' : 'partial';
}

function defaultReason(status: MetadataStatus, missingFields: RequiredField[]): string | undefined {
  if (status === 'complete') {
    return undefined;
  }
  if (status === 'unavailable') {
    return 'No transaction metadata was available on the event';
  }
  return `Transaction metadata is incomplete; unresolved fields: ${missingFields.join(', ')}`;
}

function buildMetadata(
  fields: MetadataFields,
  lookupFailed: boolean,
  reasonOverride?: string,
): TransactionMetadata {
  const metadataStatus = computeStatus(fields, lookupFailed);
  const missingFields = missingOf(fields);
  const reason = reasonOverride ?? defaultReason(metadataStatus, missingFields);
  const metadata: TransactionMetadata = {
    ...fields,
    metadataStatus,
    missingFields,
  };
  if (reason !== undefined) {
    metadata.reason = reason;
  }
  return Object.freeze(metadata);
}

/**
 * Derive transaction metadata purely from the event response. Always succeeds
 * and never throws — absent fields become `null` and the status reflects the gap.
 */
export function deriveTransactionMetadata(
  event: EventResponseLike | null | undefined,
): TransactionMetadata {
  const source = event ?? {};
  return buildMetadata(
    {
      txHash: toNullableString(source.txHash),
      ledgerSequence: toNullableNumber(source.ledger),
      transactionIndex: toNullableNumber(source.transactionIndex),
      operationIndex: toNullableNumber(source.operationIndex),
      operationType: null,
      sourceAccount: null,
      ledgerClosedAt: toNullableString(source.ledgerClosedAt),
      inSuccessfulContractCall: toNullableBoolean(source.inSuccessfulContractCall),
    },
    false,
  );
}

/**
 * Extract the enrichment context from a raw RPC `getTransaction` response.
 * Returns `null` when the response carries none of the fields we track, so the
 * caller can distinguish "no data" from "lookup failed".
 */
export function extractTransactionContext(response: unknown): TransactionContext | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const record = response as Record<string, unknown>;
  const context: TransactionContext = {
    sourceAccount: toNullableString(record.sourceAccount),
    operationType: toNullableString(record.operationType),
    ledgerSequence: toNullableNumber(record.ledger),
  };
  if (
    context.sourceAccount === null &&
    context.operationType === null &&
    context.ledgerSequence === null
  ) {
    return null;
  }
  return context;
}

/**
 * Resolves the transaction metadata for a processed event.
 *
 * The event response is the primary source. When an enrichment {@link
 * TransactionMetadataSource} is configured and the event carries a tx hash, a
 * bounded lookup fills in the source account / operation type. Any failure —
 * thrown error, timeout, or empty response — is logged as a structured warning
 * and downgrades the status to `partial`; the resolver never throws and never
 * causes an otherwise valid event to be dropped.
 */
export class TransactionMetadataResolver {
  private readonly source?: TransactionMetadataSource;
  private readonly timeoutMs: number;

  constructor(options: TransactionMetadataResolverOptions = {}) {
    this.source = options.source;
    const timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive number');
    }
    this.timeoutMs = timeoutMs;
  }

  async resolve(event: EventResponseLike | null | undefined): Promise<TransactionMetadata> {
    const base = deriveTransactionMetadata(event);
    const txHash = base.txHash;

    if (!this.source || !txHash) {
      return base;
    }

    let context: TransactionContext | null;
    try {
      context = await this.withTimeout(
        this.source.fetchTransactionContext(txHash),
        this.timeoutMs,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Transaction metadata lookup failed; continuing with partial metadata', {
        txHash,
        reason,
      });
      return this.rebuildWithFailure(base, `Transaction metadata lookup failed: ${reason}`);
    }

    if (!context) {
      logger.warn('Transaction metadata lookup returned no data; continuing with partial metadata', {
        txHash,
      });
      return this.rebuildWithFailure(base, 'Transaction metadata lookup returned no data');
    }

    return this.mergeContext(base, context);
  }

  private mergeContext(
    base: TransactionMetadata,
    context: TransactionContext,
  ): TransactionMetadata {
    const fields: MetadataFields = {
      txHash: base.txHash,
      ledgerSequence: context.ledgerSequence ?? base.ledgerSequence,
      transactionIndex: base.transactionIndex,
      operationIndex: base.operationIndex,
      operationType: context.operationType ?? base.operationType,
      sourceAccount: context.sourceAccount ?? base.sourceAccount,
      ledgerClosedAt: base.ledgerClosedAt,
      inSuccessfulContractCall: base.inSuccessfulContractCall,
    };
    return buildMetadata(fields, false);
  }

  private rebuildWithFailure(base: TransactionMetadata, reason: string): TransactionMetadata {
    const fields: MetadataFields = {
      txHash: base.txHash,
      ledgerSequence: base.ledgerSequence,
      transactionIndex: base.transactionIndex,
      operationIndex: base.operationIndex,
      operationType: base.operationType,
      sourceAccount: base.sourceAccount,
      ledgerClosedAt: base.ledgerClosedAt,
      inSuccessfulContractCall: base.inSuccessfulContractCall,
    };
    return buildMetadata(fields, true, reason);
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`metadata lookup timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
