#!/usr/bin/env node
/**
 * Dependency Vulnerability Audit Tool (#855)
 *
 * Runs security audit checks on project dependencies, parses findings,
 * renders visible summaries to stdout and $GITHUB_STEP_SUMMARY,
 * and ensures no secrets or credentials are ever exposed.
 *
 * Usage:
 *   node scripts/audit-dependencies.js [directory]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2] || process.cwd();
const dirName = path.basename(path.resolve(targetDir));

console.log(`\n========================================`);
console.log(`Auditing dependencies in: ${dirName}`);
console.log(`========================================\n`);

let auditJson = null;
let auditOutput = '';

try {
  // npm audit exits non-zero if vulnerabilities are found
  auditOutput = execSync('npm audit --json', {
    cwd: targetDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (error) {
  auditOutput = error.stdout ? error.stdout.toString() : '';
}

try {
  auditJson = JSON.parse(auditOutput);
} catch (e) {
  console.log(`Could not parse JSON audit output. Running plain npm audit...`);
  try {
    const plain = execSync('npm audit', { cwd: targetDir, encoding: 'utf-8' });
    console.log(plain);
  } catch (err) {
    console.log(err.stdout ? err.stdout.toString() : err.message);
  }
}

const vulnerabilities = auditJson?.metadata?.vulnerabilities || {
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
  total: 0,
};

console.log(`[VULNERABILITY FINDINGS for ${dirName}]`);
console.log(`  - Critical: ${vulnerabilities.critical || 0}`);
console.log(`  - High:     ${vulnerabilities.high || 0}`);
console.log(`  - Moderate: ${vulnerabilities.moderate || 0}`);
console.log(`  - Low:      ${vulnerabilities.low || 0}`);
console.log(`  - Info:     ${vulnerabilities.info || 0}`);
console.log(`  - Total:    ${vulnerabilities.total || 0}\n`);

// Save report to file for CI artifact upload
const reportsDir = path.resolve(process.cwd(), 'reports', 'dependency-audit');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}
const reportPath = path.join(reportsDir, `${dirName}-audit.json`);
fs.writeFileSync(reportPath, JSON.stringify(auditJson || { raw: auditOutput }, null, 2));

// Append to GitHub Actions Step Summary if in CI environment
const stepSummaryFile = process.env.GITHUB_STEP_SUMMARY;
if (stepSummaryFile && fs.existsSync(path.dirname(stepSummaryFile))) {
  const statusEmoji =
    (vulnerabilities.critical || 0) > 0
      ? '🔴'
      : (vulnerabilities.high || 0) > 0
      ? '🟠'
      : (vulnerabilities.moderate || 0) > 0
      ? '🟡'
      : '🟢';

  let markdown = `### ${statusEmoji} Dependency Audit: \`${dirName}\`\n\n`;
  markdown += `| Severity | Count |\n`;
  markdown += `|:---|:---:|\n`;
  markdown += `| 🚨 Critical | **${vulnerabilities.critical || 0}** |\n`;
  markdown += `| ⚠️ High | **${vulnerabilities.high || 0}** |\n`;
  markdown += `| ⚡ Moderate | ${vulnerabilities.moderate || 0} |\n`;
  markdown += `| ℹ️ Low | ${vulnerabilities.low || 0} |\n`;
  markdown += `| 📝 Total | **${vulnerabilities.total || 0}** |\n\n`;

  // List top advisory findings if available
  const advisories = auditJson?.vulnerabilities;
  if (advisories && typeof advisories === 'object') {
    const entries = Object.entries(advisories).slice(0, 10);
    if (entries.length > 0) {
      markdown += `<details><summary>Top Advisory Details</summary>\n\n`;
      markdown += `| Package | Severity | Via | Range |\n`;
      markdown += `|:---|:---|:---|:---|\n`;
      for (const [pkg, info] of entries) {
        const sev = info.severity || 'unknown';
        const via = Array.isArray(info.via)
          ? info.via.map((v) => (typeof v === 'string' ? v : v.title || v.name)).join(', ')
          : String(info.via || '');
        const range = info.range || '-';
        markdown += `| \`${pkg}\` | ${sev} | ${via} | ${range} |\n`;
      }
      markdown += `\n</details>\n\n`;
    }
  }

  try {
    fs.appendFileSync(stepSummaryFile, markdown, 'utf-8');
  } catch (err) {
    console.error('Could not write to GITHUB_STEP_SUMMARY:', err.message);
  }
}

console.log(`Audit report saved to: ${reportPath}`);
