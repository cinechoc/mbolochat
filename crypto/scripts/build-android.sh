#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CRATE="$ROOT/crypto"
MODULE="$ROOT/mobile/modules/mbolo-crypto/android/src/main/jniLibs"

find_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]]; then
    echo "$ANDROID_NDK_HOME"
    return
  fi
  if [[ -n "${ANDROID_NDK_ROOT:-}" && -d "$ANDROID_NDK_ROOT" ]]; then
    echo "$ANDROID_NDK_ROOT"
    return
  fi
  if [[ -n "${ANDROID_NDK:-}" && -d "$ANDROID_NDK" ]]; then
    echo "$ANDROID_NDK"
    return
  fi
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" /usr/local/lib/android/sdk; do
    if [[ -n "$sdk" && -d "$sdk/ndk" ]]; then
      local found
      found="$(find "$sdk/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1)"
      if [[ -n "$found" ]]; then
        echo "$found"
        return
      fi
    fi
  done
  for candidate in /opt/ndk/android-ndk-*; do
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo "NDK Android introuvable" >&2
  exit 1
}

NDK="$(find_ndk)"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
# Les wrappers clang du NDK appellent `clang-18` via le PATH.
export PATH="$TOOLCHAIN/bin:$PATH"
API=24
export AR="$TOOLCHAIN/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/aarch64-linux-android${API}-clang"
export CARGO_TARGET_ARM_LINUX_ANDROIDEABI_LINKER="$TOOLCHAIN/bin/armv7a-linux-androideabi${API}-clang"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$TOOLCHAIN/bin/armv7a-linux-androideabi${API}-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/bin/x86_64-linux-android${API}-clang"
export CC_aarch64_linux_android="$TOOLCHAIN/bin/aarch64-linux-android${API}-clang"
export AR_aarch64_linux_android="$TOOLCHAIN/bin/llvm-ar"
export CC_arm_linux_androideabi="$TOOLCHAIN/bin/armv7a-linux-androideabi${API}-clang"
export CC_armv7_linux_androideabi="$TOOLCHAIN/bin/armv7a-linux-androideabi${API}-clang"
export AR_arm_linux_androideabi="$TOOLCHAIN/bin/llvm-ar"
export AR_armv7_linux_androideabi="$TOOLCHAIN/bin/llvm-ar"
export CC_x86_64_linux_android="$TOOLCHAIN/bin/x86_64-linux-android${API}-clang"
export AR_x86_64_linux_android="$TOOLCHAIN/bin/llvm-ar"

cd "$CRATE"
if command -v rustup >/dev/null 2>&1; then
  rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android >/dev/null
fi
cargo build --release --target aarch64-linux-android --features jni --lib
cargo build --release --target armv7-linux-androideabi --features jni --lib
cargo build --release --target x86_64-linux-android --features jni --lib
cargo build --release --target aarch64-linux-android --bin spike
cargo build --release --target armv7-linux-androideabi --bin spike
cargo build --release --target x86_64-linux-android --bin spike

mkdir -p "$MODULE/arm64-v8a" "$MODULE/armeabi-v7a" "$MODULE/x86_64" "$CRATE/dist/android"
cp "$CRATE/target/aarch64-linux-android/release/libmbolo_crypto.so" "$MODULE/arm64-v8a/"
cp "$CRATE/target/armv7-linux-androideabi/release/libmbolo_crypto.so" "$MODULE/armeabi-v7a/"
cp "$CRATE/target/x86_64-linux-android/release/libmbolo_crypto.so" "$MODULE/x86_64/"
cp "$CRATE/target/aarch64-linux-android/release/spike" "$CRATE/dist/android/spike-arm64"
cp "$CRATE/target/armv7-linux-androideabi/release/spike" "$CRATE/dist/android/spike-v7a"
cp "$CRATE/target/x86_64-linux-android/release/spike" "$CRATE/dist/android/spike-x86_64"

file "$MODULE/arm64-v8a/libmbolo_crypto.so" "$MODULE/armeabi-v7a/libmbolo_crypto.so" "$MODULE/x86_64/libmbolo_crypto.so"
echo "Bibliothèques copiées vers $MODULE"
