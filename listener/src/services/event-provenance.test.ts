import { Database } from '../database/database';
import {
  EventProvenanceStore,
  provenanceDiagnostic,
  validateEventProvenance,
} from './event-provenance';

const VALID = {
  network: 'testnet',
  contract: 'CCONTRACT',
  ledger: 42,
  ingestionPath: 'rpc-poll' as const,
};

describe('validateEventProvenance', () => {
  it('accepts the four required fields', () => {
    const result = validateEventProvenance(VALID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(provenanceDiagnostic(result.provenance)).toEqual(VALID);
    expect(Object.keys(provenanceDiagnostic(result.provenance)).sort()).toEqual([
      'contract',
      'ingestionPath',
      'ledger',
      'network',
    ]);
  });

  it('rejects a missing network, contract, ledger, and ingestion path', () => {
    const result = validateEventProvenance({
      network: ' ',
      contract: '',
      ledger: -1,
      ingestionPath: 'websocket',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.field)).toEqual([
      'network',
      'contract',
      'ledger',
      'ingestionPath',
    ]);
  });

  it('rejects a network value that carries a URL or token', () => {
    const secret = 'https://soroban.example/?token=super-secret';
    const result = validateEventProvenance({ ...VALID, network: secret });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe('network');
    expect(JSON.stringify(result.errors)).not.toContain('super-secret');
  });

  it('rejects a fractional ledger', () => {
    const result = validateEventProvenance({ ...VALID, ledger: 1.5 });
    expect(result.ok).toBe(false);
  });
});

describe('EventProvenanceStore', () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    await db.initialize();
  });

  afterAll(async () => {
    await db.close();
  });

  it('persists provenance and reads it back without credential fields', async () => {
    const store = new EventProvenanceStore(db);
    await store.record('event-1', VALID);

    const stored = await store.find('event-1', 'CCONTRACT');
    expect(stored).toEqual(VALID);

    const row = await db.get<{ network: string; contract: string }>(
      'SELECT * FROM event_provenance',
    );
    expect(JSON.stringify(row)).not.toMatch(/token|secret|password|https?:/i);
  });

  it('refuses to store a credential-bearing network', async () => {
    const store = new EventProvenanceStore(db);
    await expect(
      store.record('event-secret', {
        ...VALID,
        network: 'https://user:pass@rpc.example',
      }),
    ).rejects.toThrow(/credential/i);

    expect(await store.find('event-secret', 'CCONTRACT')).toBeNull();
  });
});
