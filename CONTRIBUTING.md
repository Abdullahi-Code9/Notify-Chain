# Contributing to NotifyChain

Welcome, and thanks for your interest in contributing. This document is your starting point — it covers the contribution workflow, coding standards, and PR guidelines. Deeper references are linked throughout.

**Start here instead (recommended):**

- Environment setup (tools, clone, verify): [`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md)
- Development workflow (fork, branch, PR): [`CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md`](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md)
---

## Documentation Map

| Document | Purpose |
|---|---|
| **This file** | Workflow, standards, PR guidelines |
| [`CONTRIBUTOR_SETUP.md`](CONTRIBUTOR_SETUP.md) | Full local environment setup from scratch |
| [`CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md`](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md) | End-to-end workflow reference |
| [`CONTRIBUTOR_ARCHITECTURE_DEEP_DIVE.md`](CONTRIBUTOR_ARCHITECTURE_DEEP_DIVE.md) | System architecture and component internals |
| [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md) | High-level architecture walkthrough |

---

**Companion guides:**
- [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) — the full branching strategy, commit conventions, and PR process, with a command cheat sheet
- [`docs/CONTRIBUTOR_TROUBLESHOOTING.md`](docs/CONTRIBUTOR_TROUBLESHOOTING.md) — solutions for common build, test, database, and Git problems
- [`docs/API_ERROR_REFERENCE.md`](docs/API_ERROR_REFERENCE.md) — every error response the listener API returns
- [`docs/adr/README.md`](docs/adr/README.md) — Architecture Decision Records

## Documentation conventions

Use these names consistently in docs and PRs:

| Concept | Standard form |
|---------|----------------|
| Product name (prose/titles) | **NotifyChain** |
| GitHub repository / clone directory | **Notify-Chain** (`Core-Foundry/Notify-Chain`) |
| Off-chain service | **Listener** (`listener/`) |
| React + Vite UI | **Dashboard** (`dashboard/`) |
| Legacy analytics app | **Frontend** (`frontend/`) |
| On-chain code | **Smart contracts** (`contract/`, `Documents/Task Bounty/`) |

Canonical setup path: workflow guide → [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md) (quick) → [`CONTRIBUTOR_SETUP.md`](CONTRIBUTOR_SETUP.md) (detailed).

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community
- Show empathy towards other contributors

## Getting Started

### Prerequisites & Environment Doctor

Run the automated repository health check to verify your local toolchain before starting:

```bash
./scripts/doctor.sh
```

To contribute to NotifyChain, install the tools listed in
[`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md) (Rust, WebAssembly
target, Stellar CLI, Node.js 22, Git). The guide includes verification steps
to confirm your machine is ready.

You should also have a basic understanding of Soroban smart contracts, Git, and GitHub.

### Setup (Fork Workflow)

To set up a local development environment, follow this fork-and-clone workflow:

