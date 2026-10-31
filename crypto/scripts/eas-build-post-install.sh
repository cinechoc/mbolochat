#!/usr/bin/env bash
set -euo pipefail

# Exécuté par EAS juste après npm install, avant la compilation Gradle.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JNI="$ROOT/mobile/modules/mbolo-crypto/android/src/main/jniLibs"
if [[ -f "$JNI/arm64-v8a/libmbolo_crypto.so" && -f "$JNI/x86_64/libmbolo_crypto.so" ]]; then
  echo "[mbolo-crypto] bibliothèques précompilées présentes, build Rust ignoré."
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain 1.89.0
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustup target add aarch64-linux-android x86_64-linux-android

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-android.sh"
