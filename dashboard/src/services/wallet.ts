import { StellarWalletsKit, Networks, KitEventType } from '@creit.tech/stellar-wallets-kit';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { ModuleType } from '@creit.tech/stellar-wallets-kit';
import { useWalletStore, getPersistedWalletId, setPersistedWalletId } from '../store/walletStore';
import { getStellarNetworkName } from '../config/stellarNetwork';

const NETWORK = getStellarNetworkName() === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;

let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  StellarWalletsKit.init({
    modules: defaultModules({
      filterBy: (module) =>
        module.moduleType !== ModuleType.HW_WALLET &&
        module.moduleType !== ModuleType.BRIDGE_WALLET,
    }),
    network: NETWORK,
    selectedWalletId: getPersistedWalletId() ?? undefined,
  });

  // The kit's own reactive state — fires immediately with current state on
  // subscribe, then again on every change.
  StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
    const nextAddress = event.payload.address ?? null;

    // Mid-reconnection the kit can emit transient state updates that carry no
    // address (e.g. while it re-derives the account). Honouring those would
    // flip the UI back to "disconnected" and wipe the session even though a
    // wallet is still selected. Only the dedicated DISCONNECT event below is
    // allowed to tear a live session down.
    if (!nextAddress && getPersistedWalletId()) {
      return;
    }

    useWalletStore.getState().setAddress(nextAddress);
  });

  StellarWalletsKit.on(KitEventType.WALLET_SELECTED, (event) => {
    setPersistedWalletId(event.payload.id ?? null);
  });

  StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
    setPersistedWalletId(null);
    useWalletStore.getState().clearSession();
  });
}

/**
 * Opens the built-in wallet selection modal and connects to whichever
 * wallet the user picks. The kit's STATE_UPDATED event (subscribed in
 * ensureInitialized) updates the store once connected.
 */
export async function connectWallet(): Promise<void> {
  ensureInitialized();
  const store = useWalletStore.getState();
  store.setError(null);
  store.setConnecting(true);

  try {
    await StellarWalletsKit.authModal();
    store.setConnecting(false);
  } catch (err) {
    store.setError(describeError(err));
  }
}

/**
 * Disconnects the current wallet and clears persisted selection.
 */
export async function disconnectWallet(): Promise<void> {
  ensureInitialized();
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    // A failed module-level disconnect shouldn't surface as an error or leave
    // the UI stuck — we clear local state below regardless.
  } finally {
    // A disconnect is an explicit, intentional teardown — clear local state
    // whether or not the module's own call succeeded.
    setPersistedWalletId(null);
    useWalletStore.getState().clearSession();
  }
}

let restoreInFlight: Promise<void> | null = null;

/**
 * Call once on app load. If a wallet was connected in a previous session,
 * re-selects it and refreshes the address.
 *
 * The persisted session is treated as the source of truth: a failed refresh
 * (RPC blip, wallet extension still loading, account locked) is reported as a
 * recoverable error but does NOT erase the saved wallet — the optimistically
 * restored address keeps the user "connected" and a later retry can reconcile.
 * Only an explicit disconnect clears persistence.
 *
 * Safe to call multiple times: concurrent calls share a single in-flight
 * promise, so React StrictMode's double-invoked effects can't race each other
 * into clearing a just-restored session.
 */
export function restoreWalletSession(): Promise<void> {
  ensureInitialized();

  if (restoreInFlight) return restoreInFlight;

  const walletId = getPersistedWalletId();
  if (!walletId) return Promise.resolve();

  const store = useWalletStore.getState();
  store.setReconnecting(true);

  restoreInFlight = (async () => {
    try {
      StellarWalletsKit.setWallet(walletId);
      await StellarWalletsKit.fetchAddress();
    } catch (err) {
      store.setError(describeError(err));
    } finally {
      store.setReconnecting(false);
      restoreInFlight = null;
    }
  })();

  return restoreInFlight;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Could not connect to the wallet. Please try again.';
}
