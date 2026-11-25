# Contract build reproducibility

The `Contract Build Reproducibility` workflow checks that the committed
`hello-world` contract produces **byte-identical release Wasm** in two clean
Ubuntu 24.04 jobs. A missing output, failed build, or byte difference fails the
check. This is an explicit reproducibility check, not a contract test suite.

## Fixed inputs and normalization

- `contract/rust-toolchain.toml` pins Rust/Cargo to **1.86.0** with the minimal
  profile, `rustfmt`, and the `wasm32v1-none` target. The lockfile and toolchain
  pin are reviewed together when contract dependencies change.
- Both builds use the same Git commit, package, target, and release profile.
  `cargo build --locked` rejects lockfile changes. The lockfile checksum,
  compiler version (including commit and host), Cargo version, kernel, paths,
  and flags are saved in `environment.txt`.
- Each job extracts `git archive HEAD:contract` into a new temporary source
  directory. The second build uses a different directory depth. Uncommitted
  local edits are deliberately excluded. Existing target outputs are removed.
- Fresh Cargo homes and target directories prevent artifact-cache reuse.
  Incremental compilation is disabled. Dependencies are fetched separately,
  verified against lockfile checksums, and compiled in each job.
- `--remap-path-prefix` maps source, dependency, target, and (when configured)
  Rustup directories to stable virtual paths. Release debug information is
  disabled and symbols are stripped by the existing Cargo release profile.
  `SOURCE_DATE_EPOCH` is the commit timestamp; locale and timezone are fixed.
  These settings do not guarantee arbitrary future build scripts respect them.

## Outputs and failure diagnosis

Each build uploads the raw `hello_world.wasm`, its SHA-256 checksum, compiler
log, toolchain installation log, and environment metadata for 14 days. Uploads
are attempted even after a failure. The comparison job reports hashes in the
GitHub job summary and uploads a result and, on mismatch, the first 100
different byte offsets (offsets are decimal; byte values are octal). Missing
outputs fail explicitly; inspect the individual build artifacts for the cause.

To investigate a mismatch, compare compiler and lockfile metadata first, then
inspect the two saved raw Wasm binaries. Do not strip or rewrite an unexpected
section just to make the check pass: document the source of nondeterminism and
make any proposed normalization a reviewed policy change.

## Scope and excluded artifacts

Only `target/wasm32v1-none/release/hello_world.wasm` is the comparison subject.
There are no allowed byte differences in that file, including custom sections.
The following outputs are deliberately excluded because they can contain host
paths, timings, metadata, or packaging timestamps:

- Cargo fingerprints, dependency files (`.d`), intermediate libraries, build
  scripts and their outputs, and the rest of `target/`.
- Compiler/installation logs and `environment.txt` (source paths intentionally
  differ), checksum manifests containing output paths, and CI artifact ZIPs.
- Debug/test binaries, `release-with-logs` builds, and any Wasm transformed by
  Stellar CLI, `wasm-opt`, signing, deployment, or external packaging tools.

The check does not yet claim reproducibility across operating systems,
architectures, compiler versions, or different Ubuntu runner image revisions.
`ubuntu-24.04` receives updates; it is not an immutable container image. Each
run records the actual compiler and host environment. Toolchain downloads and
registry access are still required. New contracts must be added to both the
build script and comparison policy before they are covered.

## Reproducing the CI procedure locally

On Linux with Git, Bash, GNU tar/coreutils, rustup, and the pinned Rust toolchain
and target already installed, run from the repository root:

```sh
bash scripts/reproducible-contract-build.sh first /tmp/notify-first
bash scripts/reproducible-contract-build.sh second /tmp/notify-second
cmp /tmp/notify-first/hello_world.wasm /tmp/notify-second/hello_world.wasm
```

Use separate fresh machines or containers for the same environment isolation as
CI. The script builds **committed** contract sources, so commit intended contract
changes before using this procedure. Bump the toolchain pin deliberately with
dependency upgrades and review the resulting binary differences. This workflow
was added without executing builds locally; CI must establish its first result.
