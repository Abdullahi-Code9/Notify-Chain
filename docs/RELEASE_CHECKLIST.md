# NotifyChain Release Checklist

Use this checklist before publishing a new NotifyChain release (tagged version on
`main`). It aligns with the [CI workflow](../.github/workflows/ci.yml) and the
verification steps in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Before you start

- [ ] Release scope is agreed (contracts, listener, dashboard, docs only, etc.).
- [ ] All changes for the release are merged to `main` (or the release branch).
- [ ] `main` is up to date with upstream:
  ```bash
  git checkout main
  git pull upstream main
  ```

## Testing

Run the same checks CI runs on pull requests. From the repository root:

### Rust (Soroban contracts)

```bash
cd contract
rustup component add rustfmt
cargo fmt --all -- --check
cargo test --workspace --all-features --verbose
```

- [ ] `cargo fmt` check passes
- [ ] All contract unit tests pass
- [ ] Fuzz tests pass (`cargo test fuzz_ --verbose -- --nocapture` in `contract/`)

### Listener

```bash
cd listener
npm ci
npm run lint
npm run typecheck
npm test --silent
```

- [ ] Listener lint/typecheck passes
- [ ] Listener tests pass

### Dashboard

```bash
cd dashboard
npm ci
npm run lint
npm run build
npm test --silent
npm run test:wallet --silent
```

- [ ] Dashboard lint passes
- [ ] Dashboard build (TypeScript + Vite) succeeds
- [ ] Dashboard tests pass
- [ ] Wallet integration tests pass (`npm run test:wallet`)

### Listener database migrations (when schema changes ship)

```bash
cd listener
npm ci
npm run migrate
npm run check-migrations
```

- [ ] Migrations apply cleanly on a fresh database
- [ ] No pending migrations reported by `check-migrations`

### Optional (when release includes these areas)

- [ ] Contract WASM builds successfully (`stellar contract build` in `contract/`)
- [ ] Listener production build: `cd listener && npm run build`
- [ ] Manual smoke test: listener events API + dashboard against testnet (see [README](../README.md#local-development-guide))

## Documentation review

- [ ] [README.md](../README.md) reflects new features, config, or breaking changes
- [ ] [CONTRIBUTING.md](../CONTRIBUTING.md) is still accurate (setup, test commands)
- [ ] User-facing guides updated where behavior changed (for example
      [TROUBLESHOOTING.md](../TROUBLESHOOTING.md),
      [NOTIFICATION_PAYLOAD_SCHEMA.md](../NOTIFICATION_PAYLOAD_SCHEMA.md),
      [CONTRACT_UPGRADE_GUIDE.md](../CONTRACT_UPGRADE_GUIDE.md))
- [ ] Environment variables documented in `listener/.env.example` if new vars were added
- [ ] Breaking API or event schema changes noted (changelog entry or dedicated doc)

## Release validation

### Version and artifacts

- [ ] Release version number chosen (semver tag, e.g. `v1.2.0`)
- [ ] Contract version / WASM artifacts identified if contracts ship in this release
- [ ] Release artifacts are produced by the [release workflow](../.github/workflows/release.yml)
      with `SHA256SUMS` and build provenance attestations, and the steps in
      [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md) have been reviewed
- [ ] If upgrading deployed contracts, [CONTRACT_UPGRADE_GUIDE.md](../CONTRACT_UPGRADE_GUIDE.md) followed and testnet verification completed

### Tag and publish

- [ ] Git tag created on the release commit:
  ```bash
  git tag -a vX.Y.Z -m "Release vX.Y.Z"
  git push upstream vX.Y.Z   # or push tag to your fork and open PR if tags go via maintainers
  ```
- [ ] GitHub Release drafted with summary, upgrade notes, and known issues
- [ ] Release notes list contributors and link closed issues where helpful

### Post-release

- [ ] Deployed environments updated (listener, dashboard) if applicable
- [ ] Staging workflow expectations met if using the `staging` branch (see
      [.github/workflows/staging.yml](../.github/workflows/staging.yml))
- [ ] Monitor logs and notification delivery after deploy
- [ ] Open follow-up issues for deferred items or regressions found after ship

## Sign-off

| Role            | Name | Date | Notes |
|-----------------|------|------|-------|
| Release manager |      |      |       |
| Technical review|      |      |       |
