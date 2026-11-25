/**
 * Contract Version Registry (Task 1)
 *
 * Associates supported event schemas with specific contract versions so that
 * maintainers can detect incompatible event changes at startup or during CI.
 *
 * Concepts
 * --------
 * - A *contract version* is the integer value returned by the on-chain
 *   `version()` entry point (currently `1`).
 * - A *schema snapshot* is the set of event definitions that the off-chain
 *   consumer expects for that contract version. It re-uses the existing
 *   `OffConsumerEventSchema` shape from `compatibility-check.ts`.
 * - A *version diagnostic* is a structured object describing the result of a
 *   compatibility check: either `compatible`, `unsupported` (the contract
 *   version has no snapshot registered), or `incompatible` (a registered
 *   snapshot was found but field-level mismatches exist).
 *
 * Usage
 * -----
 * ```ts
 * const registry = new ContractVersionRegistry();
 * registry.register(1, snapshot_v1);
 *
 * const result = registry.resolveSchema(1);
 * // → { status: 'found', snapshot: snapshot_v1 }
 *
 * const diag = registry.diagnose(contractEvents, 1);
 * // → { status: 'compatible', contractVersion: 1, breakingChanges: [], ... }
 * ```
 */

import type { ContractEventSchema, OffConsumerEventSchema } from './compatibility-check';
import { checkSchemaCompatibility } from './compatibility-check';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A complete schema snapshot keyed by event name for one contract version. */
export interface VersionedSchemaSnapshot {
  /** The contract version this snapshot covers (matches on-chain `version()`). */
  contractVersion: number;
  /** Full event definitions expected for this version. */
  events: OffConsumerEventSchema[];
}

/** Result of resolving a schema for a given contract version. */
export type SchemaResolutionResult =
  | { status: 'found'; snapshot: VersionedSchemaSnapshot }
  | {
      status: 'not_found';
      requestedVersion: number;
      registeredVersions: number[];
      message: string;
    };

/** Possible outcomes of a version-aware compatibility check. */
export type VersionDiagnosticStatus = 'compatible' | 'incompatible' | 'unsupported';

export interface VersionDiagnostic {
  /** Overall outcome. */
  status: VersionDiagnosticStatus;
  /** The contract version that was evaluated. */
  contractVersion: number;
  /** Human-readable summary of the outcome. */
  message: string;
  /** Field-level breaking changes (empty when `compatible` or `unsupported`). */
  breakingChanges: string[];
  /** Non-breaking additions (empty when `unsupported`). */
  safeAdditions: string[];
  /** All contract versions that have a registered snapshot. */
  registeredVersions: number[];
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

/**
 * Maintains a mapping of `contractVersion → VersionedSchemaSnapshot` and
 * exposes version-aware schema resolution and diagnostic generation.
 */
export class ContractVersionRegistry {
  private readonly snapshots = new Map<number, VersionedSchemaSnapshot>();

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a schema snapshot for a specific contract version.
   *
   * Calling this with an already-registered version overwrites the previous
   * snapshot — useful in tests and when updating schemas in-place.
   *
   * @throws {Error} if `contractVersion` is not a positive integer.
   */
  register(contractVersion: number, events: OffConsumerEventSchema[]): this {
    if (!Number.isInteger(contractVersion) || contractVersion < 1) {
      throw new Error(
        `ContractVersionRegistry: contractVersion must be a positive integer, got ${contractVersion}`,
      );
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error(
        `ContractVersionRegistry: events must be a non-empty array for version ${contractVersion}`,
      );
    }
    this.snapshots.set(contractVersion, { contractVersion, events });
    return this;
  }

  /**
   * Remove the snapshot for a specific contract version.
   * Returns `true` if a snapshot was found and removed, `false` otherwise.
   */
  deregister(contractVersion: number): boolean {
    return this.snapshots.delete(contractVersion);
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Returns all registered contract versions in ascending order.
   */
  registeredVersions(): number[] {
    return [...this.snapshots.keys()].sort((a, b) => a - b);
  }

  /**
   * Returns `true` when a snapshot exists for `contractVersion`.
   */
  has(contractVersion: number): boolean {
    return this.snapshots.has(contractVersion);
  }

  /**
   * Resolve the schema snapshot for a given contract version.
   *
   * Returns a discriminated union — callers must handle both `found` and
   * `not_found` branches.
   */
  resolveSchema(contractVersion: number): SchemaResolutionResult {
    const snapshot = this.snapshots.get(contractVersion);
    if (snapshot) {
      return { status: 'found', snapshot };
    }
    const registered = this.registeredVersions();
    return {
      status: 'not_found',
      requestedVersion: contractVersion,
      registeredVersions: registered,
      message:
        `No schema snapshot registered for contract version ${contractVersion}. ` +
        `Registered versions: [${registered.join(', ') || 'none'}]. ` +
        `Register a snapshot with ContractVersionRegistry.register(${contractVersion}, events).`,
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Run a full compatibility check between live contract events and the
   * registered snapshot for `contractVersion`.
   *
   * Returns a `VersionDiagnostic` with status:
   * - `unsupported` — no snapshot is registered for `contractVersion`.
   * - `compatible`  — all consumer-expected fields match the contract events.
   * - `incompatible`— one or more breaking changes were detected.
   */
  diagnose(
    contractEvents: Map<string, ContractEventSchema>,
    contractVersion: number,
  ): VersionDiagnostic {
    const registered = this.registeredVersions();
    const resolution = this.resolveSchema(contractVersion);

    if (resolution.status === 'not_found') {
      return {
        status: 'unsupported',
        contractVersion,
        message:
          `Contract version ${contractVersion} is not supported. ` +
          `Supported versions: [${registered.join(', ') || 'none'}]. ` +
          `Add a snapshot via ContractVersionRegistry.register(${contractVersion}, events) ` +
          `to enable compatibility checking for this version.`,
        breakingChanges: [],
        safeAdditions: [],
        registeredVersions: registered,
      };
    }

    const { snapshot } = resolution;
    const consumerSchema = { events: snapshot.events };
    const result = checkSchemaCompatibility(contractEvents, consumerSchema);

    if (result.compatible) {
      return {
        status: 'compatible',
        contractVersion,
        message: `Contract version ${contractVersion} is fully compatible with the registered schema.`,
        breakingChanges: [],
        safeAdditions: result.safeAdditions,
        registeredVersions: registered,
      };
    }

    return {
      status: 'incompatible',
      contractVersion,
      message:
        `Contract version ${contractVersion} is incompatible with the registered schema. ` +
        `Found ${result.breakingChanges.length} breaking change(s). ` +
        `Review the breakingChanges field for details.`,
      breakingChanges: result.breakingChanges,
      safeAdditions: result.safeAdditions,
      registeredVersions: registered,
    };
  }

  /**
   * Clear all registered snapshots. Primarily useful in test teardowns.
   */
  clear(): void {
    this.snapshots.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _registry: ContractVersionRegistry | null = null;

/** Returns the module-level singleton registry, creating it on first call. */
export function getContractVersionRegistry(): ContractVersionRegistry {
  if (!_registry) {
    _registry = new ContractVersionRegistry();
  }
  return _registry;
}

/** Replace the singleton. Use in tests or during bootstrap. */
export function setContractVersionRegistry(registry: ContractVersionRegistry): void {
  _registry = registry;
}

/** Reset the singleton to `null`. Use in test teardowns. */
export function resetContractVersionRegistry(): void {
  _registry = null;
}
