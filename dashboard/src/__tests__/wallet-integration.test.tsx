/**
 * End-to-end wallet integration tests across supported wallet providers.
 * Uses the Stellar Wallets Kit mock to simulate Freighter, Albedo, and xBull flows.
 */

import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const WALLET_ID_KEY = 'notify-chain:wallet-id';
const REPORT_PATH = path.join(process.cwd(), 'reports', 'wallet-integration.json');

type KitMock = typeof import('../test/stellarWalletsKitMock');
type WalletService = typeof import('../services/wallet');
type WalletStoreModule = typeof import('../store/walletStore');

const SUPPORTED_WALLETS = [
  { id: 'freighter', label: 'Freighter', address: 'GFREIGHTER1234567890ABCDEFGHIJK' },
  { id: 'albedo', label: 'Albedo', address: 'GALBEDO1234567890ABCDEFGHIJKLM' },
  { id: 'xbull', label: 'xBull', address: 'GXBULL1234567890ABCDEFGHIJKLMNO' },
] as const;

async function load(): Promise<{
  kit: KitMock;
  wallet: WalletService;
  store: WalletStoreModule;
}> {
  jest.resetModules();
  const kit = (await import('@creit.tech/stellar-wallets-kit')) as unknown as KitMock;
  const store = await import('../store/walletStore');
  const wallet = await import('../services/wallet');
  return { kit, wallet, store };
}

function writeReport(results: { wallet: string; passed: boolean }[]) {
  const reportsDir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
        wallets: results,
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('Wallet connection flows', () => {
  it('connects via auth modal and stores the selected wallet address', async () => {
    const { wallet, store, kit } = await load();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };

    await wallet.connectWallet();

    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[0].address);
    expect(localStorage.getItem(WALLET_ID_KEY)).toBe('freighter');
    expect(store.useWalletStore.getState().isConnecting).toBe(false);
    expect(store.useWalletStore.getState().error).toBeNull();
  });

  it('surfaces auth modal failures as recoverable errors', async () => {
    const { wallet, store, kit } = await load();

    kit.__control.authModalImpl = async () => {
      throw new Error('User rejected the connection request');
    };

    await wallet.connectWallet();

    expect(store.useWalletStore.getState().address).toBeNull();
    expect(store.useWalletStore.getState().error).toBe('User rejected the connection request');
    expect(store.useWalletStore.getState().isConnecting).toBe(false);
  });
});

describe('Wallet switching', () => {
  it.each(SUPPORTED_WALLETS)(
    'switches to $label and updates persisted wallet id',
    async ({ id, address }) => {
      const { wallet, store, kit } = await load();

      kit.__control.authModalImpl = async () => {
        kit.__emit('WALLET_SELECTED', { id });
        kit.__emit('STATE_UPDATED', { address });
      };

      await wallet.connectWallet();

      expect(localStorage.getItem(WALLET_ID_KEY)).toBe(id);
      expect(store.useWalletStore.getState().address).toBe(address);
    },
  );

  it('switches wallets without leaving a stale session', async () => {
    const { wallet, store, kit } = await load();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };
    await wallet.connectWallet();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'albedo' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[1].address });
    };
    await wallet.connectWallet();

    expect(localStorage.getItem(WALLET_ID_KEY)).toBe('albedo');
    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[1].address);
  });
});

describe('Notification workflow with wallet connected', () => {
  it('loads events while wallet session is active', async () => {
    const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          {
            eventId: 'evt-wallet-1',
            contractAddress: 'CTEST',
            eventName: 'task_created',
            type: 'contract',
            topic: [],
            value: '',
            ledger: 100,
            receivedAt: Date.parse('2026-06-24T12:00:00Z'),
          },
        ],
      }),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fetchEvents } = await import('../services/eventsApi');
    const { wallet, kit } = await load();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };
    await wallet.connectWallet();

    const events = await fetchEvents('http://localhost:8787/api/events');
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('evt-wallet-1');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/api/events');
  });
});

