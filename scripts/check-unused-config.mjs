#!/usr/bin/env node

/**
 * Configuration Drift Detection Tool
 * 
 * This tool identifies configuration variables documented in .env.example files
 * or configuration documentation that are no longer referenced in the application codebase.
 * 
 * Usage:
 *   node scripts/check-unused-config.mjs
 *   npm run lint:config
 * 
 * Exit Codes:
 *   0 - All documented variables are accounted for or allowlisted
 *   1 - Unreferenced, non-allowlisted variables detected
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Directories to scan for environment variable usage
  scanDirs: [
    'listener/src',
    'dashboard/src',
    'contract/contracts',
    'Documents/Task Bounty/src'
  ],
  
  // File extensions to scan for usage
  scanExtensions: ['.ts', '.tsx', '.js', '.jsx', '.rs', '.toml', '.json', '.yaml', '.yml'],
  
  // Files containing environment variable documentation
  envExampleFiles: [
    'listener/.env.example',
    'Documents/Task Bounty/.env.example',
    'dashboard/.env.example'
  ],
  
  // Additional documentation files to parse
  docFiles: [
    'README.md',
    'listener/README.md',
    'dashboard/README.md'
  ],
  
  // Allowlist file path
  allowlistFile: '.config-audit-ignore',
  
  // Ignore directories
  ignoreDirs: [
    'node_modules',
    'dist',
    'build',
    'target',
    '.git',
    'coverage',
    '__tests__',
    'test',
    'tests'
  ]
};

// ============================================================================
// Color Output Utilities
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
};

function colorize(text, color) {
  return `${color}${text}${colors.reset}`;
}

// ============================================================================
// File System Utilities
// ============================================================================

function fileExists(filePath) {
  try {
    return fs.existsSync(path.resolve(ROOT_DIR, filePath));
  } catch {
    return false;
  }
}

function readFile(filePath) {
  try {
    const fullPath = path.resolve(ROOT_DIR, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  } catch (error) {
    return null;
  }
}

function getAllFiles(dirPath, extensions, ignoreDirs) {
  const files = [];
  const fullDirPath = path.resolve(ROOT_DIR, dirPath);
  
  if (!fs.existsSync(fullDirPath)) {
    return files;
  }
  
  function traverse(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(ROOT_DIR, fullPath);
      
      if (entry.isDirectory()) {
        if (!ignoreDirs.includes(entry.name)) {
          traverse(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          files.push(relativePath);
        }
      }
    }
  }
  
  traverse(fullDirPath);
  return files;
}

// ============================================================================
// Environment Variable Extraction
// ============================================================================

/**
 * Extract environment variable names from .env.example files
 * Handles:
 * - VAR_NAME=value
 * - VAR_NAME = value
 * - # comments
 * - Empty lines
 */
function extractFromEnvExample(content, sourcePath) {
  const variables = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip comments and empty lines
    if (!line || line.startsWith('#')) {
      continue;
    }
    
    // Match VAR_NAME=... pattern
    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) {
      variables.push({
        name: match[1],
        source: sourcePath,
        line: i + 1
      });
    }
  }
  
  return variables;
}

/**
 * Extract environment variables mentioned in documentation
 * Looks for patterns like `VAR_NAME`, **VAR_NAME**, etc.
 */
function extractFromDocs(content, sourcePath) {
  const variables = new Set();
  
  // Match environment variable patterns in markdown
  // Patterns: `VAR_NAME`, **VAR_NAME**, VAR_NAME in tables, etc.
  const patterns = [
    /`([A-Z_][A-Z0-9_]+)`/g,
    /\*\*([A-Z_][A-Z0-9_]+)\*\*/g,
    /\|\s*([A-Z_][A-Z0-9_]+)\s*\|/g,
    /^([A-Z_][A-Z0-9_]+):/gm
  ];
  
  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      variables.add(match[1]);
    }
  }
  
  return Array.from(variables).map(name => ({
    name,
    source: sourcePath,
    line: 0 // Line numbers not tracked for doc files
  }));
}

// ============================================================================
// Usage Detection
// ============================================================================

/**
 * Check if a variable is used in the codebase
 * Handles various access patterns:
 * - process.env.VAR_NAME
 * - process.env['VAR_NAME']
 * - process.env["VAR_NAME"]
 * - import.meta.env.VAR_NAME
 * - std::env::var("VAR_NAME")
 * - os.environ["VAR_NAME"]
 * - Destructured: const { VAR_NAME } = process.env
 * - String literals: 'VAR_NAME', "VAR_NAME" in config contexts
 */
