# Stellar Network Configuration

NotifyChain supports Stellar Testnet and the public Mainnet. Configure the
dashboard and listener for the same network; their settings are separate.

## Network settings

| Network | Dashboard `VITE_STELLAR_NETWORK` | Listener `STELLAR_NETWORK` | Soroban RPC | Network passphrase |
| --- | --- | --- | --- | --- |
| Testnet | `TESTNET` | `testnet` | `https://soroban-testnet.stellar.org:443` | `Test SDF Network ; September 2015` |
| Mainnet | `PUBLIC` | `public` | `https://soroban-mainnet.stellar.org:443` or your provider's endpoint | `Public Global Stellar Network ; September 2015` |

The passphrase is part of Stellar transaction signing and verification. It
must match the network served by the configured RPC endpoint.

## Testnet configuration

In `dashboard/.env`:

```dotenv
VITE_STELLAR_NETWORK=TESTNET
VITE_EVENTS_API_URL=http://localhost:8787/api/events
```

In `listener/.env`:

```dotenv
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

## Mainnet configuration

In `dashboard/.env`:

```dotenv
VITE_STELLAR_NETWORK=PUBLIC
VITE_EVENTS_API_URL=http://localhost:8787/api/events
```

In `listener/.env`:

```dotenv
STELLAR_NETWORK=public
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

Use an RPC provider appropriate for production traffic. Keep provider
credentials out of `VITE_` variables because Vite embeds them in browser code.

## Dashboard transaction traces

The transaction trace viewer uses Horizon's read-only API for the selected
dashboard network:

- Testnet: `https://horizon-testnet.stellar.org`
- Mainnet: `https://horizon.stellar.org`

This lookup is independent of `STELLAR_RPC_URL`, which configures the listener's
Soroban event polling. The dashboard's `VITE_EVENTS_API_URL` continues to point
to the NotifyChain listener API.

## Troubleshooting

- **Transaction not found:** verify the transaction hash and set
  `VITE_STELLAR_NETWORK` to the network where it was included. Testnet and
  Mainnet have separate ledgers.
- **Network passphrase validation error:** use the exact passphrase shown above
  for `STELLAR_NETWORK`. The listener rejects unknown passphrases.
- **RPC connection or polling errors:** confirm `STELLAR_RPC_URL` is a Soroban
  RPC endpoint, is reachable, and serves the same network as the passphrase.
  A Horizon URL is not a Soroban RPC endpoint.
- **Dashboard still shows the wrong network:** update `VITE_STELLAR_NETWORK`
  in the dashboard environment and restart the Vite server so the new value is
  included in the browser bundle.

See [Listener Configuration](./LISTENER-CONFIGURATION.md) for all listener
environment variables.
