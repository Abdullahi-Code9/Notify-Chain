/**
 * Predefined Soroban RPC endpoints for benchmarking.
 *
 * Users can also add custom private endpoints at runtime via the benchmark UI.
 */

export interface RpcEndpoint {
  id: string;
  url: string;
  label: string;
  network: 'testnet' | 'mainnet' | 'custom';
}

export const DEFAULT_RPC_ENDPOINTS: RpcEndpoint[] = [
  {
    id: 'sdf-testnet',
    url: 'https://soroban-testnet.stellar.org:443',
    label: 'SDF Testnet',
    network: 'testnet',
  },
  {
    id: 'stellar-public-testnet',
    url: 'https://rpc-stellar-testnet.ankr.com',
    label: 'Ankr Testnet',
    network: 'testnet',
  },
  {
    id: 'soroban-testnet-fast',
    url: 'https://soroban-testnet早い.stellar.org:443',
    label: 'SDF Testnet (Fast)',
    network: 'testnet',
  },
  {
    id: 'custom-private',
    url: 'http://localhost:8000',
    label: 'Local Node',
    network: 'custom',
  },
];

export const RPC_TIMEOUT_MS = 10_000;