function findVariableUsage(varName, files) {
  const usages = [];
  
  // Build regex patterns for different access methods
  const patterns = [
    // JavaScript/TypeScript patterns
    new RegExp(`process\\.env\\.${varName}\\b`, 'g'),
    new RegExp(`process\\.env\\[['"]${varName}['"]\\]`, 'g'),
    new RegExp(`import\\.meta\\.env\\.${varName}\\b`, 'g'),
    new RegExp(`import\\.meta\\.env\\[['"]${varName}['"]\\]`, 'g'),
    
    // Destructuring patterns
    new RegExp(`\\{\\s*${varName}\\s*\\}\\s*=\\s*process\\.env`, 'g'),
    new RegExp(`\\{\\s*${varName}\\s*\\}\\s*=\\s*import\\.meta\\.env`, 'g'),
    
    // Rust patterns
    new RegExp(`env::var\\(["']${varName}["']\\)`, 'g'),
    new RegExp(`std::env::var\\(["']${varName}["']\\)`, 'g'),
    
    // Python patterns
    new RegExp(`os\\.environ\\[["']${varName}["']\\]`, 'g'),
    new RegExp(`os\\.getenv\\(["']${varName}["']\\)`, 'g'),
    
    // Config file string references (case-sensitive exact match)
    new RegExp(`['"]${varName}['"]`, 'g'),
    
    // YAML/TOML environment variable references
    new RegExp(`\\$\\{${varName}\\}`, 'g'),
    new RegExp(`\\$${varName}\\b`, 'g')
  ];
  
  for (const filePath of files) {
    const content = readFile(filePath);
    if (!content) continue;
    
    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const lineNumber = content.substring(0, match.index).split('\n').length;
        usages.push({
          file: filePath,
          line: lineNumber,
          context: getLineContext(content, lineNumber)
        });
      }
    }
  }
  
  return usages;
}

function getLineContext(content, lineNumber, contextLines = 0) {
  const lines = content.split('\n');
  const index = lineNumber - 1;
  
  if (contextLines === 0) {
    return lines[index]?.trim() || '';
  }
  
  const start = Math.max(0, index - contextLines);
  const end = Math.min(lines.length, index + contextLines + 1);
  
  return lines.slice(start, end).map(l => l.trim()).join(' ... ');
}

// ============================================================================
// Allowlist Management
// ============================================================================

function loadAllowlist() {
  const allowlistPath = path.resolve(ROOT_DIR, CONFIG.allowlistFile);
  const allowlist = new Map(); // varName -> reason
  
  if (!fs.existsSync(allowlistPath)) {
    return allowlist;
  }
  
  const content = fs.readFileSync(allowlistPath, 'utf-8');
  const lines = content.split('\n');
  
  let currentVar = null;
  let currentReason = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) {
      if (currentVar) {
        allowlist.set(currentVar, currentReason.trim());
        currentVar = null;
        currentReason = '';
      }
      continue;
    }
    
    // Comment lines starting with # are reasons
    if (trimmed.startsWith('#')) {
      currentReason += trimmed.substring(1).trim() + ' ';
      continue;
    }
    
    // Variable names
    if (trimmed.match(/^[A-Z_][A-Z0-9_]*$/)) {
      if (currentVar) {
        allowlist.set(currentVar, currentReason.trim());
      }
      currentVar = trimmed;
      currentReason = '';
    }
  }
  
  // Handle last entry
  if (currentVar) {
    allowlist.set(currentVar, currentReason.trim());
  }
  
  return allowlist;
}

// ============================================================================
// Reporting
// ============================================================================

function printHeader() {
  console.log('');
  console.log(colorize('━'.repeat(80), colors.cyan));
  console.log(colorize('  Configuration Drift Detection Report', colors.bold + colors.cyan));
  console.log(colorize('━'.repeat(80), colors.cyan));
  console.log('');
}

function printSection(title) {
  console.log('');
  console.log(colorize(`▶ ${title}`, colors.bold + colors.blue));
  console.log(colorize('─'.repeat(80), colors.gray));
}

function printVariable(varInfo) {
  console.log(`  ${colorize(varInfo.name, colors.bold + colors.yellow)}`);
  console.log(`  ${colorize('Source:', colors.gray)} ${varInfo.source}:${varInfo.line}`);
}

function printUsage(usage) {
  console.log(`    ${colorize('→', colors.green)} ${usage.file}:${usage.line}`);
  if (usage.context) {
    console.log(`      ${colorize(usage.context.substring(0, 70), colors.gray)}`);
  }
}

function printSummary(stats) {
  console.log('');
  console.log(colorize('━'.repeat(80), colors.cyan));
  console.log(colorize('  Summary', colors.bold + colors.cyan));
  console.log(colorize('━'.repeat(80), colors.cyan));
  console.log('');
  console.log(`  Total documented variables:    ${colorize(stats.total, colors.bold)}`);
  console.log(`  Variables with usage found:    ${colorize(stats.used, colors.green)}`);
  console.log(`  Variables allowlisted:         ${colorize(stats.allowlisted, colors.yellow)}`);
  console.log(`  Unreferenced variables:        ${colorize(stats.unreferenced, colors.red)}`);
  console.log('');
  
  if (stats.unreferenced > 0) {
    console.log(colorize('  ⚠ FAILED: Unreferenced configuration variables detected!', colors.bold + colors.red));
    console.log('');
    console.log(colorize('  Action Required:', colors.yellow));
    console.log('  1. Remove unused variables from .env.example files');
    console.log('  2. OR add them to .config-audit-ignore with a reason');
    console.log('');
  } else {
    console.log(colorize('  ✓ PASSED: All documented variables are accounted for!', colors.bold + colors.green));
    console.log('');
  }
}

