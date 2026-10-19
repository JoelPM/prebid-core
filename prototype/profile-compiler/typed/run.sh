#!/usr/bin/env bash
# RESEARCH (#16): builds the typed guests, checks parity exactly as ../run.sh does for the generated
# ones, then measures them with the same bench. Needs what ../run.sh needs (Node 22.6+, Rust with
# wasm32-unknown-unknown, Go 1.25+, prebid-server at ../../../../prebid-server, a916b19ef measured).
# ABL="" skips the ablation builds; DUR / PAR as in ../run.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
PBS=${PBS:-$(cd ../../../prebid-server && pwd)}
export PATH=$HOME/.cargo/bin:$PATH
[ -d node_modules ] || npm ci --silent
ABL=${ABL-"abl_owned abl_unfused abl_nointern abl_nohoist abl_rescan abl_twopass abl_passthru abl_eager abl_freshout bump all"}
ALL=abl_owned,abl_unfused,abl_nointern,abl_nohoist,abl_rescan,abl_twopass,abl_passthru,abl_eager,abl_freshout
feats() { [ "$1" = all ] && echo $ALL || echo "$1"; }

build() { # <variant name> <features> -> out/wasm-typed/<name>/{openx,pubmatic,both}.wasm
  local name=$1 feats=$2 dst=out/wasm-typed/$1
  mkdir -p "$dst"
  for b in openx pubmatic both; do
    local f=$([ $b = both ] && echo "openx,pubmatic" || echo $b)${feats:+,$feats}
    (cd typed && CARGO_TARGET_DIR=../out/target-typed-$name-$b cargo build -q --release --lib --target wasm32-unknown-unknown --no-default-features --features "$f")
    cp out/target-typed-$name-$b/wasm32-unknown-unknown/release/typed_guest.wasm "$dst/$b.wasm"
  done
}
parity() { # <variant name>
  rm -rf out/rs-typed-$1
  (cd hostgo && go run ./cmd/sharedout ../out/wasm-typed/$1/both.wasm "$PBS" ../out/rs-typed-$1)
  node harness/parity.mjs "$PBS" --rs out/rs-typed-$1 | tail -2 | sed "s/^/  [$1] /"
}

echo "== typed guests: build, parity (golden + fixtures + TS vs Rust), PBS-Go adapterstest"
(cd hostgo && go run ./cmd/golden "$PBS" ../harness/golden)
build typed ""
parity typed
(cd hostgo && { GUEST_WASM=$PWD/../out/wasm-typed/typed/both.wasm PBS=$PBS go test -race -count=1 ./host -run Adapterstest -v 2>&1 || true; } \
  | awk '/--- PASS: TestAdapterstest\//{p++} /--- FAIL: TestAdapterstest\//{f++; print "  " $0} END{print "  adapterstest: " p " pass, " f " fail (expect exactly the 3 Known Difference fixtures)"}')
for a in $ABL; do build "$a" "$(feats $a)"; parity "$a"; done

echo "== native timing (generated vs typed)"
mkdir -p out/payload
(cd hostgo && go run ./cmd/dumppayload payload ../out/payload)
(cd guest && CARGO_TARGET_DIR=../out/target-native cargo run -q --release --bin native -- ../out/payload) | sed 's/^/  generated: /'
(cd typed && CARGO_TARGET_DIR=../out/target-typed-native cargo run -q --release --bin native -- ../out/payload) | sed 's/^/  typed: /'
for a in $ABL; do
  (cd typed && CARGO_TARGET_DIR=../out/target-typed-native-$a cargo run -q --release --bin native --features "$(feats $a)" -- ../out/payload) | grep -E '/|mr \+ mb' | sed "s/^/  $a: /"
done

echo "== generated guests (profile-compiler), rebuilt here so both are measured in the same session"
mkdir -p out/wasm
for b in openx pubmatic; do
  (cd guest && CARGO_TARGET_DIR=../out/target-$b cargo build -q --release --lib --target wasm32-unknown-unknown --no-default-features --features $b)
  cp out/target-$b/wasm32-unknown-unknown/release/guest.wasm out/wasm/$b.wasm
done
for r in ${RUNS:-1 2}; do
  echo "== PBS-Go / wazero vs Hand-written: generated guests (run $r)"
  (cd hostgo && go run ./cmd/bench -wasm ../out/wasm -par ${PAR:-1,2,4,8} -dur ${DUR:-2s})
  echo "== PBS-Go / wazero vs Hand-written: typed guests (run $r)"
  (cd hostgo && go run ./cmd/bench -wasm ../out/wasm-typed/typed -par ${PAR:-1,2,4,8} -dur ${DUR:-2s})
done
for a in $ABL; do
  echo "== ablation: $a"
  (cd hostgo && go run ./cmd/bench -wasm ../out/wasm-typed/$a -par "" | grep -E '^==|overhead, one|guest')
done
