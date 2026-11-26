import * as StellarSDK from '@stellar/stellar-sdk';
import { RawEventPayload, TransactionMetadata } from './transaction-metadata';

export interface RegistryEventInput {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  ledger: number;
  type: string;
  topic: StellarSDK.xdr.ScVal[];
  value: StellarSDK.xdr.ScVal;
  txHash?: string;
  /** Optional transaction context resolved before registration. */
  txMetadata?: TransactionMetadata;
  /** Optional raw payload to preserve verbatim on the stored event. */
  rawPayload?: RawEventPayload;
}
