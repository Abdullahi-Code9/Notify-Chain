# Security Policy and Dependency Vulnerability Management

> **Audience**: maintainers, contributors, and security reviewers.
>
> This document defines the automated security scanning infrastructure for the
> NotifyChain repository, the severity policy applied in CI, and the step-by-step
> remediation playbook a contributor should follow when the pipeline flags a
> finding.

---

## Table of Contents

1. [Overview](#overview)
2. [Tooling Matrix](#tooling-matrix)
3. [CI Severity Policy Rules](#ci-severity-policy-rules)
4. [Running Scans Locally](#running-scans-locally)
5. [Remediation Playbook](#remediation-playbook)
6. [Suppressing False Positives](#suppressing-false-positives)
7. [Reporting a Vulnerability](#reporting-a-vulnerability)
8. [Contacts and Escalation](#contacts-and-escalation)

---

## Overview

NotifyChain consists of four main components, each of which has automated
vulnerability coverage:

| Component | Location | Language / Ecosystem | Scan Tool |
|-----------|----------|----------------------|-----------|
| Smart contracts | `contract/` | Rust (Soroban / wasm32) | `cargo audit` |
| Listener service | `listener/` | TypeScript / Node.js 22 | `npm audit` |
| Dashboard UI | `dashboard/` | TypeScript / React / Vite | `npm audit` |
| Legacy frontend | `frontend/` | TypeScript / React / Next | `npm audit` |

All four scans run on every push to `main`/`master` and every pull request via
the `.github/workflows/ci.yml` workflow. They also run as part of release
candidate validation before tags are cut.

---

## Tooling Matrix

### 1. `cargo audit` (Rust / Smart Contracts)

- **Package**: [`cargo-audit`](https://github.com/RustSec/cargo-audit)
- **Advisory database**: [RustSec Advisory DB](https://rustsec.org/)
- **Input files**: `contract/Cargo.lock` (+ `Cargo.toml` manifests)
- **CI job**: `vulnerability-scan` matrix → `kind: rust`
- **Installed locally**:
  ```bash
  cargo install cargo-audit --locked
  ```

#### What it checks
- Known security vulnerabilities in Rust crates pulled from crates.io.
- Unmaintained (end-of-life) crates.
- Yanked crate versions.
- Crates that the RustSec database has flagged with soundness / unsoundness
  warnings.

#### Runs in CI with two configurations

| CI step | Flags | Effect |
|---------|-------|--------|
| Informational pass | `cargo audit` (no flags) | Prints every finding at every severity. **Never** fails the build. |
| Blocking pass        | `cargo audit --deny warnings` | Fails the build for `warning` level (maps to High / Critical advisories). Low / informational findings pass. |

---

### 2. `npm audit` (TypeScript / Node components)

- **Built into**: `npm` (ships with every supported Node.js release)
- **Advisory database**: GitHub Advisory Database (used by `npm`)
- **Input files**: `package-lock.json` + `package.json` per component
- **CI job**: `vulnerability-scan` matrix → `kind: node`

#### What it checks
- Known vulnerabilities in transitive JS/TS dependency trees (prod + dev).
- Malware / compromised packages flagged in the advisory database.
- Prototype pollution, RCE, XSS, SQL injection, etc. from npm.

#### Runs in CI with two configurations

| CI step | Flags | Effect |
|---------|-------|--------|
| Informational pass | `npm audit` (writes JSON report) | Prints every finding at every severity. **Never** fails the build. |
| Blocking pass        | `npm audit --audit-level=high` | Fails the build only when **high** or **critical** severity vulns are present. `low` / `moderate` are informational only. |

---

## CI Severity Policy Rules

These rules are the single source of truth for what blocks a PR or main-branch
build. They are intentionally conservative: err on the side of blocking on
high-impact findings while allowing routine informational maintenance to happen
on contributor schedules.

| Finding / Severity | Blocking in CI? | Notes |
|--------------------|-----------------|-------|
| `cargo audit` **Critical** advisory      | ✅ Yes via `--deny warnings` | Fix before merge. |
| `cargo audit` **High** advisory          | ✅ Yes via `--deny warnings` | Fix before merge. |
| `cargo audit` **Medium / Low** advisory  | ❌ No (informational)        | Track as tech debt; fix in next maintenance window. |
| `cargo audit` Unmaintained crate         | ❌ No (informational unless paired with a known CVE) | File a follow-up issue to migrate away. |
| `npm audit` **Critical**                 | ✅ Yes via `--audit-level=high` | Fix before merge. |
| `npm audit` **High**                     | ✅ Yes via `--audit-level=high` | Fix before merge. |
| `npm audit` **Moderate (Medium)**        | ❌ No (informational)        | Track as tech debt. |
| `npm audit` **Low**                      | ❌ No (informational)        | Track as tech debt. |
| Lockfile drift (see below)               | ✅ Yes                        | `git status --porcelain` must be clean after `npm ci` / `cargo build --locked`. |

> **Rationale**: High and Critical findings are, by definition, remotely
> exploitable in realistic configurations. Anything lower is typically
> dependency-graph noise (devDependencies with no production execution path,
> prototype pollution that requires a code path we do not exercise, etc.) and
> is handled during the weekly maintenance rotation rather than the PR hot
> path.

---

## Running Scans Locally

Contributors should run these before pushing a branch that modifies
`Cargo.toml`, `Cargo.lock`, `package.json`, or `package-lock.json`.

### Rust (smart contracts)

```bash
cd contract
cargo audit                     # full report, all severities
cargo audit --deny warnings     # replicate CI's blocking pass
```

Fix missing tool:

```bash
cargo install cargo-audit --locked
```

### Node (listener, dashboard, frontend)

```bash
cd listener          # or dashboard/, or frontend/
npm audit            # full report, all severities
npm audit --audit-level=high  # replicate CI's blocking pass
```

To see JSON output with every affected transitive dependency path:

```bash
npm audit --json | jq '.'
```

---

## Remediation Playbook

Use the decision tree below when CI fails with a vulnerability.

### Step 1 — Understand the finding

1. Open the failing CI run and navigate to the *blocking* step (the one that
   exited non-zero):
   - Rust: `Rust: cargo audit (blocking: deny warnings = High/Critical)`
   - Node: `Node: npm audit (blocking: audit-level = high)`
2. Read the advisory ID (e.g. `RUSTSEC-2024-00xx`, `GHSA-xxxx-xxxx-xxxx`)
   and open it in your browser:
   - RustSec: <https://rustsec.org/advisories/>
   - GitHub Advisory: <https://github.com/advisories/>

### Step 2 — Determine affected path

**For Rust:**

```bash
cd contract
cargo audit --message-format=json 2>/dev/null | jq '.vulnerabilities.list[] | {package, advisory, versions}'
```

Follow the dependency chain from the vulnerable crate back to NotifyChain's
direct `Cargo.toml` dependency.

**For Node:**

```bash
cd listener   # or dashboard/, frontend/
npm ls <vulnerable-package-name>
```

This prints the full `direct-dep → intermediate → vulnerable` chain.

### Step 3 — Pick remediation strategy

| Strategy | When to use | Action |
|----------|-------------|--------|
| **Upgrade direct dep** | Vuln in a direct dep we control and the latest fixed version is API-compatible. | Bump in `package.json` / `Cargo.toml`; run `npm install` / `cargo build` locally; commit the updated lockfile. |
| **Upgrade transitive via lockfile resolution** | Vuln is deep in a tree and a newer patch version exists. | `npm update <vulnerable-package-name>` (Node) or `cargo update -p <crate-name>` (Rust). Re-run scan to confirm it is gone. |
| **NPM overrides / Cargo patches** | Fixed version is incompatible with pinned semver constraints upstream. | Node: add an `overrides` block to `package.json`.<br/>Rust: add a `[patch.crates-io]` section to `contract/Cargo.toml` temporarily. |
| **Remove or replace the dependency** | The vulnerable dep is dev-only, unused, or has a well-maintained fork. | Swap it out in the manifest; remove from `import`s / `use`s; re-run tests. |
| **False positive / does not apply to us** | Advisory requires a code path we do not ship (e.g. a dev server at runtime, or we call the crate in a provably safe way). | Follow the [Suppressing False Positives](#suppressing-false-positives) process. Do **not** silently merge. |

### Step 4 — Verify locally and push

1. Confirm the blocking scan **passes** on your machine.
2. Run the full test suite for the affected component.
3. Commit the manifest and lockfile changes together (never commit a changed
   `package.json` without a matching `package-lock.json`, nor a `Cargo.toml`
   without a matching `Cargo.lock`).
4. Open or update your PR. CI should now green-light the vulnerability step.

---

## Suppressing False Positives

Occasionally an advisory flags a pattern that does **not** apply to how
NotifyChain uses a dependency. In that case, file a **rationale PR** rather
than silently merging.

### Rust — `cargo audit`

Use an `audit.toml` ignore file at `contract/audit.toml`:

```toml
[advisories]
# Example: replace with real advisory id and your justification.
ignore = [
    "RUSTSEC-202X-0000",  # Advisory targets <feature X>, which we do not compile:
                           # see <link to comment / code proof>.
                           # Suppression review due by YYYY-MM-DD.
]
```

### Node — `npm audit`

Use the registry-level `.npmrc` or an explicit ignore list per component.
Because `npm audit` does not have a built-in advisory-ignore file, document
suppressions in this section alongside the advisory ID:

| Advisory ID | Component | Date added | Justification link | Expires (review by) |
|-------------|-----------|------------|--------------------|---------------------|
| *example*   | listener  | 2025-01-01 | PR #xxx, commit xxxxxxx | 2025-04-01 |

Expired suppressions must be re-evaluated by the reviewer listed in
[Contacts and Escalation](#contacts-and-escalation) or the PR will be rejected.

---

## Reporting a Vulnerability

For security issues that are **not** covered by the automated scans —
on-chain logic bugs, auth bypasses, disclosure of PII through the listener
API, etc. — please **do not open a public GitHub issue**.

Instead follow responsible disclosure:

1. Email `security@notifychain.example` (or the repository maintainers listed
   on GitHub) with:
   - A one-line summary in the subject line,
   - A reproduction case (preferably a failing test or a step-by-step script),
   - Affected versions (or commit hash).
2. Expect acknowledgement within 3 business days.
3. A maintainer will open a private security advisory on GitHub and invite you
   to collaborate on a fix before any public disclosure.

We follow a 90-day disclosure window, aligned with the industry standard.

---

## Contacts and Escalation

| Role | Scope | How to reach |
|------|-------|--------------|
| Security triage on-call | All findings escalated from CI | GitHub security advisory assignees |
| Rust / contract owner  | `contract/` vulnerability remediation | Maintainers listed in `contract/Cargo.toml` author fields |
| Node / JS owner        | `listener/`, `dashboard/`, `frontend/` vuln remediation | Component `package.json` authors field |
| Vulnerability suppression reviewer | Signs off on new entries in the ignore tables | Security triage on-call + a second maintainer (two-person rule) |

---

## Reference Links

- CI workflow definition: [`.github/workflows/ci.yml`](file:///c:/Users/USA/Documents/Osuocha/Notify-Chain/.github/workflows/ci.yml)
- Reproducible install / lockfile drift check job: `dependency-integrity` (same workflow file)
- Vulnerability scan job: `vulnerability-scan` (same workflow file)
- RustSec Advisory DB: <https://rustsec.org/>
- GitHub Advisory Database (npm): <https://github.com/advisories>
- Contributing guide: [CONTRIBUTING.md](file:///c:/Users/USA/Documents/Osuocha/Notify-Chain/CONTRIBUTING.md)
