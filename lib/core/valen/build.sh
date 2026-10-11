#!/bin/sh
# Builds health.vale into ../health.wasm: a WASI reactor exporting its exported funcs, which
# imports its extern funcs from "env" (../healthWasm.js provides them).
#
# Needs a built Valen compiler (https://github.com/valen-lang/valen, `cargo build --bin valec`)
# and wasi-sdk. .github/workflows/valen-wasm.yml runs this on Ubuntu.
#   VALEN_DIR=~/valen WASI_SDK_PATH=~/wasi-sdk lib/core/valen/build.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
: "${VALEN_DIR:?set VALEN_DIR to a Valen checkout with valec built}"
: "${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk install}"
out=$(mktemp -d)

# valec links a command around main. A reactor instead stays usable between calls; the externs
# are left undefined to become imports, and the exported funcs are kept as exports.
cat > "$out/clang" <<EOF
#!/bin/sh
exec "$WASI_SDK_PATH/bin/clang" -mexec-model=reactor -Wl,--allow-undefined \\
  -Wl,--export=health_healthUpdate -Wl,--export=health_respawned -Wl,--export=health_respawnCommand \\
  "\$@"
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
  health="$here/health.vale"

cp "$out/build/health.wasm" "$here/../health.wasm"
echo "Built $here/../health.wasm"
