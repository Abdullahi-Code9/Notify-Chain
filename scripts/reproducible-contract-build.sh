#!/usr/bin/env bash
# Build the committed contract in a fresh path. Requires Bash and GNU tools.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
label=${1:?Usage: bash scripts/reproducible-contract-build.sh first|second OUTPUT_DIRECTORY}
case "$label" in
  first|second) ;;
  *) echo "Build label must be first or second" >&2; exit 2 ;;
esac
output=${2:?Specify an output directory}
mkdir -p "$output"
output=$(cd "$output" && pwd)
toolchain=$(sed -n 's/^channel = "\([^"]*\)"$/\1/p' "$repo_root/contract/rust-toolchain.toml")
test -n "$toolchain"
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notify-repro-${label}-XXXXXX")
# Intentionally vary both the parent path and the depth of the source tree.
if [[ "$label" == first ]]; then
  source_root="$scratch/source"
else
  source_root="$scratch/a/different/depth/contract-source"
fi
mkdir -p "$source_root"
export CARGO_HOME="$scratch/cargo-home"
export CARGO_TARGET_DIR="$scratch/target"
export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git -C "$repo_root" show -s --format=%ct HEAD)
export TZ=UTC LC_ALL=C
# Exclude workstation modifications, old outputs, and unrelated repository files.
git -C "$repo_root" archive HEAD:contract | tar -x -C "$source_root"
rm -rf -- "$source_root/target"
# Map source, dependency, and output paths to stable virtual locations. The
# release profile already disables debug info and strips symbols.
unset CARGO_ENCODED_RUSTFLAGS
export RUSTFLAGS="--remap-path-prefix=$source_root=/contract --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$CARGO_TARGET_DIR=/target"
if [[ -n "${RUSTUP_HOME:-}" ]]; then
  RUSTFLAGS+=" --remap-path-prefix=$RUSTUP_HOME=/rustup"
fi
{
  echo "commit=$(git -C "$repo_root" rev-parse HEAD)"
  echo "toolchain=$toolchain"
  echo "runner_image=${ImageOS:-unknown} ${ImageVersion:-unknown}"
  echo "runner_arch=${RUNNER_ARCH:-unknown}"
  echo "target=wasm32v1-none profile=release package=hello-world"
  echo "source=$source_root"
  echo "cargo_home=$CARGO_HOME"
  echo "target_dir=$CARGO_TARGET_DIR"
  echo "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
  echo "RUSTFLAGS=$RUSTFLAGS"
  uname -a
  rustc +"$toolchain" --version --verbose
  cargo +"$toolchain" --version --verbose
  sha256sum "$source_root/Cargo.lock"
} > "$output/environment.txt" 2>&1

cd "$source_root"
# tee preserves compiler diagnostics; pipefail preserves the Cargo failure code.
cargo +"$toolchain" build --locked --release --target wasm32v1-none \
  --package hello-world --lib 2>&1 | tee "$output/build.log"
cp "$CARGO_TARGET_DIR/wasm32v1-none/release/hello_world.wasm" "$output/hello_world.wasm"
(cd "$output" && sha256sum hello_world.wasm > SHA256SUMS)
# Preserve raw outputs for diagnosis; runner teardown removes scratch directories.
