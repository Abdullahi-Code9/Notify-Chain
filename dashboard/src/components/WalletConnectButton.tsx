import { memo } from 'react';
import { useWalletStore } from '../store/walletStore';
import { connectWallet, disconnectWallet } from '../services/wallet';

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export const WalletConnectButton = memo(function WalletConnectButton() {
  const address = useWalletStore((state) => state.address);
  const isConnecting = useWalletStore((state) => state.isConnecting);
  const isReconnecting = useWalletStore((state) => state.isReconnecting);
  const error = useWalletStore((state) => state.error);

  if (!address && isReconnecting) {
    return (
      <div className="wallet-connect">
        <button type="button" className="wallet-connect__button" disabled aria-busy="true">
          Reconnecting…
        </button>
      </div>
    );
  }

  if (address) {
    return (
      <div className="wallet-connect wallet-connect--connected">
        <span className="wallet-connect__info" title={address}>
          <span className="wallet-connect__dot" aria-hidden="true" />
          <span className="wallet-connect__address">{shortenAddress(address)}</span>
        </span>
        <button
          type="button"
          className="wallet-connect__button wallet-connect__button--disconnect"
          onClick={disconnectWallet}
          aria-label="Disconnect wallet"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <button
        type="button"
        className="wallet-connect__button"
        onClick={connectWallet}
        disabled={isConnecting}
        aria-busy={isConnecting}
      >
        {isConnecting ? 'Connecting…' : 'Connect Wallet'}
      </button>
      {error && (
        <p className="wallet-connect__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
