# Contributor Development Workflow Guide

A single, end-to-end workflow for local setup, branching, testing, and submitting a Pull Request.

> This guide is the canonical “start here” for contributors working on NotifyChain.

---

## 0) Before you start (issue + scope)

1. Browse open issues and pick one that matches your interests.
2. If the issue has an assigned owner, wait until a maintainer assigns you.
3. Do not open a PR for work that hasn’t been claimed/assigned.

---

## 1) Local setup (verified)

### 1.1 Prerequisites

- Rust (stable) with WebAssembly target:
  - `rustup target add wasm32-unknown-unknown`
- Stellar CLI:
  - `cargo install --locked stellar-cli --features opt`
- Node.js:
  - Listener uses **Node 20**
  - Dashboard uses **Node 18**

> On Windows, you may need Visual Studio Build Tools with the “C++ build tools” workload for `sqlite3`.

### 1.2 Clone + keep fork in sync

- Fork the repo, then clone your fork.
- Add the upstream remote.
- Sync before starting new work:

```bash
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

### 1.3 Set up the Listener

```bash
cd listener
npm install
cp .env.example .env
```

Update `listener/.env` with at minimum:

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]
```

Initialize the database:

```bash
npm run migrate
```

Run locally:

```bash
npm run dev
```

Verify:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/events
```

### 1.4 Set up the Dashboard

```bash
cd dashboard
npm install
cp .env.example .env
```

Ensure `dashboard/.env` points at your listener:

- `VITE_EVENTS_API_URL=http://localhost:8787/api/events`

Run:

```bash
npm run dev
```

Open: http://localhost:5173

### 1.5 Smart contracts (only if you change/deploy contracts)

Build AutoShare (contract workspace):

```bash
cd contract
stellar contract build
```

Run AutoShare contract tests:

```bash
cd contract/contracts/hello-world
cargo test
```

Run TaskBounty contract tests (path includes space):

```bash
cd Documents/Task\ Bounty
cargo test
```

---

## 2) Branch workflow

1. Always branch from an up-to-date `main`:

```bash
git checkout main
git pull upstream main
git checkout -b <branch-name>
```

2. Use descriptive branch names:

- `feature/` for new features
- `fix/` for bug fixes
- `docs/` for documentation
- `refactor/` for refactoring
- `test/` for tests
- `chore/` for maintenance

Examples:
- `feature/add-slack-notifications`
- `fix/resolve-event-deduplication-bug`
- `docs/update-contributing-guide`

---

## 3) Implement + keep changes focused

- Follow existing code style in each component directory (`listener/`, `dashboard/`, `contract/`).
- Add/update documentation when behavior changes.
- Add tests for any new logic or bug fix.

---

## 4) Testing requirements (do this before pushing)

### 4.1 Contracts (Rust)

AutoShare:

```bash
cd contract/contracts/hello-world
cargo test
```

TaskBounty:

```bash
cd Documents/Task\ Bounty
cargo test
```

Also ensure formatting is clean before PR:

```bash
cargo fmt --all
```

### 4.1.1 Documentation Link Check (all markdown files)

Before pushing documentation changes, verify that internal repository-relative links are not broken. External HTTP/HTTPS links are checked separately in CI and treated as warnings only (temporary external downtime will not fail the pipeline).

From the **repository root**:

```bash
# Install root dev dependencies (if you haven't already)
npm install

# Check internal links strictly (fails on broken internal/relative links)
npm run check:links

# Quiet mode (suppresses per-file progress, shows only failures)
npm run check:links:quiet
```

The `check:links` script scans every `.md` file in the repository. Broken **internal** or **repository-relative** links (e.g. `[guide](./docs/README.md)`, `[adr](/docs/adr/0001-...)`) will cause the command to exit non-zero and must be fixed. External `http://` / `https://` links are excluded from strict checks to avoid CI fragility from transient outages; they are audited separately on a best-effort basis via the `check-external-links` CI job.

See [`.github/workflows/docs-link-check.yml`](.github/workflows/docs-link-check.yml) for the full CI pipeline and [`.markdown-link-check.json`](.markdown-link-check.json) for the checker configuration.

### 4.2 Listener (TypeScript)

From repo root:

```bash
cd listener
npm test
```

Recommended (especially before PR):

```bash
npm run typecheck
npm run lint
```

### 4.3 Dashboard (TypeScript)

```bash
cd dashboard
npm test
npm run lint
npm run build
```

### 4.4 CI expectations (what maintainers will see)

GitHub Actions typically validates:

- Listener: `npm run typecheck`, `npm test`
- Dashboard: `npm run lint`, `npm run build`, `npm test`
- Contracts: `cargo fmt -- --check`, `cargo test --workspace --all-features --verbose`

---

## 5) Commit + push

Use clear, conventional commit messages:

- `feat:`
- `fix:`
- `docs:`
- `test:`
- `refactor:`
- `chore:`

Example:

```bash
git commit -m "fix: resolve event parsing issue in listener"
git commit -m "test: add retry-scheduler unit coverage"
git push -u origin <branch-name>
```

---

## 6) Pull Request submission guidelines

### 6.1 PR title

Match your commit-style convention, e.g.:
- `feat: add retry queue for notifications`
- `fix: standardize error messages across contracts`

### 6.2 PR description checklist (minimum)

Include:
1. **Overview**: What does this PR change?
2. **Related Issue**: Link(s) to the GitHub issue(s).
3. **Changes**: What files/areas were modified.
4. **Verification Results**: Exact tests/commands you ran.
5. **How to Test**: Any manual steps beyond unit tests.

### 6.3 PR checklist (before you submit)

- [ ] Branch is up to date with `main`
- [ ] Tests added/updated and passing
- [ ] Local tests completed (listener/dashboard/contracts as applicable)
- [ ] Lint/format expectations satisfied
- [ ] Documentation updated if behavior changes

### 6.4 Keeping review smooth

- Keep PR scope focused on the assigned issue.
- Address reviewer feedback promptly.
- Avoid mixing unrelated refactors with functional changes.

---

## 7) What to expect after opening a PR

- CI runs automatically.
- Maintainers review code and tests.
- You may be asked for additional verification or fixes before merge.

---

## Quick reference (copy/paste)

```bash
# Listener
cd listener
npm install
npm run migrate
npm run typecheck
npm test

# Dashboard
cd dashboard
npm install
npm run lint
npm run build
npm test

# Contracts
cd contract/contracts/hello-world
cargo test
```

