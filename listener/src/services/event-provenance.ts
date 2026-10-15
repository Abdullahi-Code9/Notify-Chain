/**
 * Provenance for a normalized event (issue #949): which network, contract,
 * ledger, and ingestion path produced it.
 *
 * The recorded fields are names and identifiers only. RPC URLs, tokens, and
 * other credentials are rejected before anything is stored or logged.
 */

import { Database } from '../database/database';
import { sanitizeCredentials } from '../utils/credential-sanitizer';

export const INGESTION_PATHS = ['rpc-poll', 'backfill', 'replay'] as const;

export type IngestionPath = (typeof INGESTION_PATHS)[number];

export interface EventProvenance {
  network: string;
  contract: string;
  ledger: number;
  ingestionPath: IngestionPath;
}

export interface ProvenanceFieldError {
  field: keyof EventProvenance;
  detail: string;
}

export type ProvenanceValidation =
  | { ok: true; provenance: EventProvenance }
  | { ok: false; errors: ProvenanceFieldError[] };

const CREDENTIAL_PATTERN = /:\/\/|@|api[_-]?key|secret|token|password|bearer\s|webhook/i;

function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERN.test(value) || sanitizeCredentials(value) !== value;
}

/**
 * Validate the four required provenance fields.
 * A passing result is safe to persist and to print as a diagnostic.
 */
export function validateEventProvenance(input: {
  network: unknown;
  contract: unknown;
  ledger: unknown;
  ingestionPath: unknown;
}): ProvenanceValidation {
  const errors: ProvenanceFieldError[] = [];

  if (typeof input.network !== 'string' || input.network.trim() === '') {
    errors.push({ field: 'network', detail: 'Network name is required' });
  } else if (looksLikeCredential(input.network)) {
    errors.push({ field: 'network', detail: 'Network must be a name, not a URL or credential' });
  }

  if (typeof input.contract !== 'string' || input.contract.trim() === '') {
    errors.push({ field: 'contract', detail: 'Contract address is required' });
  } else if (looksLikeCredential(input.contract)) {
    errors.push({ field: 'contract', detail: 'Contract address must not contain credentials' });
  }

  if (typeof input.ledger !== 'number' || !Number.isInteger(input.ledger) || input.ledger < 0) {
    errors.push({ field: 'ledger', detail: 'Ledger must be a non-negative integer' });
  }

  if (
    typeof input.ingestionPath !== 'string' ||
    !INGESTION_PATHS.includes(input.ingestionPath as IngestionPath)
  ) {
    errors.push({
      field: 'ingestionPath',
      detail: `Ingestion path must be one of ${INGESTION_PATHS.join(', ')}`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    provenance: {
      network: (input.network as string).trim(),
      contract: (input.contract as string).trim(),
      ledger: input.ledger as number,
      ingestionPath: input.ingestionPath as IngestionPath,
    },
  };
}

/** Diagnostic view. Only the four provenance fields are returned. */
export function provenanceDiagnostic(provenance: EventProvenance): EventProvenance {
  return {
    network: provenance.network,
    contract: provenance.contract,
    ledger: provenance.ledger,
    ingestionPath: provenance.ingestionPath,
  };
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS event_provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    network TEXT NOT NULL,
    contract TEXT NOT NULL,
    ledger INTEGER NOT NULL CHECK (ledger >= 0),
    ingestion_path TEXT NOT NULL CHECK (ingestion_path IN ('rpc-poll', 'backfill', 'replay')),
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, contract)
  )
`;

export class EventProvenanceStore {
  constructor(private readonly db: Database) {}

  async record(eventId: string, provenance: EventProvenance): Promise<void> {
    if (!eventId || eventId.trim() === '') {
      throw new Error('Event id is required to record provenance');
    }

    const validated = validateEventProvenance(provenance);
    if (!validated.ok) {
      throw new Error(validated.errors.map((error) => error.detail).join('; '));
    }

    await this.db.run(CREATE_TABLE);
    await this.db.run(
      `
      INSERT INTO event_provenance (event_id, network, contract, ledger, ingestion_path)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id, contract) DO UPDATE SET
        network = excluded.network,
        ledger = excluded.ledger,
        ingestion_path = excluded.ingestion_path,
        recorded_at = CURRENT_TIMESTAMP
      `,
      [
        eventId.trim(),
        validated.provenance.network,
        validated.provenance.contract,
        validated.provenance.ledger,
        validated.provenance.ingestionPath,
      ],
    );
  }

  async find(eventId: string, contract: string): Promise<EventProvenance | null> {
    await this.db.run(CREATE_TABLE);
    const row = await this.db.get<{
      network: string;
      contract: string;
      ledger: number;
      ingestion_path: IngestionPath;
    }>(
      `
      SELECT network, contract, ledger, ingestion_path
      FROM event_provenance
      WHERE event_id = ? AND contract = ?
      `,
      [eventId, contract],
    );

    if (!row) return null;
    return provenanceDiagnostic({
      network: row.network,
      contract: row.contract,
      ledger: row.ledger,
      ingestionPath: row.ingestion_path,
    });
  }
}
