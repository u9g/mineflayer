#!/bin/sh
# Builds health.vale into ../health.wasm, a WASI reactor exporting "step".
#
# Needs a built Valen compiler (https://github.com/valen-lang/valen, `cargo build --bin valec`)
# and wasi-sdk. .github/workflows/valen-wasm.yml runs this on Ubuntu.
#   VALEN_DIR=~/valen WASI_SDK_PATH=~/wasi-sdk lib/core/valen/build.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
: "${VALEN_DIR:?set VALEN_DIR to a Valen checkout with valec built}"
: "${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk install}"
out=$(mktemp -d)

# valec links a command with main; a reactor instead keeps the instance usable between calls
cat > "$out/clang" <<EOF
#!/bin/sh
exec "$WASI_SDK_PATH/bin/clang" -mexec-model=reactor "\$@"
EOF
chmod +x "$out/clang"

"$VALEN_DIR/target/debug/valec" build \
  --no-std \
  --builtins-dir-override "$VALEN_DIR/Backend/builtins" \
  --clang-override "$out/clang" \
  --target-triple wasm32-wasi \
  --sysroot "$WASI_SDK_PATH/share/wasi-sysroot" \
  --output-dir "$out/build" \
  -o health.wasm \
  health="$here/health.vale" shim="$here/shim.c"

cp "$out/build/health.wasm" "$here/../health.wasm"
echo "Built $here/../health.wasm"
