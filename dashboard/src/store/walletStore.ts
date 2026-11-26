import { create } from 'zustand';

export interface WalletState {
  address: string | null;
  isConnecting: boolean;
  isReconnecting: boolean;
  error: string | null;
  setAddress: (address: string | null) => void;
  setConnecting: (isConnecting: boolean) => void;
  setReconnecting: (isReconnecting: boolean) => void;
  setError: (error: string | null) => void;
  clearSession: () => void;
}

const WALLET_ID_KEY = 'notify-chain:wallet-id';
const WALLET_ADDRESS_KEY = 'notify-chain:wallet-address';

/**
 * Security guard (#1207): browser web storage is only for non-sensitive UI
 * state. API keys, bearer tokens and secrets must never be persisted where
 * scripts (or a later page load) can read them.
 */
const SENSITIVE_KEY_PATTERN = /(?:token|secret|api[_-]?key|password|credential|auth|nck)/i;

export function isSensitiveStorageKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function readStorage(key: string): string | null {
  if (isSensitiveStorageKey(key)) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (isSensitiveStorageKey(key)) return;
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage may be unavailable (private browsing, etc.) — connection
    // still works for the session, it just won't persist across reloads.
  }
}

export function getPersistedWalletId(): string | null {
  return readStorage(WALLET_ID_KEY);
}

export function setPersistedWalletId(walletId: string | null): void {
  writeStorage(WALLET_ID_KEY, walletId);
}

/**
 * The last resolved address is persisted alongside the wallet id so the UI can
 * render the connected state immediately on reload — and so a transient
 * reconnection failure doesn't drop the user back to "disconnected".
 */
export function getPersistedAddress(): string | null {
  return readStorage(WALLET_ADDRESS_KEY);
}

export function setPersistedAddress(address: string | null): void {
  writeStorage(WALLET_ADDRESS_KEY, address);
}

export const useWalletStore = create<WalletState>((set) => ({
  address: getPersistedAddress(),
  isConnecting: false,
  isReconnecting: false,
  error: null,

  setAddress: (address) => {
    setPersistedAddress(address);
    set({ address, error: null });
  },
  setConnecting: (isConnecting) => set({ isConnecting }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
  setError: (error) => set({ error, isConnecting: false, isReconnecting: false }),

  // Tear down a session completely: in-memory address, persisted address, and
  // any transient flags. Used on an explicit disconnect only.
  clearSession: () => {
    setPersistedAddress(null);
    set({ address: null, error: null, isConnecting: false, isReconnecting: false });
  },
}));
