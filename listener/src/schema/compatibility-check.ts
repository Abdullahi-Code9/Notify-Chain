/**
 * Checks that contract event changes remain compatible with the off-chain
 * consumer schema.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface EventFieldSchema {
  name: string;
  type: string;
}

export interface ContractEventSchema {
  name: string;
  topics: EventFieldSchema[];
  dataFields: EventFieldSchema[];
}

export interface OffConsumerEventSchema {
  eventName: string;
  expectedTopics: EventFieldSchema[];
  expectedFields: EventFieldSchema[];
}

export interface OffConsumerSchema {
  events: OffConsumerEventSchema[];
}

export interface CompatibilityResult {
  compatible: boolean;
  breakingChanges: string[];
  safeAdditions: string[];
}

export function extractContractEvents(eventsFilePath: string): Map<string, ContractEventSchema> {
  const source = fs.readFileSync(eventsFilePath, 'utf8');
  const eventRegex = /#\[contractevent[^\]]*\][\s\S]*?\bpub struct (\w+)\s*\{([\s\S]*?)^\}/gm;
  const events = new Map<string, ContractEventSchema>();
  let match: RegExpExecArray | null;

  while ((match = eventRegex.exec(source)) !== null) {
    const [, eventName, fieldsSection] = match;
    const topics: EventFieldSchema[] = [];
    const dataFields: EventFieldSchema[] = [];
    let nextFieldIsTopic = false;

    for (const line of fieldsSection.split(/\r?\n/)) {
      const fieldLine = line.trim();
      if (fieldLine === '#[topic]') {
        nextFieldIsTopic = true;
        continue;
      }

      const fieldMatch = fieldLine.match(/^pub\s+(\w+)\s*:\s*(.+)$/);
      if (!fieldMatch) continue;
      const field = {
        name: fieldMatch[1],
        type: fieldMatch[2].replace(/,\s*$/, '').trim(),
      };
      (nextFieldIsTopic ? topics : dataFields).push(field);
      nextFieldIsTopic = false;
    }

    if (events.has(eventName)) throw new Error(`Duplicate contract event '${eventName}'`);
    events.set(eventName, { name: eventName, topics, dataFields });
  }

  return events;
}

function isEventFieldSchema(value: unknown): value is EventFieldSchema {
  if (typeof value !== 'object' || value === null) return false;
  const field = value as EventFieldSchema;
  return typeof field.name === 'string' && !!field.name.trim() &&
    typeof field.type === 'string' && !!field.type.trim();
}

function isConsumerEventSchema(value: unknown): value is OffConsumerEventSchema {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as OffConsumerEventSchema;
  return typeof event.eventName === 'string' && !!event.eventName.trim() &&
    Array.isArray(event.expectedTopics) && event.expectedTopics.every(isEventFieldSchema) &&
    Array.isArray(event.expectedFields) && event.expectedFields.every(isEventFieldSchema);
}

export function loadConsumerSchema(schemaFilePath: string): OffConsumerSchema {
  const parsed: unknown = JSON.parse(fs.readFileSync(schemaFilePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as OffConsumerSchema).events)) {
    throw new Error('Consumer schema must be a JSON object with an events array');
  }

  const events = (parsed as OffConsumerSchema).events;
  if (events.length === 0 || !events.every(isConsumerEventSchema)) {
    throw new Error('Consumer schema must contain valid event names, topics, and data fields');
  }
  const eventNames = events.map((event) => event.eventName);
  if (new Set(eventNames).size !== eventNames.length) {
    throw new Error('Consumer schema contains duplicate event names');
  }
  return { events };
}

function compareFields(
  contractEvent: ContractEventSchema,
  actualFields: EventFieldSchema[],
  expectedFields: EventFieldSchema[],
  fieldKind: string
): { compatible: boolean; breakingChanges: string[]; safeAdditions: string[] } {
  const breakingChanges: string[] = [];
  const safeAdditions: string[] = [];

  expectedFields.forEach((expectedField, index) => {
    const actualField = actualFields[index];
    if (!actualField) {
      breakingChanges.push(
        `Breaking: Contract event '${contractEvent.name}' is missing expected ${fieldKind} '${expectedField.name}'`
      );
    } else if (actualField.name !== expectedField.name) {
      breakingChanges.push(
        `Breaking: Expected ${fieldKind} '${expectedField.name}' at position ${index} in '${contractEvent.name}', found '${actualField.name}'`
      );
    } else if (actualField.type.replace(/\s+/g, '') !== expectedField.type.replace(/\s+/g, '')) {
      breakingChanges.push(
        `Breaking: ${fieldKind} '${expectedField.name}' in '${contractEvent.name}' changed type from '${expectedField.type}' to '${actualField.type}'`
      );
    }
  });

  if (breakingChanges.length === 0) {
    safeAdditions.push(
      ...actualFields.slice(expectedFields.length).map(
        (field) => `Safe addition: Trailing ${fieldKind} '${field.name}' added to '${contractEvent.name}'`
      )
    );
  }
  return { compatible: breakingChanges.length === 0, breakingChanges, safeAdditions };
}

export function checkEventCompatibility(
  contractEvent: ContractEventSchema,
  consumerEvent: OffConsumerEventSchema
): CompatibilityResult {
  const topics = compareFields(
    contractEvent,
    contractEvent.topics,
    consumerEvent.expectedTopics,
    'topic'
  );
  const fields = compareFields(
    contractEvent,
    contractEvent.dataFields,
    consumerEvent.expectedFields,
    'data field'
  );
  return {
    compatible: topics.compatible && fields.compatible,
    breakingChanges: [...topics.breakingChanges, ...fields.breakingChanges],
    safeAdditions: [...topics.safeAdditions, ...fields.safeAdditions],
  };
}

export function checkSchemaCompatibility(
  contractEvents: Map<string, ContractEventSchema>,
  consumerSchema: OffConsumerSchema
): CompatibilityResult {
  const breakingChanges: string[] = [];
  const safeAdditions: string[] = [];
  const consumerNames = new Set(consumerSchema.events.map((event) => event.eventName));

  if (consumerSchema.events.length === 0) {
    breakingChanges.push('Consumer event schema is empty or malformed');
  }

  // Check 4: Topic structure changes
  // Topics are appended as trailing topics - existing consumers ignore them
  // Breaking change only if the core topic (event name) changes position
  if (consumer.expectedTopics && contractEvent.topics.length < consumer.expectedTopics.length) {
    const missingTopics = consumer.expectedTopics.filter(
      (t) => !contractEvent.topics.includes(t)
    );
    if (missingTopics.length > 0) {
  for (const consumerEvent of consumerSchema.events) {
    const contractEvent = contractEvents.get(consumerEvent.eventName);
    if (!contractEvent) {
      breakingChanges.push(
        `Breaking: Consumer expects event '${consumerEvent.eventName}', but it is missing from the contract schema`
      );
      continue;
    }
    const result = checkEventCompatibility(contractEvent, consumerEvent);
    breakingChanges.push(...result.breakingChanges);
    safeAdditions.push(...result.safeAdditions);
  }

  // Check 5: New data fields are safe (backward compatible)
  // Any new data fields in the contract that weren't expected by the consumer
  // are simply ignored - this is the Soroban trailing-topic pattern
  const newDataFields = contractEvent.dataFields.filter(
    (f) => !consumer.expectedFields.includes(f.name)
  );
  safeAdditions.push(
    ...newDataFields.map(
      (f) => `Safe addition: New data field '${f.name}' in '${contractEvent.name}' (ignored by existing consumers)`
    )
  );

  // Determine compatibility
  const compatible = breakingChanges.length === 0;
  for (const eventName of contractEvents.keys()) {
    if (!consumerNames.has(eventName)) {
      safeAdditions.push(`Safe addition: New event '${eventName}' is ignored by existing consumers`);
    }
  }

  return { compatible: breakingChanges.length === 0, breakingChanges, safeAdditions };
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Option ${option} requires a value`);
  return value;
}

export function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run check:event-schema -- [--contract path] [--consumer path] [--format table|json|summary]');
    return;
  }

  try {
    const contractPath = path.resolve(
      process.cwd(),
      optionValue(args, '--contract') ??
        path.resolve(__dirname, '../../../contract/contracts/hello-world/src/base/events.rs')
    );
    const consumerPath = path.resolve(
      process.cwd(),
      optionValue(args, '--consumer') ?? path.resolve(__dirname, 'consumer-event-schema.json')
    );
    const format = optionValue(args, '--format') ?? 'table';
    if (!['table', 'json', 'summary'].includes(format)) {
      throw new Error(`Unsupported output format '${format}'`);
    }

    const result = checkSchemaCompatibility(
      extractContractEvents(contractPath),
      loadConsumerSchema(consumerPath)
    );
    const report = format === 'json'
      ? JSON.stringify(result, null, 2)
      : [
          `Event Schema Compatibility Check: ${result.compatible ? 'PASS' : 'FAIL'}`,
          ...(format === 'table' ? result.breakingChanges.map((change) => `! ${change}`) : []),
          ...(format === 'table' ? result.safeAdditions.map((addition) => `+ ${addition}`) : []),
          `Breaking changes: ${result.breakingChanges.length}`,
        ].join('\n');
    const outputPath = optionValue(args, '--output');
    if (outputPath) {
      fs.writeFileSync(path.resolve(process.cwd(), outputPath), `${report}\n`);
    } else {
      console.log(report);
    }
    process.exitCode = result.compatible ? 0 : 1;
  } catch (error) {
    console.error('Error running compatibility check:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
