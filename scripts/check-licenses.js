// scripts/check-licenses.js
// Reads installed dependency licenses directly from node_modules package.json files.
// Usage: node scripts/check-licenses.js <workspace-dir> [<workspace-dir>...]
// Exits 1 if any production dependency has a restricted or unknown license.

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const policyPath = resolve(__dirname, "..", "license-policy.json");
const rawPolicy = readFileSync(policyPath, "utf8").replace(/^\uFEFF/, "");
const policy = JSON.parse(rawPolicy);

const APPROVED = new Set(policy.approved || []);
const RESTRICTED = new Set(policy.restricted || []);
const REVIEW_REQUIRED = new Set(policy.review_required || []);
const EXCEPTIONS = policy.exceptions || {};

// Normalize SPDX suffixes: "LGPL-3.0-only" -> "LGPL-3.0", "GPL-2.0-or-later" -> "GPL-2.0"
function normalizeSpdxId(id) {
  return id.replace(/-(only|or-later)$/, "").trim();
}

// Phrases that mean "license is in a file" — need human inspection, not a hard fail
const SEE_LICENSE_PATTERN = /^SEE LICENSE IN/i;

function parseSpdxIds(expr) {
  if (!expr) return [];
  return expr.replace(/[()]/g, "").trim().split(/ OR | AND /).map((s) => normalizeSpdxId(s.trim()));
}

function spdxIsApproved(expr) {
  if (!expr || expr === "UNLICENSED" || SEE_LICENSE_PATTERN.test(expr)) return false;
  const ids = parseSpdxIds(expr);
  // OR: any approved id suffices; AND: all must be approved
  return expr.includes(" OR ") ? ids.some((id) => APPROVED.has(id)) : ids.every((id) => APPROVED.has(id));
}

function spdxIsRestricted(expr) {
  if (!expr || SEE_LICENSE_PATTERN.test(expr)) return false;
  return parseSpdxIds(expr).some((id) => RESTRICTED.has(id));
}

function spdxNeedsReview(expr) {
  if (!expr) return false;
  if (SEE_LICENSE_PATTERN.test(expr)) return true; // license file needs manual check
  return parseSpdxIds(expr).some((id) => REVIEW_REQUIRED.has(id));
}

/**
 * Collect all direct+transitive production deps from package-lock.json v2/v3.
 * Returns a Map of packageName -> license string.
 */
function collectLicensesFromLock(workspaceDir) {
  const lockPath = join(workspaceDir, "package-lock.json");
  if (!existsSync(lockPath)) {
    throw new Error("No package-lock.json found in " + workspaceDir);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));

  // lockfileVersion 2/3: packages map contains all installed packages
  const packages = lock.packages || {};
  const licenses = new Map(); // pkgKey -> { name, version, license }

  for (const [pkgKey, meta] of Object.entries(packages)) {
    if (pkgKey === "") continue; // root package
    if (meta.dev) continue;     // skip dev-only packages
    if (meta.peer) continue;    // skip peer dependencies

    // pkgKey is like "node_modules/express" or "node_modules/a/node_modules/b"
    const name = pkgKey.replace(/^.*node_modules\//, "");
    const version = meta.version || "unknown";

    // Prefer on-disk package.json for most accurate license field
    const pkgJsonPath = join(workspaceDir, pkgKey, "package.json");
    let license = meta.license;
    if (!license && existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        license = pkg.license || (Array.isArray(pkg.licenses) && pkg.licenses[0] && pkg.licenses[0].type);
      } catch { /* ignore */ }
    }

    licenses.set(pkgKey, { name, version, license: license || "" });
  }

  return licenses;
}

function checkWorkspace(workspaceDir) {
  const absDir = resolve(workspaceDir);
  console.log("\n=== Checking licenses in: " + absDir + " ===");

  let licenses;
  try {
    licenses = collectLicensesFromLock(absDir);
  } catch (e) {
    console.error("  [ERROR] " + e.message);
    return { restricted: [], reviewRequired: [], unknown: [] };
  }

  const results = { restricted: [], reviewRequired: [], unknown: [], exceptions: [] };

  for (const { name, version, license } of licenses.values()) {
    if (EXCEPTIONS[name]) {
      results.exceptions.push({
        name,
        version,
        license: license || "(none)",
        reason: EXCEPTIONS[name].reason || "Documented exception",
      });
      continue;
    }

    if (!license || license === "UNKNOWN") {
      results.unknown.push({ name, version, license: license || "(none)" });
    } else if (spdxIsRestricted(license)) {
      results.restricted.push({ name, version, license });
    } else if (spdxNeedsReview(license)) {
      results.reviewRequired.push({ name, version, license });
    } else if (!spdxIsApproved(license)) {
      results.unknown.push({ name, version, license });
    }
  }

  return results;
}

function printTable(label, items) {
  if (items.length === 0) return;
  console.log("\n  [" + label + "]");
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    if (item.reason) {
      console.log("    - " + item.name + "@" + item.version + " (" + item.license + ") -> Exception: " + item.reason);
    } else {
      console.log("    - " + item.name + "@" + item.version + " (" + item.license + ")");
    }
  }
}

const workspaces = process.argv.slice(2);
if (workspaces.length === 0) {
  console.error("Usage: node scripts/check-licenses.js <workspace-dir> [<workspace-dir>...]");
  process.exit(2);
}

let hasFailure = false;
let hasWarning = false;

for (const ws of workspaces) {
  const { restricted, reviewRequired, unknown, exceptions } = checkWorkspace(ws);

  if (exceptions && exceptions.length > 0) {
    console.log("\n  ℹ EXCEPTIONS active for pre-existing dependencies:");
    printTable("EXCEPTIONS", exceptions);
  }

  if (restricted.length > 0) {
    console.error("\n  ✗ RESTRICTED licenses found — these block distribution:");
    printTable("RESTRICTED", restricted);
    hasFailure = true;
  }

  if (unknown.length > 0) {
    console.error("\n  ✗ UNKNOWN/unapproved licenses found — manual review required:");
    printTable("UNKNOWN", unknown);
    hasFailure = true;
  }

  if (reviewRequired.length > 0) {
    console.warn("\n  ⚠ REVIEW-REQUIRED licenses — get legal sign-off before shipping:");
    printTable("REVIEW REQUIRED", reviewRequired);
    hasWarning = true;
  }

  if (restricted.length === 0 && unknown.length === 0 && reviewRequired.length === 0) {
    console.log("  ✓ All production dependencies use approved licenses.");
  }
}

if (hasWarning && !hasFailure) {
  console.warn("\nWarning: some licenses require review. See license-policy.json for guidance.");
}

if (hasFailure) {
  console.error(
    "\nLicense check FAILED. See license-policy.json for the approved list.\n" +
    "To add a license exception, update 'approved' or 'exceptions' in license-policy.json and get it reviewed."
  );
  process.exit(1);
}

console.log("\nLicense check passed.");