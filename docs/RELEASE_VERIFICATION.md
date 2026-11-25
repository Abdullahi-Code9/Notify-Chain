# Release Artifact Verification

This document explains how to verify the integrity and provenance of NotifyChain
release artifacts. It supports the process implemented in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) (issue
[#1003](https://github.com/Core-Foundry/Notify-Chain/issues/1003)).

Every release publishes the following files:

| Artifact | Description |
|----------|-------------|
| `notifychain-listener-<version>.tar.gz` | Compiled listener (`dist/`) and `package.json` |
| `notifychain-dashboard-<version>.tar.gz` | Compiled dashboard (`dist/`) |
| `SHA256SUMS` | SHA-256 checksums for every artifact above |

Two independent guarantees are attached to each release:

1. **Checksums** — `SHA256SUMS` is generated with `sha256sum` and lets you
   confirm the downloaded files were not corrupted or tampered with in transit.
2. **Build provenance attestations** — produced keylessly via GitHub OIDC with
   [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance).
   Attestations bind the artifacts to the workflow, commit and repository that
   produced them.

## Prerequisites

- [`gh`](https://cli.github.com/) version `2.49.0` or newer (for
  `gh attestation verify`).
- `sha256sum` (part of GNU coreutils; available on Linux, macOS and most
  Windows environments via Git Bash or WSL).

## 1. Download the release artifacts

Download all files from the GitHub release page, or use the CLI:

```bash
gh release download <version> --repo Core-Foundry/Notify-Chain
```

## 2. Verify checksums

From the directory containing the downloaded files:

```bash
sha256sum --check SHA256SUMS
```

Expected output lists each artifact followed by `OK`. A `FAILED` line means the
file was corrupted or modified — do not use it.

## 3. Verify build provenance

Verify that each artifact was produced by the `Core-Foundry/Notify-Chain`
release workflow:

```bash
gh attestation verify notifychain-listener-<version>.tar.gz --repo Core-Foundry/Notify-Chain
gh attestation verify notifychain-dashboard-<version>.tar.gz --repo Core-Foundry/Notify-Chain
```

A successful verification prints the attestation details, including the source
commit and the workflow that generated the artifact. A non-zero exit code means
the attestation is missing or does not match the artifact.

To additionally require that the artifact came from the repository's default
branch workflow, pass a predicate policy file:

```bash
cat > policy.json <<'JSON'
{
  "predicateType": "https://slsa.dev/provenance/v1"
}
JSON

gh attestation verify notifychain-listener-<version>.tar.gz \
  --repo Core-Foundry/Notify-Chain \
  --predicate-type https://slsa.dev/provenance/v1
```

## How CI validates the process

The release workflow runs in three stages:

1. **`validate-workflow`** — on pull requests, lints the workflow with
   `actionlint` and rehearses the checksum/verification commands so regressions
   in the release process are caught before merge.
2. **`build`** — on tags and manual runs, builds the artifacts, generates
   `SHA256SUMS`, re-verifies the checksums, and attests build provenance.
3. **`verify`** — independently downloads the artifacts, checks the checksums
   and runs `gh attestation verify`, failing the run if any check does not pass.

If any stage fails, the artifacts are not published (or the offending run is
marked failed), so a release can never ship without verifiable checksums and
provenance.
