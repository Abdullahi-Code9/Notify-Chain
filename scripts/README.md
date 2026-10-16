# Scripts Directory

This directory contains automation scripts and developer tools for the NotifyChain project.

---

## Available Scripts

### Configuration Drift Detection

**Script:** `check-unused-config.mjs`

**Purpose:** Automatically identifies environment variables documented in `.env.example` files that are no longer referenced in the application codebase.

**Usage:**

```bash
# Run the check
npm run lint:config

# Run with verbose output
npm run lint:config:verbose

# Direct execution
node scripts/check-unused-config.mjs

# Using Make
make lint-config
make lint-config-verbose
```

**Exit Codes:**
- `0` - All documented variables are accounted for or allowlisted ✅
- `1` - Unreferenced variables detected ❌
- `2` - Fatal error (script failure) ⚠️

**Documentation:** See [CONFIG_DRIFT_DETECTION.md](../docs/CONFIG_DRIFT_DETECTION.md)

---

## Quick Reference

### Check Configuration

```bash
npm run lint:config
```

### Test with Mock Variable

```bash
# Add a test unused variable
echo "MOCK_TEST=value" >> listener/.env.example

# Run check (should fail)
npm run lint:config

# Clean up
# Remove the line manually or use sed/grep
```

### Add to Allowlist

```bash
# Edit .config-audit-ignore
echo "# Reason: Used by deployment script" >> .config-audit-ignore
echo "DEPLOY_KEY" >> .config-audit-ignore
```

---

## Integration

### Pre-commit Hook

Add to `.husky/pre-commit`:

```bash
npm run lint:config
```

### CI/CD

GitHub Actions workflow is already configured in `.github/workflows/config-lint.yml`.

---

## Troubleshooting

### Variable Not Detected

Ensure the variable follows this pattern in `.env.example`:

```bash
VARIABLE_NAME=value
```

### False Positive

Add to `.config-audit-ignore` with a reason:

```
# Used by Docker Compose
DOCKER_VAR
```

### Script Fails

- Check Node.js version (requires 14+)
- Verify file paths in script CONFIG section
- Ensure read permissions on all directories

---

## Contributing

When adding new scripts:

1. Place in `scripts/` directory
2. Make executable: `chmod +x scripts/script-name.sh`
3. Add to this README
4. Add to `package.json` scripts section
5. Document usage and purpose

---

## Script Maintenance

### Check for Updates

```bash
# Review script dependencies
node --version  # Should be 14+

# Check for syntax errors
node --check scripts/check-unused-config.mjs
```

### Performance

- Scripts should complete in <10 seconds on typical repos
- Use `ignoreDirs` to skip unnecessary directories
- Limit `scanExtensions` to relevant file types

---

## Support

For issues or questions:

1. Check documentation in `docs/`
2. Review examples in this README
3. Open an issue on GitHub

---

## License

MIT License - See LICENSE file for details
