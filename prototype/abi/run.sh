#!/usr/bin/env bash
# PROTOTYPE (#17): rebuilds every guest, checks correctness, and reruns every measurement in README.md.
# Guests, one wasm per Adapter each, all behind the same ABI:
#   gen      transpiled TS on the generic dynamic runtime (prototype/ts-transpiler's back end)
#   typed    Level 0 typed back end (shapes + spread-plus-overrides over rt2 values)
#   typed1   Level 1 typed back end (views, member arena, plans);  typed1b: + per-call bump allocator
#   ref      research/typed-codegen's hand-written typed guest (the floor);  refb: + bump allocator
# Needs: Node 22.6+, Rust with wasm32-unknown-unknown, Go 1.25+, prebid-server at ../../../prebid-server.
# DUR / PAR as in the bench; BENCH="" skips the wasm bench (about 4 min per guest).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); cd "$here"
PBS=${PBS:-$(cd ../../../prebid-server && pwd)}
export PATH=$HOME/.cargo/bin:$PATH
[ -d node_modules ] || npm ci --silent

echo "== type-check, subset rejections, transpile (generic, Level 0, Level 1)"
npx tsc -p .
node transpiler/rejects.test.mjs | tail -1
node transpiler/cli.mjs adapters/openx.ts adapters/pubmatic.ts
node transpiler/cli-typed.mjs adapters/openx.ts adapters/pubmatic.ts
node transpiler/cli-typed1.mjs adapters/openx.ts adapters/pubmatic.ts

build() { # <name> <crate dir> <lib name> <extra features>
  local name=$1 dir=$2 lib=$3 feat=${4:-}
  mkdir -p out/w-$name
  for b in openx pubmatic both; do
    local f=$([ $b = both ] && echo "openx,pubmatic" || echo $b)${feat:+,$feat}
    (cd $dir && CARGO_TARGET_DIR=../out/t-$name-$b cargo build -q --release --lib --target wasm32-unknown-unknown --no-default-features --features "$f")
    cp out/t-$name-$b/wasm32-unknown-unknown/release/$lib.wasm out/w-$name/$b.wasm
  done
}
echo "== wasm guests"
build gen guest guest; build typed guest-typed guest_typed; build typed1 guest-typed1 guest_typed1; build typed1b guest-typed1 guest_typed1 bump
build ref typed-ref typed_ref; build refb typed-ref typed_ref bump

echo "== parity: fixtures, Hand-written PBS-Go output, TS as written vs Rust/wasm"
(cd hostgo && go run ./cmd/golden "$PBS" ../harness/golden)
node harness/parity.mjs "$PBS" | tail -1
for g in typed typed1 typed1b; do
  rm -rf out/rs-$g; (cd hostgo && go run ./cmd/sharedout ../out/w-$g/both.wasm "$PBS" ../out/rs-$g)
  node harness/parity.mjs "$PBS" --rs out/rs-$g | tail -2 | sed "s/^/  [$g] /"
done
echo "== PBS-Go's own adapterstest on the Level 1 guest (expect exactly the Known Difference fixtures to fail)"
(cd hostgo && GUEST_WASM=$here/out/w-typed1b/both.wasm PBS=$PBS go test ./host -count=1 -run Adapterstest -v 2>&1 | grep -E -- '--- FAIL: TestAdapterstest/' || true)

echo "== differential fuzz: TS as written vs each typed back end (native), lone surrogates included"
for g in typed:guest-typed typed1:guest-typed1; do
  IFS=: read name dir <<<"$g"
  (cd $dir && CARGO_TARGET_DIR=../out/target-$name-native cargo build -q --release --bin fuzz --bin native)
  FUZZ_BIN=$here/out/target-$name-native/release/fuzz node harness/fuzz.mjs "$PBS" ${FUZZ:-20000} 7 | tee results/fuzz-$name.txt
done

echo "== native timings (and Level 1 allocations per call)"
mkdir -p out/payload; (cd hostgo && go run ./cmd/dumppayload payload ../out/payload)
out/target-typed1-native/release/native out/payload | tee results/native-typed1.txt
out/target-typed-native/release/native out/payload > results/native-typed.txt
(cd typed-ref && CARGO_TARGET_DIR=../out/target-ref-native cargo run -q --release --bin native -- ../out/payload) > results/native-ref.txt

if [ -n "${BENCH-1}" ]; then
  echo "== PBS-Go / wazero: overhead vs Hand-written, guest-only time, CPU at 1-8 goroutines (run on a quiet machine)"
  (cd hostgo && for g in refb typed1 typed1b; do echo "######## $g"; go run ./cmd/bench -wasm ../out/w-$g -par ${PAR:-1,2,4,8} -dur ${DUR:-2s}; done) | tee results/bench-level1-r2.txt
fi
