/**
 * Schema definition for NotifyChain config v2.
 * Includes rename and removal mappings relative to v1.
 */

const schema = {
  version: 2,

  required: [
    'STELLAR_RPC_ENDPOINT',
    'STELLAR_NETWORK',
    'STELLAR_NETWORK_PASSPHRASE',
    'CONTRACT_ADDRESSES',
    'LOG_LEVEL',
  ],

  optional: [
    'VITE_EVENTS_API_URL',
    'DISCORD_WEBHOOK_URL',
    'DISCORD_WEBHOOK_CHANNEL_ID',
    'NODE_ENV',
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
    'NOTIFICATION_ENDPOINT',
    'MAX_RETRY_ATTEMPTS',
    'CONTRACT_EVENT_FILTER',
  ],

  /** Map of old v1 key name → new v2 key name. */
  renames: {
    DB_HOST: 'DATABASE_HOST',
    DB_PORT: 'DATABASE_PORT',
    DB_USER: 'DATABASE_USER',
    DB_PASS: 'DATABASE_PASSWORD',
    DB_NAME: 'DATABASE_NAME',
    NOTIFY_ENDPOINT: 'NOTIFICATION_ENDPOINT',
    RETRY_COUNT: 'MAX_RETRY_ATTEMPTS',
    EVENT_FILTER: 'CONTRACT_EVENT_FILTER',
    STELLAR_RPC_URL: 'STELLAR_RPC_ENDPOINT',
    DISCORD_WEBHOOK_ID: 'DISCORD_WEBHOOK_CHANNEL_ID',
  },

  /** Keys that existed in v1 but are no longer valid in v2 — emit a warning. */
  removed: ['VITE_STELLAR_NETWORK'],
};

export default schema;
