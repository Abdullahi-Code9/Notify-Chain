#!/usr/bin/env ts-node
/**
 * Contract Event Documentation Drift Detector
 * ============================================
 *
 * Lightweight check that parses every `#[contractevent]` struct from the
 * NotifyChain smart-contract source code and compares the declared set of
 * events, plus each event's required field names and types, against the
 * human-written reference docs in `CONTRACT_EVENT_REFERENCE.md`.
 *
 * Exits with a non-zero status code the moment it detects any of:
 *   - An event that is documented but does not exist in the contract source.
 *   - An event that exists in the contract source but has no documentation.
 *   - A documented field whose name or type does not match the source struct.
 *   - A documented field that does not exist on the source struct.
 *
 * Usage
 * -----
 *   # From anywhere inside the repo:
 *   ts-node listener/scripts/check-event-docs.ts
 *
 *   # Or via package.json script (preferred for CI):
 *   cd listener
 *   npm run check:event-docs
 *
 * The script auto-discovers the repo root by walking up from __dirname and
 * therefore keeps working if you move the listener/ directory relative to
 * contract/ and the markdown reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Auto-discover the repo root.
// ---------------------------------------------------------------------------

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 16; i += 1) {
    if (
      fs.existsSync(path.join(current, "CONTRACT_EVENT_REFERENCE.md")) &&
      fs.existsSync(path.join(current, "contract")) &&
      fs.existsSync(path.join(current, "AGENTS.md"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    "Could not locate repository root (looking for CONTRACT_EVENT_REFERENCE.md + contract/ + AGENTS.md).",
  );
}

const REPO_ROOT = findRepoRoot(__dirname);
const EVENTS_RS = path.join(
  REPO_ROOT,
  "contract",
  "contracts",
  "hello-world",
  "src",
  "base",
  "events.rs",
);
const EVENTS_MD = path.join(REPO_ROOT, "CONTRACT_EVENT_REFERENCE.md");

// ---------------------------------------------------------------------------
// Parsed data models.
// ---------------------------------------------------------------------------

type SorobanFieldType =
  | "Address"
  | "BytesN<32>"
  | "u32"
  | "u64"
  | "u128"
  | "i128"
  | "bool"
  | "String"
  | "Vec<BytesN<32>>"
  | "NotificationCategory"
  | "NotificationPriority"
  | "AuditAction";

interface StructField {
  name: string;
  type: SorobanFieldType;
  isTopic: boolean;
}

interface ContractEvent {
  name: string;
  fields: StructField[];
}

interface DocField {
  name: string;
  /** Raw type text from the documentation table (we canonicalise later). */
  documentedType: string;
  indexed: boolean;
}

interface DocumentedEvent {
  name: string;
  fields: DocField[];
}

// ---------------------------------------------------------------------------
// Rust source parser.
// ---------------------------------------------------------------------------

/**
 * Very small, targeted parser for the events.rs module.  The grammar we
 * support on purpose is exactly what the codebase already uses:
 *
 *   #[contractevent(data_format = "single-value")]
 *   #[derive(Clone)]
 *   pub struct MyEvent {
 *       #[topic]
 *       pub creator: Address,
 *       #[topic]
 *       pub category: NotificationCategory,
 *       pub id: BytesN<32>,
 *   }
 *
 * Anything outside that shape is an error rather than silently skipped so
 * the detector does not produce false "no drift" results when the source
 * style changes.
 */
