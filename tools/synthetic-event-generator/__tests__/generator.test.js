'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const {
  createProgram,
  generateSyntheticBlockchainEvent,
  generateSyntheticNotificationInput,
  validateEvent,
  validateNotificationInput,
  validateRecord,
} = require('../index');

const CLI_PATH = path.join(__dirname, '..', 'index.js');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-chain-events-'));

after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

function runCli(...args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
}

describe('synthetic blockchain events', () => {
  it('generates listener event records with representative contract categories', () => {
    const expectedEvents = [
      ['autoshare_created', '0', '0'],
      ['contract_paused', '1', '2'],
      ['withdrawal', '2', '2'],
      ['notification_scheduled', '3', '0'],
    ];

    expectedEvents.forEach(([name, category, priority], index) => {
      const event = generateSyntheticBlockchainEvent(index);
      assert.equal(validateEvent(event).length, 0);
      assert.equal(event.eventName, name);
      assert.deepEqual(event.topic.slice(-2), [category, priority]);
      assert.equal(event.topic[0], event.eventName);
    });
  });

  it('uses unique ledger-based IDs and deterministic values', () => {
    const first = generateSyntheticBlockchainEvent(0);
    const second = generateSyntheticBlockchainEvent(1);

    assert.notEqual(first.eventId, second.eventId);
    assert.match(first.eventId, /^\d{16}-1$/);
    assert.equal(first.value, 'AAAAAQ==');
  });

  it('rejects invalid indexes and malformed event fields', () => {
    assert.throws(() => generateSyntheticBlockchainEvent(-1), TypeError);
    assert.throws(() => generateSyntheticBlockchainEvent(1.5), TypeError);
    assert.ok(validateEvent(null).length > 0);
    assert.ok(validateEvent({ ...generateSyntheticBlockchainEvent(0), ledger: 1.5 }).length > 0);
    assert.ok(validateEvent({ ...generateSyntheticBlockchainEvent(0), topic: 'autoshare_created' }).length > 0);
    assert.ok(validateEvent({ ...generateSyntheticBlockchainEvent(0), value: 'not-base64!' }).length > 0);
    assert.deepEqual(validateEvent({ ...generateSyntheticBlockchainEvent(0), eventName: null }), []);
  });
});

describe('synthetic notification inputs', () => {
  it('generates valid inputs for every supported notification type', () => {
    const types = ['discord', 'email', 'webhook', 'sms'];

    types.forEach((type, index) => {
      const input = generateSyntheticNotificationInput(index);
      assert.equal(validateNotificationInput(input).length, 0);
      assert.equal(input.notificationType, type);
      assert.equal(input.metadata.synthetic, true);
      assert.ok(Date.parse(input.executeAt) > Date.now());
      assert.match(input.targetRecipient, /^https:\/\/example\..+\.test\//);
    });
  });

  it('rejects invalid indexes and malformed notification fields', () => {
    assert.throws(() => generateSyntheticNotificationInput(-1), TypeError);
    assert.ok(validateNotificationInput(null).length > 0);
    assert.ok(validateNotificationInput({ ...generateSyntheticNotificationInput(0), priority: 4 }).length > 0);
    assert.ok(validateNotificationInput({ ...generateSyntheticNotificationInput(0), notificationType: 'unknown' }).length > 0);
    assert.ok(validateRecord(generateSyntheticNotificationInput(0)).length === 0);
  });
});

describe('generator CLI', () => {
  it('prints valid JSON for each local-only generation mode', () => {
    for (const type of ['blockchain', 'notification']) {
      const result = runCli('generate', '--number', '3', '--type', type);
      assert.equal(result.status, 0, result.stderr);
      const records = JSON.parse(result.stdout);
      assert.equal(records.length, 3);
      assert.ok(records.every((record) => record.metadata?.synthetic === true || record.type === 'contract'));
    }
  });

  it('writes output only to an explicitly requested file and validates it', () => {
    const outputPath = path.join(temporaryDirectory, 'events.json');
    const generated = runCli('generate', '--number', '2', '--output', outputPath);
    assert.equal(generated.status, 0, generated.stderr);

    const validation = runCli('validate', '--file', outputPath);
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /All 2 events conform/);
    assert.notEqual(runCli('generate', '--number', '1', '--output', outputPath).status, 0);
  });

  it('rejects invalid JSON input, empty arrays, and invalid event records', () => {
    const invalidCases = [
      ['malformed.json', '{'],
      ['empty.json', '[]'],
      ['invalid-event.json', '[{}]'],
    ];

    for (const [name, contents] of invalidCases) {
      const filePath = path.join(temporaryDirectory, name);
      fs.writeFileSync(filePath, contents);
      const result = runCli('validate', '--file', filePath);
      assert.notEqual(result.status, 0);
    }
  });

  it('validates notification fixtures and rejects invalid generation counts', () => {
    const outputPath = path.join(temporaryDirectory, 'notifications.json');
    const generated = runCli('generate', '--number', '4', '--type', 'notification', '--output', outputPath);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(runCli('validate', '--file', outputPath).status, 0);
    assert.notEqual(runCli('generate', '--number', '0').status, 0);
    assert.equal(typeof createProgram(), 'object');
  });
});