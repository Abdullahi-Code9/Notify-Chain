# Dependency License Policy

Notify-Chain enforces automated dependency license compliance to verify that third-party code redistributed or bundled with the project complies with open-source licensing standards.

## Classification

The source of truth for license compliance is [`license-policy.json`](../license-policy.json) (for Node.js workspaces) and [`contract/deny.toml`](../contract/deny.toml) (for Rust contracts).

### 1. Approved Licenses (Permissive)
Dependencies bearing permissive licenses are permitted for use and redistribution:
- **SPDX Identifiers**: `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `CC0-1.0`, `CC-BY-3.0`, `CC-BY-4.0`, `0BSD`, `Unlicense`, `Python-2.0`, `BlueOak-1.0.0`
- **Rust specifics**: `Unicode-DFS-2016`, `Apache-2.0 WITH LLVM-exception`

### 2. Restricted Licenses (Copyleft)
Strong copyleft licenses are disallowed in production builds because they impose viral licensing obligations or commercial restrictions:
- **Disallowed**: `GPL-2.0`, `GPL-3.0`, `LGPL-2.0`, `LGPL-2.1`, `LGPL-3.0`, `AGPL-3.0`, `SSPL-1.0`, `BUSL-1.1`

### 3. Review-Required Licenses
Weak copyleft or non-standard license statements requiring legal or architectural sign-off before distribution:
- **SPDX Identifiers**: `MPL-2.0`, `CDDL-1.0`, `EPL-1.0`, `EPL-2.0`
- **File references**: Packages using `SEE LICENSE IN <FILE>` (e.g., dual-licensed WalletConnect libraries) are flagged for manual verification.

### 4. Documented Exceptions
Pre-existing transitive dependencies inherited from third-party SDKs (such as wallet adapters) are cataloged under the `exceptions` block of `license-policy.json`. Each exception must document:
- The package and version
- The license
- The justification / usage scope (e.g. browser-only optional adapter, dynamic linking)
- The upstream dependency introducing it

## Running Checks Locally

To inspect dependency licenses across all Node workspaces:

```bash
node scripts/check-licenses.js listener dashboard frontend
```

To run checks for Rust contracts:

```bash
cargo deny check licenses --config contract/deny.toml
```

## CI Integration

The automated license workflow is defined in [`.github/workflows/license-check.yml`](../.github/workflows/license-check.yml):
- Runs automatically on pull requests and pushes to `main` and `staging`.
- Runs on a weekly schedule to detect retroactive license changes or security advisories.
- Emits an actionable exit code: any unapproved or restricted dependency fails the build with the exact package and license identified.
