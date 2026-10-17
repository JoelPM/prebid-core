#!/bin/bash
# Build every variant, wasm-opt -Oz it, report sizes, and run the parity harness.
# env: WASM_OPT (binaryen wasm-opt), CARGO_TARGET_DIR (optional), OUT (default ./out)
# usage: build.sh <prebid-server/adapters/openx/openxtest>
set -e
H=$(cd "$(dirname "$0")" && pwd); OUT=${OUT:-$H/out}; mkdir -p "$OUT"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$H/target}
for f in dom imports dom,floor; do
  n=${f/,/_}
  (cd "$H/ox-lean" && cargo build -q --release --target wasm32-unknown-unknown --no-default-features --features "$f")
  cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/ox_lean.wasm" "$OUT/ox_$n.wasm"
  bash "$H/wopt.sh" "$OUT/ox_$n.wasm" "$OUT/ox_$n.opt.wasm"
  base64 < "$OUT/ox_$n.opt.wasm" | tr -d '\n' > "$OUT/ox_$n.opt.b64"
  bash "$H/sz.sh" "$OUT/ox_$n.wasm" "ox_$n (cargo, opt-level=z, lto)"
  bash "$H/sz.sh" "$OUT/ox_$n.opt.wasm" "ox_$n + wasm-opt -Oz"
  bash "$H/sz.sh" "$OUT/ox_$n.opt.b64" "ox_$n + wasm-opt -Oz, base64"
done
if [ -n "$1" ]; then
  node "$H/js/parity.mjs" dom "$OUT/ox_dom.opt.wasm" "$1"
  node "$H/js/parity.mjs" imports "$OUT/ox_imports.opt.wasm" "$1"
  node "$H/js/parity.mjs" js - "$1"
fi