1. **Fork the Repository**: Visit [Notify-Chain](https://github.com/Core-Foundry/Notify-Chain) and click the **Fork** button to create a copy of the repository under your GitHub account.
2. **Clone your Fork**:
   ```bash
   git clone https://github.com/your-username/Notify-Chain.git
   cd Notify-Chain
   ```
3. **Configure Upstream Remote**: Keep your fork updated by pointing to the upstream repository:
   ```bash
   git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git
   ```
4. **Verify Remotes**: Run `git remote -v` to ensure your configuration is correct:
   ```bash
   origin    https://github.com/your-username/Notify-Chain.git (fetch)
   origin    https://github.com/your-username/Notify-Chain.git (push)
   upstream  https://github.com/Core-Foundry/Notify-Chain.git (fetch)
   upstream  https://github.com/Core-Foundry/Notify-Chain.git (push)
   ```

### Syncing Your Fork

Before starting any new work or creating a branch, always pull the latest changes from the upstream `main` branch to prevent merge conflicts:
- Give constructive, specific feedback
- Show empathy — everyone is learning

---

## Prerequisites

Before you start, make sure you have:

- **Rust** (stable) + WebAssembly target: `rustup target add wasm32-unknown-unknown`
- **Stellar CLI**: `cargo install --locked stellar-cli --features opt`
- **Node.js 22** (used by both listener and dashboard in CI)
- **Git**

For a detailed walkthrough including platform-specific notes, see [`CONTRIBUTOR_SETUP.md`](CONTRIBUTOR_SETUP.md).

---

## Quick Setup

### With Docker (easiest)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose on Linux). No Node.js install needed.

Verify Stellar CLI:
```bash
git clone https://github.com/YOUR-USERNAME/Notify-Chain.git
cd Notify-Chain
git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git

cp .env.example .env
# Edit .env — set CONTRACT_ADDRESSES to your deployed contract ID

docker compose up --build
```

Dashboard → http://localhost:5173 · Listener API → http://localhost:8787

### Without Docker

```bash
git clone https://github.com/YOUR-USERNAME/Notify-Chain.git
cd Notify-Chain
git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git

cd listener && npm install && cp .env.example .env && npm run migrate
cd ../dashboard && npm install && cp .env.example .env
```

Minimum `listener/.env`:
```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]
```

Full setup details: [`CONTRIBUTOR_SETUP.md`](CONTRIBUTOR_SETUP.md)

---

## Issue Claiming

1. Browse [open issues](https://github.com/Core-Foundry/Notify-Chain/issues). New? Look for `good first issue`.
2. Comment: `I would like to work on this issue.`
3. Wait to be assigned — don't open a PR for unassigned work.
4. Once assigned, submit a draft PR or progress update within **5 days**. Post an update if you need more time.

---

```bash
git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git
git remote -v  # verify: origin = your fork, upstream = main repo
```

### 1. Sync and branch

Always start from an up-to-date `main`:

```bash
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
git checkout -b <branch-name>
```

Branch naming:

| Prefix | Use |
|---|---|
| `feature/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation |
| `refactor/` | Refactoring |
| `test/` | Tests only |
| `chore/` | Maintenance |
> For the complete branching strategy — including naming rules, what to avoid, and how to recover from common mistakes — see [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md).

```bash
cd dashboard
npm ci
```

### 2. Make changes

- Follow the existing code style in each component directory.
- Add comments for non-obvious logic.
- Update docs when behavior changes.
- Write tests for all new logic and bug fixes.
**Making a significant architectural change?** Read the [Architecture Decision Records](docs/adr/README.md) first — they document why the current design is what it is. If your change alters one of those decisions, add a new ADR using [`docs/adr/0000-template.md`](docs/adr/0000-template.md) and reference it in your PR.

**Hit a problem?** Check [`docs/CONTRIBUTOR_TROUBLESHOOTING.md`](docs/CONTRIBUTOR_TROUBLESHOOTING.md) before opening an issue.

## Running Tests

### 3. Run tests before pushing

**Contracts (Rust)**
```bash
cd contract
cargo fmt --all                              # format
cargo fmt --all -- --check                  # verify clean
cd contracts/hello-world && cargo test      # unit tests
```

**Listener (TypeScript)**
```bash
cd listener
npm run lint
npm run typecheck
npm test
```

**Dashboard (TypeScript)**
```bash
cd dashboard
npm run lint
npm run build    # includes TypeScript check
npm test
```

### 4. Commit

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     new feature
fix:      bug fix
docs:     documentation only
test:     tests only
refactor: no behavior change
chore:    maintenance
```

Examples:
```bash
git commit -m "feat: add retry queue for failed notifications"
git commit -m "fix: resolve event parsing issue in listener"
git commit -m "test: add payload validation edge cases"
```

### 5. Push and open a PR

```bash
git push -u origin <branch-name>
```

Then open a PR on GitHub against `main`. GitHub will pre-fill the PR template — fill it out completely.

---

## Coding Standards

### Rust (contracts)

- Format with `cargo fmt --all` before every commit
- Add `///` doc comments on all public functions and structs
- Use `#[contracterror]` for custom errors
- Every public function needs a test

### TypeScript (listener + dashboard)

- `npm run lint` must pass with zero warnings
- Use TypeScript — no `any` unless genuinely unavoidable
- Unit test all new service logic
- Follow existing file and naming conventions in the directory you're editing

---

5. **Push your branch** and open a Pull Request on GitHub:
   ```bash
   git push -u origin <branch-name>
   ```

### Title

Match commit convention: `feat: add slack notification channel`

### Description

The PR template will prompt you for:
1. Overview of what changed and why
2. Linked issue number
3. Key files modified
4. Verification commands you ran
5. Manual test instructions

### Before submitting

- [ ] Branch is up to date with `main`
- [ ] All tests pass locally
- [ ] Lint/format checks pass
- [ ] Docs updated if behavior changed
- [ ] PR scope is focused on a single issue

### Review process

- CI runs automatically — wait for green before requesting review.
- Address feedback promptly and push to the same branch (the PR updates automatically).
- Keep the scope tight — don't mix unrelated changes in one PR.
- Reviewers will test locally for significant changes.

---

## Security and Vulnerability Management

Before modifying dependencies, manifests, or lockfiles:

1. Run the vulnerability scanners locally (they also run automatically in CI):
   - **Rust**: `cd contract && cargo audit --deny warnings`
   - **Node**: `cd <component> && npm audit --audit-level=high`
2. Ensure installs are reproducible: `npm ci` (Node) and `cargo build --locked`
   (Rust). Never commit a modified `package.json` / `Cargo.toml` without the
   matching refreshed lockfile.
3. Verify the on-chain event reference is not stale:
   ```bash
   cd listener
   npm run check:event-docs
   ```

Full policy, step-by-step remediation playbook, and contacts for responsible
disclosure are documented in [`docs/security.md`](docs/security.md).

---

## Releasing NotifyChain

Maintainers preparing a tagged release should follow the steps in
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md), including CI-parity
testing, documentation review, and release validation.

## Review Process
## Automated Dependency Updates

Review expectations and a per-area checklist live in
[`docs/CODE_REVIEW_GUIDELINES.md`](docs/CODE_REVIEW_GUIDELINES.md).

### For Contributors
1. Ensure all tests pass locally
2. Address reviewer feedback promptly
3. Keep PR scope focused on a single issue or feature
4. Be open to suggestions
[Dependabot](https://docs.github.com/en/code-security/dependabot) opens PRs weekly (Mondays) for outdated dependencies across all four ecosystems. Config is in [`.github/dependabot.yml`](.github/dependabot.yml).

When reviewing Dependabot PRs: check the changelog for breaking changes, wait for CI to pass, and review the migration guide for major version bumps.

## Release Process

NotifyChain uses **fully automated releases** powered by
[semantic-release](https://semantic-release.gitbook.io/). You never need to
bump version numbers or write changelog entries manually — the tooling derives
everything from commit messages.

### How it works

1. Every commit merged to `main` is analysed by the release workflow
   (`.github/workflows/release.yml`).
2. If any releasable commits exist (see table below), `semantic-release`:
   - Determines the next [semver](https://semver.org/) version.
   - Updates `CHANGELOG.md` with structured release notes.
   - Bumps `version` in `dashboard/package.json`, `listener/package.json`,
     and `contract/contracts/hello-world/Cargo.toml` via
     `scripts/bump-versions.js`.
   - Creates a Git tag `vX.Y.Z` and pushes it.
   - Publishes a GitHub Release with auto-generated release notes.
   - Posts a comment on any PR/issue included in the release.

### Commit types → release impact

| Commit prefix | Example | Release bump |
|---------------|---------|-------------|
| `feat:` | `feat: add webhook delivery channel` | **minor** (1.x.0) |
| `fix:` | `fix: retry logic on timeout` | **patch** (1.0.x) |
| `perf:` | `perf: reduce event polling interval` | **patch** (1.0.x) |
| `refactor:` | `refactor: extract notification builder` | **patch** (1.0.x) |
| `BREAKING CHANGE:` footer or `feat!:`/`fix!:` | `feat!: rename schedule_notification params` | **major** (x.0.0) |
| `docs:`, `test:`, `chore:`, `ci:`, `style:` | any | _no release_ |

> This is why following [Conventional Commits](https://www.conventionalcommits.org/)
> matters — your commit message directly controls whether a release happens and
> what kind it is.

### Manual / dry-run trigger

You can trigger the workflow manually from the **Actions** tab:

1. Select **Release** workflow → **Run workflow**.
2. Set `dry_run` to `true` to preview what *would* be released without
   creating a tag or GitHub Release.
3. Leave `dry_run` as `false` (default) to cut a real release on demand
   (e.g. for hotfixes that need to ship before the next batch of `main` merges).

### Required secrets

The workflow uses the default `GITHUB_TOKEN` — no extra secrets are required
for tagging and publishing GitHub Releases.

### Viewing releases

- **GitHub Releases**: `https://github.com/Core-Foundry/Notify-Chain/releases`
- **CHANGELOG**: [`CHANGELOG.md`](CHANGELOG.md) in the repo root.

## Questions?
---

## Questions

- Search [existing issues](https://github.com/Core-Foundry/Notify-Chain/issues) first.
- Open a new issue for bugs or feature requests.
- Join discussions on GitHub.

---

By contributing, you agree your work will be licensed under the MIT License.
