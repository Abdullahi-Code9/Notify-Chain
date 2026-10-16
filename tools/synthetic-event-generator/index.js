#!/usr/bin/env node
'use strict';

/**
 * Synthetic Event Generator for Notify-Chain local development
 *
 * Generates valid synthetic events that conform to the project's event schema,
 * enabling developers to test off-chain consumers, dashboard components, and
 * integration scenarios without sending real notifications or requiring
 * production credentials.
 */

const { Command } = require('commander');
const fs = require('fs');

const CONTRACT_ADDRESS = 'GDKZXR2MHKPZAJQXOYHKWJNRPEZKMGKGLLXGFMRQVEFWLXOHZN7XQPLA';
const EVENT_FIXTURES = [
  {
    name: 'autoshare_created',
    topics: ['GBVZR3XKFV6KCXOQQKTQJVQPXJRP3KZMZBXHTF4XLVKXMFKZPZXDTUA', '0', '0'],
  },
  {
    name: 'contract_paused',
    topics: [CONTRACT_ADDRESS, '1', '2'],
  },
  {
    name: 'withdrawal',
    topics: [
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      CONTRACT_ADDRESS,
      '2',
      '2',
    ],
  },
  {
    name: 'notification_scheduled',
    topics: ['GBVZR3XKFV6KCXOQQKTQJVQPXJRP3KZMZBXHTF4XLVKXMFKZPZXDTUA', '3', '0'],
  },
];

const NOTIFICATION_TYPES = ['discord', 'email', 'webhook', 'sms'];
const SYNTHETIC_EVENT_VALUE = 'AAAAAQ==';
const BASE_LEDGER = 12345;
const BASE_RECEIVED_AT = 1718640000000;

function generateSyntheticBlockchainEvent(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError('Event index must be a non-negative integer');
  }

  const fixture = EVENT_FIXTURES[index % EVENT_FIXTURES.length];
  const ledger = BASE_LEDGER + index;

  return {
    eventId: `${String(ledger).padStart(16, '0')}-1`,
    contractAddress: CONTRACT_ADDRESS,
    eventName: fixture.name,
    ledger,
    type: 'contract',
    topic: [fixture.name, ...fixture.topics],
    value: SYNTHETIC_EVENT_VALUE,
    txHash: index.toString(16).padStart(64, '0'),
    receivedAt: BASE_RECEIVED_AT + index * 1000,
  };
}

function generateSyntheticNotificationInput(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError('Notification index must be a non-negative integer');
  }

  const type = NOTIFICATION_TYPES[index % NOTIFICATION_TYPES.length];
  const prefix = type[0].toUpperCase() + type.slice(1);
  const payloads = {
    discord: { content: `Synthetic ${prefix} notification`, embeds: [{ title: `Synthetic ${prefix} Event`, description: 'Test', color: 5814783 }] },
    email: { subject: `Synthetic ${prefix} Notification`, body: 'Test body', html: '<p>Test</p>' },
    webhook: { event: `synthetic.${type}`, taskId: String(index), reward: String(index % 100), currency: 'XLM' },
    sms: { message: `NotifyChain: Synthetic ${prefix} event` },
  };

  return {
    payload: payloads[type],
    notificationType: type,
    targetRecipient: `https://example.${type}.test/${index}`,
    executeAt: new Date(Date.now() + 86400000 + index * 1000).toISOString(),
    maxRetries: 3,
    priority: index % 4,
    eventId: `synthetic-notification-${index}`,
    contractAddress: CONTRACT_ADDRESS,
    metadata: { synthetic: true, generator: 'synthetic-event-generator', index },
  };
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return ['event must be an object'];
  }

  const errors = [];
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) errors.push('eventId must be a non-empty string');
  if (typeof event.contractAddress !== 'string' || !/^G[A-Z2-7]{55}$/.test(event.contractAddress)) errors.push('contractAddress must be a Stellar account address');
  if (event.eventName !== null && typeof event.eventName !== 'string') errors.push('eventName must be a string or null');
  if (!Number.isInteger(event.ledger) || event.ledger < 0) errors.push('ledger must be a non-negative integer');
  if (event.type !== 'contract') errors.push('type must be contract');
  if (!Array.isArray(event.topic) || event.topic.length === 0 || event.topic.some((topic) => typeof topic !== 'string')) errors.push('topic must be a non-empty array of strings');
  if (typeof event.value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.value)) errors.push('value must be a base64 string');
  if (event.txHash !== undefined && typeof event.txHash !== 'string') errors.push('txHash must be a string when provided');
  if (!Number.isInteger(event.receivedAt) || event.receivedAt < 0) errors.push('receivedAt must be a non-negative integer');
  return errors;
}

function validateNotificationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['notification input must be an object'];
  }

  const errors = [];
  if (typeof input.eventId !== 'string' || input.eventId.length === 0) errors.push('eventId must be a non-empty string');
  if (typeof input.contractAddress !== 'string' || !/^G[A-Z2-7]{55}$/.test(input.contractAddress)) errors.push('contractAddress must be a Stellar account address');
  if (!NOTIFICATION_TYPES.includes(input.notificationType)) errors.push('notificationType is unsupported');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) errors.push('payload must be an object');
  if (typeof input.targetRecipient !== 'string' || input.targetRecipient.length === 0) errors.push('targetRecipient must be a non-empty string');
  if (typeof input.executeAt !== 'string' || Number.isNaN(Date.parse(input.executeAt))) errors.push('executeAt must be a valid date string');
  if (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0) errors.push('maxRetries must be a non-negative integer');
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 3) errors.push('priority must be an integer from 0 to 3');
  if (!input.metadata || input.metadata.synthetic !== true) errors.push('metadata must identify this as synthetic data');
  return errors;
}

function validateRecord(record) {
  return record && typeof record === 'object' && Object.hasOwn(record, 'notificationType')
    ? validateNotificationInput(record)
    : validateEvent(record);
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('must be a positive integer');
  }
  return parsed;
}

function createProgram() {
  const program = new Command();
  program.name('synthetic-event-generator').description('Generate local-only synthetic Notify-Chain events').version('1.0.0');

  const addGenerateCommand = (name) => {
    program
      .command(name)
      .description('Generate synthetic events for local development')
      .option('-n, --number <count>', 'Number of records to generate', parsePositiveInteger, 1)
      .option('-t, --type <type>', 'Record type: blockchain or notification', 'blockchain')
      .option('-o, --output <file>', 'Write a JSON array to this local file')
      .option('--safe', 'Generate data only; never deliver notifications')
      .action((options) => {
        if (!['blockchain', 'notification'].includes(options.type)) {
          throw new Error(`Unknown type: ${options.type}. Use blockchain or notification.`);
        }

        const generate = options.type === 'blockchain'
          ? generateSyntheticBlockchainEvent
          : generateSyntheticNotificationInput;
        const records = Array.from({ length: options.number }, (_, index) => generate(index));
        const output = `${JSON.stringify(records, null, 2)}\n`;

        if (options.output) {
          fs.writeFileSync(options.output, output, { encoding: 'utf8', flag: 'wx' });
          console.log(`Wrote ${records.length} synthetic ${options.type} record(s) to ${options.output}`);
          return;
        }

        process.stdout.write(output);
      });
  };

  addGenerateCommand('generate');
  addGenerateCommand('generate:batch');

  program
    .command('validate')
    .description('Validate a JSON array of synthetic events')
    .requiredOption('-f, --file <path>', 'Path to the JSON file to validate')
    .action((options) => {
      let events;
      try {
        events = JSON.parse(fs.readFileSync(options.file, 'utf8'));
      } catch (error) {
        throw new Error(`Could not read valid JSON from ${options.file}: ${error.message}`);
      }

      if (!Array.isArray(events) || events.length === 0) {
        throw new Error('Input must be a non-empty JSON array');
      }

      const failures = events.flatMap((event, index) =>
        validateRecord(event).map((reason) => `Event ${index}: ${reason}`),
      );
      if (failures.length > 0) {
        failures.slice(0, 10).forEach((failure) => console.error(failure));
        throw new Error(`${failures.length} schema error(s) found in ${events.length} event(s)`);
      }

      console.log(`All ${events.length} events conform to the listener event schema.`);
    });

  return program;
}

if (require.main === module) {
  createProgram().parse(process.argv);
}

module.exports = {
  generateSyntheticBlockchainEvent,
  generateSyntheticNotificationInput,
  validateEvent,
  validateNotificationInput,
  validateRecord,
  createProgram,
};