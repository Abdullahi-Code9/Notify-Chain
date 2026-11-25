#!/usr/bin/env node
/**
 * migrate-config.js — NotifyChain configuration migration utility (#1050)
 *
 * Reads a .env-style file, validates it against the v1 schema, applies v2
 * renames and removals, then emits a deterministic (alphabetically sorted)
 * v2 config.
 *
 * Usage:
 *   node scripts/migrate-config.js <input-file>           # dry-run → stdout
 *   node scripts/migrate-config.js <input-file> --confirm # write <input-file>.migrated
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Schema loading ────────────────────────────────────────────────────────────
// Use pathToFileURL so that Windows absolute paths (e.g. C:\...) are converted
// to valid file:// URLs that the ESM loader accepts on all platforms.

const v1 = (await import(pathToFileURL(path.join(__dirname, 'config-schemas', 'v1.js')).href)).default;
const v2 = (await import(pathToFileURL(path.join(__dirname, 'config-schemas', 'v2.js')).href)).default;

// ── Core helpers (exported for tests) ────────────────────────────────────────

/**
 * Parse a .env-style string into a plain key→value object.
 * Blank lines and lines starting with '#' are ignored.
 * Lines must match KEY=VALUE (value may be empty).
 *
 * @param {string} content Raw file content.
 * @returns {Record<string, string>}
 */
export function parseEnvFile(content) {
  const result = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue; // not a valid KEY=VALUE line
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Validate a parsed env object against the v1 schema.
 * Returns an array of missing required key names (empty → valid).
 *
 * @param {Record<string, string>} parsed
 * @returns {string[]} Missing required keys.
 */
export function validateV1(parsed) {
  return v1.required.filter((key) => !(key in parsed));
}

/**
 * Apply v1→v2 migration to a parsed env object.
 * - Renames keys per v2.renames.
 * - Drops keys listed in v2.removed (with a warning to stderr).
 * - Returns a NEW object sorted alphabetically by key.
 *
 * @param {Record<string, string>} parsed Validated v1 config.
 * @returns {Record<string, string>} Migrated v2 config (sorted).
 */
export function migrateConfig(parsed) {
  const working = { ...parsed };

  // Apply renames
  for (const [oldKey, newKey] of Object.entries(v2.renames)) {
    if (oldKey in working) {
      working[newKey] = working[oldKey];
      delete working[oldKey];
    }
  }

  // Drop removed keys (warn, don't fail)
  for (const removedKey of v2.removed) {
    if (removedKey in working) {
      process.stderr.write(
        `Warning: key "${removedKey}" was removed in v2 and will not appear in the migrated config.\n`,
      );
      delete working[removedKey];
    }
  }

  // Sort alphabetically
  return Object.fromEntries(
    Object.entries(working).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Serialise a parsed env object to a .env-style string with a header comment.
 *
 * @param {Record<string, string>} config Sorted config object.
 * @returns {string}
 */
export function serializeEnv(config) {
  const lines = ['# Migrated from v1 to v2 by migrate-config.js', ''];
  for (const [key, value] of Object.entries(config)) {
    lines.push(`${key}=${value}`);
  }
  lines.push(''); // trailing newline
  return lines.join('\n');
}

// ── CLI entry point ───────────────────────────────────────────────────────────

// Guard so the CLI block only runs when this file is the entry point.
// In ESM there is no `require.main === module`; compare import.meta.url instead.
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const inputFile = args.find((a) => !a.startsWith('-'));

  if (!inputFile) {
    process.stderr.write('Error: no input file specified.\nUsage: node scripts/migrate-config.js <input-file> [--confirm]\n');
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);

  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`Error: input file not found: ${inputPath}\n`);
    process.exit(1);
  }

  const content = fs.readFileSync(inputPath, 'utf8');
  const parsed = parseEnvFile(content);

  const missing = validateV1(parsed);
  if (missing.length > 0) {
    process.stderr.write(
      `Error: input config is missing required v1 keys: ${missing.join(', ')}\n`,
    );
    process.exit(1);
  }

  const migrated = migrateConfig(parsed);
  const output = serializeEnv(migrated);

  if (confirm) {
    const outPath = `${inputPath}.migrated`;
    fs.writeFileSync(outPath, output, 'utf8');
    process.stdout.write(`Written to ${outPath}\n`);
  } else {
    process.stdout.write(output);
  }
}
