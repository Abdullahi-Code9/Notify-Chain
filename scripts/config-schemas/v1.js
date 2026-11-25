/**
 * Schema definition for NotifyChain config v1.
 * Describes the keys present in the original .env layout.
 */

const schema = {
  version: 1,

  required: [
    'STELLAR_RPC_URL',
    'STELLAR_NETWORK',
    'STELLAR_NETWORK_PASSPHRASE',
    'CONTRACT_ADDRESSES',
    'LOG_LEVEL',
  ],

  optional: [
    // Frontend / dashboard
    'VITE_EVENTS_API_URL',
    'VITE_STELLAR_NETWORK',

    // Discord notifications
    'DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_ID',

    // Runtime
    'NODE_ENV',

    // Legacy DB keys — removed/renamed in v2
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASS',
    'DB_NAME',

    // Other legacy keys — renamed in v2
    'NOTIFY_ENDPOINT',
    'RETRY_COUNT',
    'EVENT_FILTER',
  ],
};

export default schema;
