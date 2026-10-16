/**
 * Manages the active Soroban RPC endpoint configuration.
 *
 * The selected endpoint is persisted in localStorage so it survives reloads.
 * Falls back to the default SDF testnet endpoint when nothing is persisted.
 */

const STORAGE_KEY = 'notify-chain:active-rpc-url';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org:443';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export function getActiveRpcUrl(): string {
  return readStorage(STORAGE_KEY) ?? DEFAULT_RPC_URL;
}

export function setActiveRpcUrl(url: string): void {
  writeStorage(STORAGE_KEY, url);
}

export function resetActiveRpcUrl(): void {
  writeStorage(STORAGE_KEY, null);
}
