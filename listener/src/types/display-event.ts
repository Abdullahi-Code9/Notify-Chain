import { RawEventPayload, TransactionMetadata } from './transaction-metadata';

export interface DisplayEvent {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: string[];
  value: string;
  txHash?: string;
  receivedAt: number;
  /** Blockchain transaction context enriched during ingestion. */
  txMetadata?: TransactionMetadata;
  /** The decoded event payload exactly as ingested, preserved unmodified. */
  rawPayload?: RawEventPayload;
}