// ============================================================================
// Main Logic
// ============================================================================

async function main() {
  printHeader();
  
  // Step 1: Extract documented variables
  printSection('Extracting Documented Configuration Variables');
  
  const documentedVars = [];
  
  for (const envFile of CONFIG.envExampleFiles) {
    if (fileExists(envFile)) {
      const content = readFile(envFile);
      const vars = extractFromEnvExample(content, envFile);
      documentedVars.push(...vars);
      console.log(`  ${colorize('✓', colors.green)} Found ${vars.length} variables in ${envFile}`);
    } else {
      console.log(`  ${colorize('○', colors.gray)} Skipped ${envFile} (not found)`);
    }
  }
  
  for (const docFile of CONFIG.docFiles) {
    if (fileExists(docFile)) {
      const content = readFile(docFile);
      const vars = extractFromDocs(content, docFile);
      documentedVars.push(...vars);
      console.log(`  ${colorize('✓', colors.green)} Found ${vars.length} variables in ${docFile}`);
    }
  }
  
  // Deduplicate variables
  const uniqueVars = new Map();
  for (const varInfo of documentedVars) {
    if (!uniqueVars.has(varInfo.name)) {
      uniqueVars.set(varInfo.name, varInfo);
    }
  }
  
  console.log('');
  console.log(`  Total unique variables: ${colorize(uniqueVars.size, colors.bold)}`);
  
  // Step 2: Scan codebase for files
  printSection('Scanning Codebase');
  
  let allFiles = [];
  for (const scanDir of CONFIG.scanDirs) {
    const files = getAllFiles(scanDir, CONFIG.scanExtensions, CONFIG.ignoreDirs);
    allFiles = allFiles.concat(files);
    console.log(`  ${colorize('✓', colors.green)} Scanned ${files.length} files in ${scanDir}`);
  }
  
  console.log('');
  console.log(`  Total files to scan: ${colorize(allFiles.length, colors.bold)}`);
  
  // Step 3: Load allowlist
  printSection('Loading Allowlist');
  
  const allowlist = loadAllowlist();
  console.log(`  ${colorize('✓', colors.green)} Loaded ${allowlist.size} allowlisted variables`);
  
  if (allowlist.size > 0) {
    for (const [varName, reason] of allowlist.entries()) {
      console.log(`    - ${colorize(varName, colors.yellow)}: ${reason || 'No reason provided'}`);
    }
  }
  
  // Step 4: Check usage
  printSection('Checking Variable Usage');
  
  const usedVars = [];
  const unusedVars = [];
  const allowlistedVars = [];
  
  for (const [varName, varInfo] of uniqueVars.entries()) {
    process.stdout.write(`  Checking ${varName}... `);
    
    if (allowlist.has(varName)) {
      console.log(colorize('ALLOWLISTED', colors.yellow));
      allowlistedVars.push({ ...varInfo, reason: allowlist.get(varName) });
      continue;
    }
    
    const usages = findVariableUsage(varName, allFiles);
    
    if (usages.length > 0) {
      console.log(colorize(`USED (${usages.length} references)`, colors.green));
      usedVars.push({ ...varInfo, usages });
    } else {
      console.log(colorize('UNREFERENCED', colors.red));
      unusedVars.push(varInfo);
    }
  }
  
  // Step 5: Detailed reporting
  if (unusedVars.length > 0) {
    printSection('Unreferenced Variables (Not Allowlisted)');
    
    for (const varInfo of unusedVars) {
      printVariable(varInfo);
      console.log('');
    }
    
    console.log(colorize('  These variables should be removed or added to .config-audit-ignore', colors.yellow));
  }
  
  if (process.env.VERBOSE === 'true') {
    printSection('Used Variables (Sample)');
    
    for (const varInfo of usedVars.slice(0, 5)) {
      printVariable(varInfo);
      console.log(colorize('  Usage:', colors.gray));
      for (const usage of varInfo.usages.slice(0, 3)) {
        printUsage(usage);
      }
      if (varInfo.usages.length > 3) {
        console.log(`    ${colorize(`... and ${varInfo.usages.length - 3} more`, colors.gray)}`);
      }
      console.log('');
    }
  }
  
  // Step 6: Summary and exit
  const stats = {
    total: uniqueVars.size,
    used: usedVars.length,
    allowlisted: allowlistedVars.length,
    unreferenced: unusedVars.length
  };
  
  printSummary(stats);
  
  // Exit with appropriate code
  if (unusedVars.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

main().catch(error => {
  console.error(colorize('Fatal Error:', colors.red), error.message);
  console.error(error.stack);
  process.exit(2);
});
