# Configuration Drift Detection

## Overview

The Configuration Drift Detection tool automatically identifies environment variables and configuration keys that are documented in `.env.example` files or documentation but are no longer used anywhere in the application codebase.

This prevents configuration bloat, reduces confusion for new developers, and ensures that documentation stays synchronized with actual code usage.

---

## Table of Contents

1. [Why This Matters](#why-this-matters)
2. [How It Works](#how-it-works)
3. [Usage](#usage)
4. [Configuration](#configuration)
5. [Allowlist Management](#allowlist-management)
6. [CI/CD Integration](#cicd-integration)
7. [Examples](#examples)
8. [Troubleshooting](#troubleshooting)

---

## Why This Matters

### Problems Solved

1. **Dead Configuration**: Over time, refactoring leaves obsolete variables in `.env.example` files
2. **Developer Confusion**: New team members waste time configuring variables that aren't actually used
3. **Documentation Drift**: Config docs become outdated and misleading
4. **CI/CD Bloat**: Unnecessary secrets and variables in deployment pipelines
5. **Security Risk**: Orphaned credentials that should have been removed

### Real-World Example

```bash
# .env.example contains:
LEGACY_API_KEY=xxx
OLD_DATABASE_URL=xxx
DEPRECATED_FEATURE_FLAG=xxx

# But code has been refactored and these are never referenced
# Result: Developers set these up for nothing
```

---

## How It Works

### Step 1: Extract Documented Variables

The tool scans configuration documentation sources:

- **`.env.example` files**: Extracts all `VAR_NAME=value` patterns
- **Markdown documentation**: Finds variables in code blocks, tables, and inline code
- **Configuration schemas**: Parses config validation files

### Step 2: Scan Codebase for Usage

The tool searches for variable references across multiple languages and patterns:

#### JavaScript/TypeScript
```typescript
process.env.VAR_NAME
process.env['VAR_NAME']
import.meta.env.VAR_NAME
const { VAR_NAME } = process.env
```

#### Rust
```rust
env::var("VAR_NAME")
std::env::var("VAR_NAME")
```

#### Python
```python
os.environ["VAR_NAME"]
os.getenv("VAR_NAME")
```

#### Configuration Files
```yaml
database_url: ${DATABASE_URL}
api_key: $API_KEY
```

### Step 3: Report Unreferenced Variables

Variables with **zero code references** and **not in allowlist** are flagged as drift.

---

## Usage

### Local Development

```bash
# Using npm
npm run lint:config

# Using make
make lint-config

# With verbose output (shows usage examples)
npm run lint:config:verbose
make lint-config-verbose

# Direct execution
node scripts/check-unused-config.mjs
```

### Exit Codes

- **0**: All documented variables are used or allowlisted ✅
- **1**: Unreferenced variables detected ❌
- **2**: Fatal error (e.g., script failure)

---

## Configuration

The tool is configured in `scripts/check-unused-config.mjs`:

```javascript
const CONFIG = {
  // Directories to scan for usage
  scanDirs: [
    'listener/src',
    'dashboard/src',
    'contract/contracts',
    'Documents/Task Bounty/src'
  ],
  
  // File extensions to check
  scanExtensions: ['.ts', '.tsx', '.js', '.jsx', '.rs', '.toml'],
  
  // Documentation sources
  envExampleFiles: [
    'listener/.env.example',
    'Documents/Task Bounty/.env.example',
    'dashboard/.env.example'
  ],
  
  // Ignore patterns
  ignoreDirs: [
    'node_modules',
    'dist',
    'build',
    'target',
    '.git'
  ]
};
```

### Customization

To add new scan locations, edit `CONFIG.scanDirs` in the script.

---

## Allowlist Management

### When to Allowlist

Allowlist variables that are:

1. **Runtime-only**: Used by Docker, deployment platforms, or shell scripts
2. **External dependencies**: Consumed by frameworks or libraries
3. **Build-time only**: Used during build process but not in source code
4. **Infrastructure**: Used by monitoring, logging, or deployment tools

### Allowlist Format

Edit `.config-audit-ignore`:

```
# Reason for exemption
VARIABLE_NAME

# Another variable with a reason
ANOTHER_VAR

# Example: Used by Docker Compose at container runtime
DATABASE_URL

# Example: Vite build-time variable prefix
VITE_APP_TITLE
```

### Best Practices

1. **Always document why**: Every allowlisted variable needs a comment
2. **Be specific**: Explain exactly where and how it's used
3. **Review regularly**: Periodically audit the allowlist
4. **Prefer code usage**: If possible, reference the variable in code instead

### Example Allowlist

```
# Used by Docker Compose service configuration
DATABASE_URL

# Consumed by Next.js at build time
NEXT_PUBLIC_API_URL

# Used by GitHub Actions workflow
CI_DEPLOY_KEY

# Winston logger reads this at runtime initialization
LOG_LEVEL

# Node.js built-in environment detection
NODE_ENV
```

---

## CI/CD Integration

### GitHub Actions

Add to `.github/workflows/config-lint.yml`:

```yaml
name: Configuration Lint

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  config-drift:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Check for unused configuration variables
        run: npm run lint:config
        
      - name: Comment on PR if failed
        if: failure() && github.event_name == 'pull_request'
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '⚠️ Configuration drift detected! Please review unused variables.'
            })
```

### GitLab CI

Add to `.gitlab-ci.yml`:

```yaml
config-lint:
  stage: test
  image: node:18
  script:
    - npm run lint:config
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'
```

### Pre-commit Hook

Add to `.husky/pre-commit` or `.git/hooks/pre-commit`:

```bash
#!/bin/sh
echo "Checking for configuration drift..."
npm run lint:config || {
  echo "❌ Configuration drift detected. Fix before committing."
  exit 1
}
```

---

## Examples

### Example 1: Clean Run

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Configuration Drift Detection Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▶ Extracting Documented Configuration Variables
────────────────────────────────────────────────────────────────────────────────
  ✓ Found 8 variables in listener/.env.example
  ✓ Found 0 variables in dashboard/.env.example

  Total unique variables: 8

▶ Scanning Codebase
────────────────────────────────────────────────────────────────────────────────
  ✓ Scanned 45 files in listener/src
  ✓ Scanned 23 files in dashboard/src

  Total files to scan: 68

▶ Checking Variable Usage
────────────────────────────────────────────────────────────────────────────────
  Checking STELLAR_NETWORK... USED (2 references)
  Checking STELLAR_RPC_URL... USED (2 references)
  Checking CONTRACT_ADDRESSES... USED (3 references)
  Checking POLL_INTERVAL_MS... USED (1 references)
  ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Total documented variables:    8
  Variables with usage found:    8
  Variables allowlisted:         0
  Unreferenced variables:        0

  ✓ PASSED: All documented variables are accounted for!
```

### Example 2: Drift Detected

```
▶ Checking Variable Usage
────────────────────────────────────────────────────────────────────────────────
  Checking STELLAR_NETWORK... USED (2 references)
  Checking LEGACY_API_KEY... UNREFERENCED
  Checking OLD_DATABASE_URL... UNREFERENCED

▶ Unreferenced Variables (Not Allowlisted)
────────────────────────────────────────────────────────────────────────────────
  LEGACY_API_KEY
  Source: listener/.env.example:15

  OLD_DATABASE_URL
  Source: listener/.env.example:18

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Total documented variables:    10
  Variables with usage found:    8
  Variables allowlisted:         0
  Unreferenced variables:        2

  ⚠ FAILED: Unreferenced configuration variables detected!

  Action Required:
  1. Remove unused variables from .env.example files
  2. OR add them to .config-audit-ignore with a reason
```

### Example 3: With Allowlist

```
▶ Loading Allowlist
────────────────────────────────────────────────────────────────────────────────
  ✓ Loaded 2 allowlisted variables
    - NODE_ENV: Used by runtime detection
    - LOG_LEVEL: Used by Winston logger configuration

▶ Checking Variable Usage
────────────────────────────────────────────────────────────────────────────────
  Checking NODE_ENV... ALLOWLISTED
  Checking LOG_LEVEL... ALLOWLISTED
  Checking STELLAR_NETWORK... USED (2 references)
```

---

## Troubleshooting

### False Positives

**Problem**: Variable is used but tool reports it as unreferenced.

**Solutions**:

1. **Check pattern matching**: Ensure the variable is accessed in a supported pattern
2. **Add to allowlist**: If it's consumed externally (Docker, etc.)
3. **Verify scan directories**: Make sure the file containing the usage is scanned
4. **Check string matching**: Variable names are case-sensitive

### Variable Not Detected in .env.example

**Problem**: Tool doesn't extract a variable from `.env.example`.

**Solution**: Ensure the format is:

```bash
# Good
VAR_NAME=value

# Bad (will be missed)
var_name=value      # lowercase not detected
# VAR_NAME=value    # commented out, not extracted
VAR NAME=value      # space in name, not valid
```

### Tool Crashes or Errors

**Problem**: Script fails with an error.

**Solutions**:

1. **Check Node.js version**: Requires Node.js 14+ with ES modules support
2. **Verify file paths**: Ensure all paths in CONFIG are correct
3. **Check permissions**: Ensure read access to all scanned directories
4. **Review error stack**: Look for specific file or pattern causing issues

### Performance Issues

**Problem**: Tool is slow on large codebases.

**Solutions**:

1. **Limit scan directories**: Only include source directories, not build outputs
2. **Add to ignoreDirs**: Exclude `node_modules`, `dist`, `build`, `target`
3. **Reduce scan extensions**: Only include necessary file types
4. **Run in parallel**: Use `--parallel` flag if available

---

## Advanced Usage

### Custom Patterns

To detect custom variable access patterns, edit the `findVariableUsage` function:

```javascript
// Add your custom pattern
const customPattern = new RegExp(`myFramework\\.config\\(['"]${varName}['"]\\)`, 'g');
patterns.push(customPattern);
```

### Multiple Allowlists

For projects with multiple services, create service-specific allowlists:

```
.config-audit-ignore             # Root allowlist
listener/.config-audit-ignore    # Listener-specific
dashboard/.config-audit-ignore   # Dashboard-specific
```

Then modify the script to load all of them.

### Integration with Linters

Add to `package.json`:

```json
{
  "scripts": {
    "lint": "npm run lint:eslint && npm run lint:config",
    "lint:eslint": "eslint .",
    "lint:config": "node scripts/check-unused-config.mjs"
  }
}
```

---

## Best Practices

### 1. Run Before Committing

Add to pre-commit hook to catch drift early:

```bash
npm run lint:config
```

### 2. Regular Audits

Schedule periodic reviews:

- Weekly: Check new variables added
- Monthly: Review allowlist for obsolete entries
- Quarterly: Full audit of all configuration

### 3. Document New Variables

When adding environment variables:

1. Add to `.env.example` with clear comments
2. Document in README or config docs
3. Ensure code references the variable
4. Run `npm run lint:config` to verify

### 4. Remove Before Refactoring

When removing features:

1. Delete the code
2. Remove from `.env.example`
3. Remove from documentation
4. Run `npm run lint:config` to confirm

### 5. CI/CD Enforcement

Make the check mandatory in CI:

```yaml
- name: Config Lint
  run: npm run lint:config
  # Fail the build if unreferenced variables exist
```

---

## Testing

### Manual Test

Test the tool with a mock unused variable:

```bash
# Add a test variable
echo "MOCK_UNUSED_VARIABLE=test" >> listener/.env.example

# Run the check (should fail)
npm run lint:config

# Clean up
grep -v "MOCK_UNUSED_VARIABLE" listener/.env.example > listener/.env.example.tmp
mv listener/.env.example.tmp listener/.env.example
```

### Automated Test

Use the built-in test command:

```bash
make test-lint-config
```

This will:
1. Add a mock unused variable
2. Run the checker (expecting failure)
3. Clean up the test variable
4. Report results

---

## Contributing

To improve the configuration drift detection tool:

1. Fork the repository
2. Create a feature branch
3. Modify `scripts/check-unused-config.mjs`
4. Test your changes
5. Submit a pull request

### Adding New Patterns

To support additional languages or frameworks:

1. Add pattern to `findVariableUsage()` function
2. Test with sample code
3. Document in this guide
4. Update examples

---

## Support

If you encounter issues:

1. Check this documentation
2. Review examples above
3. Check GitHub issues
4. Open a new issue with details

---

## License

MIT License - See LICENSE file for details
