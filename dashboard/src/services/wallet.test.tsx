import { jest } from '@jest/globals';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

const WALLET_ID_KEY = 'notify-chain:wallet-id';
const WALLET_ADDRESS_KEY = 'notify-chain:wallet-address';

type KitMock = typeof import('../test/stellarWalletsKitMock');
type WalletService = typeof import('./wallet');
type WalletStoreModule = typeof import('../store/walletStore');

/**
 * Reset the module registry and re-import the kit mock, the wallet service and
 * the store as a fresh, isolated graph. The store hydrates its initial address
 * from localStorage at import time, so callers MUST seed localStorage before
 * calling this.
 */
async function load(): Promise<{
  kit: KitMock;
  wallet: WalletService;
  store: WalletStoreModule;
}> {
  jest.resetModules();
  const kit = (await import('@creit.tech/stellar-wallets-kit')) as unknown as KitMock;
  const store = await import('../store/walletStore');
  const wallet = await import('./wallet');
  return { kit, wallet, store };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('restoreWalletSession', () => {
  it('does nothing when no wallet was previously connected', async () => {
    const { wallet, store, kit } = await load();

    await wallet.restoreWalletSession();

    expect(store.useWalletStore.getState().address).toBeNull();
    expect(store.useWalletStore.getState().isReconnecting).toBe(false);
    expect(kit.__control.setWalletCalls).toEqual([]);
  });

  it('restores the address on a successful reconnect', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    const { wallet, store, kit } = await load();

    kit.__control.fetchAddressImpl = async () => {
      kit.__emit('STATE_UPDATED', { address: 'GNEWADDRESS' });
    };

    await wallet.restoreWalletSession();

    expect(kit.__control.setWalletCalls).toEqual(['freighter']);
    expect(store.useWalletStore.getState().address).toBe('GNEWADDRESS');
    expect(localStorage.getItem(WALLET_ADDRESS_KEY)).toBe('GNEWADDRESS');
    expect(store.useWalletStore.getState().isReconnecting).toBe(false);
  });

  // The core bug: a transient refresh failure used to wipe the persisted
  // wallet, so users "lost" their session on reload. It must now survive.
  it('keeps the persisted session when the reconnect fetch fails transiently', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    localStorage.setItem(WALLET_ADDRESS_KEY, 'GPERSISTED');
    const { wallet, store, kit } = await load();

    kit.__control.fetchAddressImpl = async () => {
      throw new Error('RPC timeout');
    };

    await wallet.restoreWalletSession();

    // The saved wallet must survive a transient failure so the user stays
    // connected on the next load instead of losing their session.
    expect(localStorage.getItem(WALLET_ID_KEY)).toBe('freighter');
    expect(localStorage.getItem(WALLET_ADDRESS_KEY)).toBe('GPERSISTED');
    expect(store.useWalletStore.getState().address).toBe('GPERSISTED');
    expect(store.useWalletStore.getState().error).toBe('RPC timeout');
    expect(store.useWalletStore.getState().isReconnecting).toBe(false);
  });

  // React StrictMode double-invokes effects; two concurrent restores must not
  // race each other.
  it('coalesces concurrent restore calls into a single reconnection', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    const { wallet, kit } = await load();

    let resolveFetch: () => void = () => {};
    kit.__control.fetchAddressImpl = () =>
      new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });

    const first = wallet.restoreWalletSession();
    const second = wallet.restoreWalletSession();

    expect(first).toBe(second);

    resolveFetch();
    await Promise.all([first, second]);

    expect(kit.__control.setWalletCalls).toEqual(['freighter']);
  });
});

describe('kit reactive events', () => {
  it('ignores a transient null address while a wallet stays selected', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    localStorage.setItem(WALLET_ADDRESS_KEY, 'GLIVE');
    const { wallet, store, kit } = await load();

    // Registers the kit event handlers via ensureInitialized().
    await wallet.restoreWalletSession();

    kit.__emit('STATE_UPDATED', { address: null });

    expect(store.useWalletStore.getState().address).toBe('GLIVE');
    expect(localStorage.getItem(WALLET_ID_KEY)).toBe('freighter');
  });

  it('clears everything on an explicit disconnect event', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    localStorage.setItem(WALLET_ADDRESS_KEY, 'GLIVE');
    const { wallet, store, kit } = await load();

    await wallet.restoreWalletSession();
    kit.__emit('DISCONNECT', {});

    expect(store.useWalletStore.getState().address).toBeNull();
    expect(localStorage.getItem(WALLET_ID_KEY)).toBeNull();
    expect(localStorage.getItem(WALLET_ADDRESS_KEY)).toBeNull();
  });
});

describe('disconnectWallet', () => {
  it('clears local state even when the kit disconnect call throws', async () => {
    localStorage.setItem(WALLET_ID_KEY, 'freighter');
    localStorage.setItem(WALLET_ADDRESS_KEY, 'GLIVE');
    const { wallet, store, kit } = await load();

    kit.__control.disconnectImpl = async () => {
      throw new Error('module offline');
    };

    await wallet.disconnectWallet();

    expect(store.useWalletStore.getState().address).toBeNull();
    expect(localStorage.getItem(WALLET_ID_KEY)).toBeNull();
    expect(localStorage.getItem(WALLET_ADDRESS_KEY)).toBeNull();
  });
});
