import { getStellarNetworkName } from '../config/stellarNetwork';

const HORIZON_URLS: Record<string, string> = {
  TESTNET: 'https://horizon-testnet.stellar.org',
  PUBLIC: 'https://horizon.stellar.org',
};

export interface TransactionOperation {
  id?: string | number;
  type?: string;
  source_account?: string;
  [key: string]: unknown;
}

export interface TransactionTrace {
  hash: string;
  ledger: number;
  source_account: string;
  created_at: string;
  successful: boolean;
  result_xdr?: string;
  operations: TransactionOperation[];
}

export function getHorizonBaseUrl(network = getStellarNetworkName()): string {
  const url = HORIZON_URLS[network.trim().toUpperCase()];
  if (!url) {
    throw new Error(
      `Unsupported Stellar network "${network}". Set VITE_STELLAR_NETWORK to TESTNET or PUBLIC.`,
    );
  }
  return url;
}

export async function fetchTransactionTrace(hash: string): Promise<TransactionTrace> {
  const normalizedHash = hash.trim();
  if (!/^[\da-f]{64}$/i.test(normalizedHash)) {
    throw new Error('Enter a valid 64-character Stellar transaction hash.');
  }

  const baseUrl = getHorizonBaseUrl();
  const transactionResponse = await fetch(
    `${baseUrl}/transactions/${encodeURIComponent(normalizedHash)}`,
  );
  if (!transactionResponse.ok) {
    if (transactionResponse.status === 404) {
      throw new Error(
        'Transaction not found on the selected network. Check the hash and network setting.',
      );
    }
    throw new Error(`Unable to load transaction (HTTP ${transactionResponse.status}).`);
  }

  const transaction = (await transactionResponse.json()) as Omit<TransactionTrace, 'operations'>;
  if (
    typeof transaction.hash !== 'string' ||
    typeof transaction.ledger !== 'number' ||
    typeof transaction.source_account !== 'string' ||
    typeof transaction.created_at !== 'string' ||
    typeof transaction.successful !== 'boolean'
  ) {
    throw new Error('The selected network returned incomplete transaction details.');
  }

  const operationsResponse = await fetch(
    `${baseUrl}/transactions/${encodeURIComponent(normalizedHash)}/operations?order=asc&limit=200`,
  );
  if (!operationsResponse.ok) {
    throw new Error(`Unable to load transaction operations (HTTP ${operationsResponse.status}).`);
  }

  const operationsPayload = (await operationsResponse.json()) as {
    _embedded?: { records?: TransactionOperation[] };
  };
  const operations = operationsPayload._embedded?.records;
  if (!Array.isArray(operations)) {
    throw new Error('The selected network returned an invalid operations response.');
  }

  return { ...transaction, operations };
}
