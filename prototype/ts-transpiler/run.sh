#!/usr/bin/env bash
# PROTOTYPE: rebuilds everything and reruns every check and measurement in README.md.
# Needs: Node 22.6+ (TS type stripping), Rust with wasm32-unknown-unknown, Go 1.25+, a prebid-server
# checkout at ../../../prebid-server (a916b19ef measured). Optional: PBJS=<scratch Prebid.js clone
# with node_modules> for the bundle sizes (it gets files added; never point it at a real checkout).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); cd "$here"
PBS=${PBS:-$(cd ../../../prebid-server && pwd)}
export PATH=$HOME/.cargo/bin:$PATH
[ -d node_modules ] || npm ci --silent

echo "== type-check the Shared Adapters (strict, noUncheckedIndexedAccess)"; npx tsc -p .
echo "== subset checker: rejection cases"; node transpiler/rejects.test.mjs | tail -1
echo "== transpile restricted TS -> Rust"; node transpiler/cli.mjs adapters/openx.ts adapters/pubmatic.ts

echo "== wasm guests (one per Adapter, plus one with both for the parity runs)"
mkdir -p out/wasm
(cd guest && CARGO_TARGET_DIR=../out/target cargo build -q --release --lib --target wasm32-unknown-unknown)
cp out/target/wasm32-unknown-unknown/release/guest.wasm out/wasm/both.wasm
for b in openx pubmatic; do
  (cd guest && CARGO_TARGET_DIR=../out/target-$b cargo build -q --release --lib --target wasm32-unknown-unknown --no-default-features --features $b)
  cp out/target-$b/wasm32-unknown-unknown/release/guest.wasm out/wasm/$b.wasm
done

echo "== parity: golden (Hand-written PBS-Go output), TS as written, Rust/wasm, TS vs Rust"
(cd hostgo && go run ./cmd/golden "$PBS" ../harness/golden)
node harness/parity.mjs "$PBS" | tail -1
(cd hostgo && go run ./cmd/sharedout ../out/wasm/both.wasm "$PBS" ../out/rs)
node harness/parity.mjs "$PBS" --rs out/rs | tail -2
echo "== PBS-Go's own adapterstest against the wasm Shared Adapters (expect exactly the Known Difference fixtures to fail)"
(cd hostgo && GUEST_WASM=$here/out/wasm/both.wasm PBS=$PBS go test ./host -count=1 -run Adapterstest -v 2>&1 | grep -E -- '--- FAIL: TestAdapterstest/' || true)

echo "== differential fuzz: TS vs transpiled Rust (native) on mutated fixture inputs"
(cd guest && CARGO_TARGET_DIR=../out/target-native cargo build -q --release --bin fuzz)
node harness/fuzz.mjs "$PBS" ${FUZZ:-20000} 7 | tee results/fuzz.txt

echo "== native guest timing"; mkdir -p out/payload; (cd hostgo && go run ./cmd/dumppayload payload ../out/payload) && (cd guest && CARGO_TARGET_DIR=../out/target-native cargo run -q --release --bin native -- ../out/payload)
echo "== PBS-Go / wazero vs Hand-written"; (cd hostgo && go run ./cmd/bench -wasm ../out/wasm -par ${PAR:-1,4,8} -dur ${DUR:-2s}) | tee results/wazero.txt

if [ -n "${PBJS:-}" ]; then
  echo "== Prebid.js bundle"
  node pbjs/install.mjs "$PBJS"
  (cd "$PBJS" && npx gulp build --modules=openxBidAdapter,openxSharedBidAdapter,pubmaticBidAdapter,pubmaticSharedBidAdapter >/dev/null)
  pbjs/measure.sh "$PBJS" | tee results/pbjs.txt
fi