describe('Wallet integration report', () => {
  it('records pass status for all supported wallet providers', async () => {
    const results: { wallet: string; passed: boolean }[] = [];

    for (const provider of SUPPORTED_WALLETS) {
      localStorage.clear();
      const { wallet, store, kit } = await load();

      kit.__control.authModalImpl = async () => {
        kit.__emit('WALLET_SELECTED', { id: provider.id });
        kit.__emit('STATE_UPDATED', { address: provider.address });
      };

      await wallet.connectWallet();
      const passed =
        store.useWalletStore.getState().address === provider.address &&
        localStorage.getItem(WALLET_ID_KEY) === provider.id;

      results.push({ wallet: provider.id, passed });
    }

    writeReport(results);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(fs.existsSync(REPORT_PATH)).toBe(true);
  });
});

// ─── Regression tests for issue #175 ─────────────────────────────────────────
// Verify that switching wallets updates walletStore address immediately and
// leaves no stale address behind, which is the precondition that
// useWalletAccountSync relies on to trigger a feed refresh.

describe('Notification feed clears on wallet switch (issue #175)', () => {
  it('walletStore address updates immediately when switching to a different wallet', async () => {
    const { wallet, store, kit } = await load();

    // Connect first wallet
    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };
    await wallet.connectWallet();
    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[0].address);

    // Switch to second wallet — address in the store must change synchronously
    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'albedo' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[1].address });
    };
    await wallet.connectWallet();

    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[1].address);
    expect(store.useWalletStore.getState().address).not.toBe(SUPPORTED_WALLETS[0].address);
  });

  it('walletStore address is null after disconnect, clearing any previous account', async () => {
    const { wallet, store, kit } = await load();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };
    await wallet.connectWallet();
    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[0].address);

    kit.__control.disconnectImpl = async () => {
      kit.__emit('DISCONNECT', {});
    };
    await wallet.disconnectWallet();

    expect(store.useWalletStore.getState().address).toBeNull();
    expect(localStorage.getItem('notify-chain:wallet-address')).toBeNull();
  });

  it('no stale address remains in localStorage after switching wallets', async () => {
    const { wallet, store, kit } = await load();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'freighter' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[0].address });
    };
    await wallet.connectWallet();

    kit.__control.authModalImpl = async () => {
      kit.__emit('WALLET_SELECTED', { id: 'xbull' });
      kit.__emit('STATE_UPDATED', { address: SUPPORTED_WALLETS[2].address });
    };
    await wallet.connectWallet();

    // localStorage must reflect the new account only
    expect(localStorage.getItem('notify-chain:wallet-address')).toBe(SUPPORTED_WALLETS[2].address);
    expect(localStorage.getItem('notify-chain:wallet-address')).not.toBe(
      SUPPORTED_WALLETS[0].address,
    );
    expect(store.useWalletStore.getState().address).toBe(SUPPORTED_WALLETS[2].address);
  });

  it('switching wallets across all supported providers leaves only the current address', async () => {
    for (const [index, provider] of SUPPORTED_WALLETS.entries()) {
      const { wallet, store, kit } = await load();

      // First connect one of the other wallets
      const previous = SUPPORTED_WALLETS[(index + 1) % SUPPORTED_WALLETS.length];
      kit.__control.authModalImpl = async () => {
        kit.__emit('WALLET_SELECTED', { id: previous.id });
        kit.__emit('STATE_UPDATED', { address: previous.address });
      };
      await wallet.connectWallet();

      // Now switch to the target provider
      kit.__control.authModalImpl = async () => {
        kit.__emit('WALLET_SELECTED', { id: provider.id });
        kit.__emit('STATE_UPDATED', { address: provider.address });
      };
      await wallet.connectWallet();

      expect(store.useWalletStore.getState().address).toBe(provider.address);
      expect(localStorage.getItem('notify-chain:wallet-address')).toBe(provider.address);
      expect(localStorage.getItem(WALLET_ID_KEY)).toBe(provider.id);

      localStorage.clear();
    }
  });
});