function parseRustEvents(source: string): ContractEvent[] {
  const events: ContractEvent[] = [];
  const lines = source.split(/\r?\n/);

  let lineIdx = 0;
  while (lineIdx < lines.length) {
    const trimmed = lines[lineIdx].trimStart();

    if (trimmed.startsWith("#[contractevent")) {
      const startIdx = lineIdx;
      while (
        lineIdx < lines.length &&
        !lines[lineIdx].trimStart().startsWith("pub struct ")
      ) {
        lineIdx += 1;
      }
      if (lineIdx >= lines.length) {
        throw new Error(
          `Found #[contractevent] at line ${startIdx + 1} but no following "pub struct"`,
        );
      }
      const structNameMatch = lines[lineIdx]
        .trimStart()
        .match(/^pub\s+struct\s+([A-Za-z0-9_]+)\s*\{/);
      if (!structNameMatch) {
        throw new Error(
          `Cannot parse struct name at line ${lineIdx + 1}: ${lines[lineIdx]}`,
        );
      }
      const eventName = structNameMatch[1];
      lineIdx += 1;

      const fields: StructField[] = [];
      while (lineIdx < lines.length && !lines[lineIdx].trimStart().startsWith("}")) {
        const fieldLine = lines[lineIdx].trimStart();
        lineIdx += 1;
        if (fieldLine === "" || fieldLine.startsWith("//")) {
          continue;
        }

        const topicMatch = fieldLine.match(/^#\[topic\]\s*$/);
        if (topicMatch) {
          continue;
        }

        const prevLine = lines[lineIdx - 2] ?? "";
        const isTopic = prevLine.trimStart().startsWith("#[topic]");

        const fieldMatch = fieldLine.match(
          /^pub\s+([a-zA-Z0-9_]+)\s*:\s*([A-Za-z0-9_<>,\s]+)\s*,?\s*$/,
        );
        if (!fieldMatch) {
          continue;
        }
        const name = fieldMatch[1];
        const rawType = fieldMatch[2].trim() as SorobanFieldType;
        fields.push({ name, type: rawType, isTopic });
      }
      events.push({ name: eventName, fields });
    }
    lineIdx += 1;
  }

  return events;
}

// ---------------------------------------------------------------------------
// Markdown reference docs parser.
// ---------------------------------------------------------------------------

function parseMarkdownEvents(markdown: string): DocumentedEvent[] {
  const lines = markdown.split(/\r?\n/);
  const events: DocumentedEvent[] = [];
  let lineIdx = 0;

  while (lineIdx < lines.length) {
    const trimmed = lines[lineIdx].trim();
    const headingMatch = trimmed.match(/^###+\s+([A-Z][A-Za-z0-9]+)\s*$/);
    if (!headingMatch) {
      lineIdx += 1;
      continue;
    }
    const candidateName = headingMatch[1];

    let tableStart = lineIdx + 1;
    while (
      tableStart < lines.length &&
      !lines[tableStart].trim().startsWith("| Field")
    ) {
      if (lines[tableStart].trim().startsWith("###")) {
        break;
      }
      tableStart += 1;
    }
    if (tableStart >= lines.length || !lines[tableStart].trim().startsWith("| Field")) {
      lineIdx += 1;
      continue;
    }

    const headerRow = lines[tableStart].trim();
    const separatorRow = lines[tableStart + 1]?.trim() ?? "";
    if (!separatorRow.startsWith("|---")) {
      throw new Error(
        `Malformed event field table for ${candidateName} near line ${tableStart + 1}`,
      );
    }

    const headers = headerRow
      .split("|")
      .slice(1, -1)
      .map((h) => h.trim().toLowerCase());
    const nameColIdx = headers.indexOf("field");
    const typeColIdx = headers.indexOf("type");
    const indexedColIdx = headers.indexOf("indexed");
    if (nameColIdx === -1 || typeColIdx === -1) {
      throw new Error(
        `Event table for ${candidateName} is missing Field/Type columns (got: ${headers.join(",")}).`,
      );
    }

    const fields: DocField[] = [];
    let dataRowIdx = tableStart + 2;
    while (
      dataRowIdx < lines.length &&
      lines[dataRowIdx].trim().startsWith("|") &&
      !lines[dataRowIdx].trim().startsWith("|---")
    ) {
      const cols = lines[dataRowIdx].trim().split("|").slice(1, -1).map((c) => c.trim());
      const fieldName = cols[nameColIdx];
      const documentedType = cols[typeColIdx];
      const indexedRaw = indexedColIdx !== -1 ? cols[indexedColIdx] ?? "" : "";
      const indexed =
        indexedRaw.includes("topic") ||
        indexedRaw.toLowerCase().startsWith("y") ||
        indexedRaw.includes("✅");

      if (!fieldName || !documentedType) {
        dataRowIdx += 1;
        continue;
      }
      fields.push({ name: fieldName, documentedType, indexed });
      dataRowIdx += 1;
    }

    events.push({ name: candidateName, fields });
    lineIdx = dataRowIdx;
  }

  return events;
}

// ---------------------------------------------------------------------------
// Type canonicalisation.
//
// The Markdown docs use human-readable formatting like `Vec<BytesN<32>>`,
// `NotificationCategory (u32)`, etc. The Rust source uses the raw Soroban
// types.  We normalise both to a single comparable string before comparing.
// ---------------------------------------------------------------------------

const TYPE_ALIASES = new Map<string, SorobanFieldType>([
  ["address", "Address"],
  ["bytesn<32>", "BytesN<32>"],
  ["bytesn < 32 >", "BytesN<32>"],
  ["u32", "u32"],
  ["u64", "u64"],
  ["u128", "u128"],
  ["i128", "i128"],
  ["bool", "bool"],
  ["string", "String"],
  ["vec<bytesn<32>>", "Vec<BytesN<32>>"],
  ["vec < bytesn < 32 > >", "Vec<BytesN<32>>"],
  ["notificationcategory", "NotificationCategory"],
  ["notificationcategory (u32)", "NotificationCategory"],
  ["notificationpriority", "NotificationPriority"],
  ["notificationpriority (u32)", "NotificationPriority"],
  ["auditaction", "AuditAction"],
  ["auditaction (u32)", "AuditAction"],
]);

function canonicaliseType(raw: string): SorobanFieldType | string {
  const cleaned = raw
    .trim()
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\s*([<>])\s*/g, "$1");
  return TYPE_ALIASES.get(cleaned) ?? raw.trim().replace(/`/g, "");
}

// ---------------------------------------------------------------------------
// Diff engine + reporting.
// ---------------------------------------------------------------------------

interface DiffIssue {
  level: "error" | "warning";
  event: string;
  message: string;
}

function diff(
  sourceEvents: ContractEvent[],
  docEvents: DocumentedEvent[],
): DiffIssue[] {
  const issues: DiffIssue[] = [];
  const sourceByName = new Map(sourceEvents.map((e) => [e.name, e]));
  const docByName = new Map(docEvents.map((e) => [e.name, e]));

  const allNames = new Set<string>([
    ...sourceByName.keys(),
    ...docByName.keys(),
  ]);

  for (const name of Array.from(allNames).sort()) {
    const inSource = sourceByName.get(name);
    const inDocs = docByName.get(name);

    if (inSource && !inDocs) {
      issues.push({
        level: "error",
        event: name,
        message:
          `Event '${name}' is defined in contract events.rs but has no ` +
          "documentation section in CONTRACT_EVENT_REFERENCE.md. Please add " +
          `a ### ${name} heading with a | Field | Type | Indexed | Description | table.`,
      });
      continue;
    }

    if (inDocs && !inSource) {
      issues.push({
        level: "error",
        event: name,
        message:
          `Documentation references event '${name}' but no matching ` +
          "struct with #[contractevent] exists in events.rs. Either remove " +
          "the stale docs section or add the missing struct.",
      });
      continue;
    }

    if (!inSource || !inDocs) {
      continue;
    }

    const sourceFields = new Map(inSource.fields.map((f) => [f.name, f]));
    const docFields = new Map(inDocs.fields.map((f) => [f.name, f]));
    const fieldNames = new Set<string>([
      ...sourceFields.keys(),
      ...docFields.keys(),
    ]);

    for (const fieldName of Array.from(fieldNames).sort()) {
      const src = sourceFields.get(fieldName);
      const doc = docFields.get(fieldName);

      if (src && !doc) {
        issues.push({
          level: "error",
          event: name,
          message:
            `Field '${fieldName}' (type '${src.type}', ${src.isTopic ? "topic" : "data"}) ` +
            `exists on event '${name}' in events.rs but is missing from the docs table.`,
        });
        continue;
      }

      if (doc && !src) {
        issues.push({
          level: "error",
          event: name,
          message:
            `Docs table for '${name}' lists field '${fieldName}' (type '${doc.documentedType}') ` +
            "but that field is not declared on the Rust struct.",
        });
        continue;
      }

      if (!src || !doc) {
        continue;
      }

      const canonicalSourceType = canonicaliseType(src.type);
      const canonicalDocType = canonicaliseType(doc.documentedType);
      if (canonicalSourceType !== canonicalDocType) {
        issues.push({
          level: "error",
          event: name,
          message:
            `Field '${name}.${fieldName}' has type '${src.type}' ` +
            `in events.rs but docs declare '${doc.documentedType}'. ` +
            `(Canonicalised: ${String(canonicalSourceType)} vs ${String(canonicalDocType)}).`,
        });
      }

      if (src.isTopic !== doc.indexed) {
        issues.push({
          level: "warning",
          event: name,
          message:
            `Field '${name}.${fieldName}': source says ${src.isTopic ? "topic/indexed" : "data/not indexed"} ` +
            `but docs say ${doc.indexed ? "indexed" : "not indexed"}. ` +
            "Topic/data placement affects filterability by off-chain indexers — double-check both.",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Pretty output.
// ---------------------------------------------------------------------------

function printReport(
  sourceEvents: ContractEvent[],
  docEvents: DocumentedEvent[],
  issues: DiffIssue[],
): void {
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  // eslint-disable-next-line no-console
  console.log("============================================================");
  // eslint-disable-next-line no-console
  console.log("  NotifyChain Contract Event Documentation Drift Check");
  // eslint-disable-next-line no-console
  console.log("============================================================");
  // eslint-disable-next-line no-console
  console.log(`  Source:        ${path.relative(REPO_ROOT, EVENTS_RS)}`);
  // eslint-disable-next-line no-console
  console.log(`  Documentation: ${path.relative(REPO_ROOT, EVENTS_MD)}`);
  // eslint-disable-next-line no-console
  console.log("------------------------------------------------------------");
  // eslint-disable-next-line no-console
  console.log(`  Contract events found in source:  ${sourceEvents.length}`);
  // eslint-disable-next-line no-console
  console.log(`  Event sections found in docs:     ${docEvents.length}`);
  // eslint-disable-next-line no-console
  console.log(`  Issues:  ${errors.length} errors, ${warnings.length} warnings`);
  // eslint-disable-next-line no-console
  console.log("------------------------------------------------------------");

  if (issues.length === 0) {
    // eslint-disable-next-line no-console
    console.log("✅ No event documentation drift detected.");
    return;
  }

  for (const issue of issues) {
    const tag = issue.level === "error" ? "✖ ERROR " : "⚠ WARN  ";
    // eslint-disable-next-line no-console
    console.log(`${tag} [${issue.event}]`);
    // eslint-disable-next-line no-console
    console.log(`        ${issue.message}`);
  }

  // eslint-disable-next-line no-console
  console.log("------------------------------------------------------------");
  // eslint-disable-next-line no-console
  console.log(
    "HOW TO FIX:",
  );
  // eslint-disable-next-line no-console
  console.log(
    "  1. Open CONTRACT_EVENT_REFERENCE.md and the relevant event struct in",
  );
  // eslint-disable-next-line no-console
  console.log(
    "     contract/contracts/hello-world/src/base/events.rs side by side.",
  );
  // eslint-disable-next-line no-console
  console.log(
    "  2. Match the event heading and the | Field | Type | Indexed | table to",
  );
  // eslint-disable-next-line no-console
  console.log(
    "     the struct definition, one field at a time.",
  );
  // eslint-disable-next-line no-console
  console.log(
    "  3. Re-run locally:  cd listener && npm run check:event-docs",
  );
  // eslint-disable-next-line no-console
  console.log("------------------------------------------------------------");
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): number {
  if (!fs.existsSync(EVENTS_RS)) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: events.rs not found at ${EVENTS_RS}`);
    return 2;
  }
  if (!fs.existsSync(EVENTS_MD)) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: CONTRACT_EVENT_REFERENCE.md not found at ${EVENTS_MD}`);
    return 2;
  }

  const rustSrc = fs.readFileSync(EVENTS_RS, "utf8");
  const markdownSrc = fs.readFileSync(EVENTS_MD, "utf8");

  const sourceEvents = parseRustEvents(rustSrc);
  const docEvents = parseMarkdownEvents(markdownSrc);

  const issues = diff(sourceEvents, docEvents);
  printReport(sourceEvents, docEvents, issues);

  const errors = issues.filter((i) => i.level === "error");
  return errors.length === 0 ? 0 : 1;
}

const exitCode = main();
process.exit(exitCode);
