# Synthetic Event Generator

Generate representative Notify-Chain data for local consumer, listener, and integration testing. The generator writes JSON to standard output or to a file you explicitly name. It does not connect to a network, submit transactions, or deliver notifications.

## Requirements

- Node.js 18 or newer
- npm

## Install

From this directory:

```sh
npm ci
```

## Generate records

Print one synthetic blockchain event as a JSON array:

```sh
npm run generate
```

Generate several events and save them locally:

```sh
npm run generate -- --number 10 --output ./events.json
```

Generate notification-input fixtures instead:

```sh
npm run generate -- --type notification --number 4 --output ./notifications.json
```

The `generate:batch` command is an alias for `generate`:

```sh
npm run generate:batch -- --number 100
```

`--number` must be a positive integer. `--type` accepts `blockchain` or `notification`; it defaults to `blockchain`. Without `--output`, JSON is printed to standard output. When `--output` is provided, the generator creates that file and refuses to overwrite an existing file.

## Validate records

Validate either generated record type from a JSON array:

```sh
npm run validate -- --file ./events.json
```

The command exits unsuccessfully for unreadable or malformed JSON, an empty/non-array input, or records that do not match the expected fields and types.

## Output shapes

Blockchain records follow the listener-facing event envelope documented in `listener/src/types/registry-event-input.ts` and `listener/API.md`. Fields include a synthetic ledger-based `eventId`, a Stellar-format fixture contract address, an event name, ledger, contract type, topic strings, base64 event data, transaction-hash fixture, and receive timestamp. Event names and category/priority topic values are drawn from representative contract events.

Notification records are off-chain notification inputs, not Soroban contract events. They include a channel-specific payload for `discord`, `email`, `webhook`, or `sms`, a `.test` recipient URL, a future `executeAt`, retry and priority values, and metadata marked `synthetic: true`.

All values are test fixtures. They are not proof of an actual ledger event, a submitted transaction, a real recipient, or a delivered notification. Do not use them as production data.

## Safety

Generation is local-only; no credentials or environment variables are read, and no notification delivery integration is configured. `--safe` is accepted for clarity, but generation is data-only regardless of that flag. Notification recipient URLs use the reserved `.test` domain.

## Tests and coverage

Run the generator test suite and line/branch/function coverage report:

```sh
npm test
npm run test:coverage
```