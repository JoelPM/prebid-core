#!/usr/bin/env bash
# Builds the #12 typed guest in several shapes, compiles each with Endive's build-time compiler
# (JVM bytecode + Redline native code), and reports the largest generated JVM methods.
# Needs: Rust with wasm32-unknown-unknown, binaryen's wasm-opt on PATH, Maven, JDK 25.
# Output: $OUT/<variant>.wasm, $OUT/mod-<variant>/classes (module class bench.<Variant>), sizes in results/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); guest=$here/../typed-rust-guest/guest
out=${OUT:-$here/out}; mkdir -p "$out" "$here/results"
export CARGO_TARGET_DIR=$out/target
# Names are kept (no strip) so generated methods carry the Rust symbol; code is identical to a stripped build.
export CARGO_PROFILE_RELEASE_STRIP=false
wasm=$out/target/wasm32-unknown-unknown/release/guest.wasm

build() { # variant, then env assignments for cargo
  local v=$1; shift
  (cd "$guest" && env "$@" cargo build -q --release --target wasm32-unknown-unknown --lib ${FEATURES:+--features $FEATURES})
  cp "$wasm" "$out/$v.wasm"
}
build O3
build Os CARGO_PROFILE_RELEASE_OPT_LEVEL=s
build O2 CARGO_PROFILE_RELEASE_OPT_LEVEL=2
build O3-inl50 RUSTFLAGS="-C llvm-args=-inline-threshold=50"
FEATURES=split build O3-split
FEATURES=split build O2-split CARGO_PROFILE_RELEASE_OPT_LEVEL=2
wasm-opt -g -O3 "$out/O3-split.wasm" -o "$out/O3-split-wasmopt.wasm"
wasm-opt -g -Oz --outlining "$out/O3.wasm" -o "$out/O3-outlined.wasm"

for v in ${VARIANTS:-O3 Os O2 O3-inl50 O3-split O2-split O3-split-wasmopt O3-outlined}; do
  cls=bench.G_${v//-/_}
  (cd "$here/module" && mvn -q -B package -Dwasm="$out/$v.wasm" -Dmodname="$cls" -DbuildDir="$out/mod-$v")
  # bytecode length of each generated method = offset of its last instruction (+1..5 bytes)
  javap -c -p -cp "$out/mod-$v/classes" "${cls}MachineFuncGroup_0" | awk -v v="$v" '
    /^  (public|private|static).*\(/ { name = $0; sub(/^.* (void|int|long|float|double) /, "", name); sub(/\(.*/, "", name) }
    /^ *[0-9]+: / { split($1, a, ":"); last = a[1] }
    /^$/ { if (name != "") { print last, name }; name = "" }' | sort -rn | head -40 > "$here/results/sizes-$v.txt"
  printf '%-18s wasm %7d B  methods %4d  over 8000 B: %s\n' "$v" "$(wasm-opt "$out/$v.wasm" --strip-debug -o - 2>/dev/null | wc -c)" \
    "$(javap -p -cp "$out/mod-$v/classes" "${cls}MachineFuncGroup_0" | grep -c "public static")" "$(awk '$1 > 8000 { printf "%s(%d) ", $2, $1 }' "$here/results/sizes-$v.txt")"
done | tee "$here/results/sizes-summary.txt"
