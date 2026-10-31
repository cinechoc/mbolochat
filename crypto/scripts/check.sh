#!/usr/bin/env bash
set -euo pipefail

CRATE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE"

cargo fmt --check
cargo clippy --all-targets --features jni -- -D warnings
cargo test --features jni
node scripts/check-licenses.mjs
if command -v cargo-audit >/dev/null 2>&1; then
  cargo audit
else
  echo "cargo-audit absent : lancez 'cargo install cargo-audit --locked' pour l'audit RustSec." >&2
fi
