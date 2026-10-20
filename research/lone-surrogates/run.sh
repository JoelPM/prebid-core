#!/usr/bin/env bash
# Reproduces every experiment in ../lone-surrogates.md. Needs Go, a JDK, Node and cargo, plus the
# sibling checkouts (../prebid-server and the prototype/ts-transpiler and research/typed-codegen
# worktrees) and Jackson 2.18.6 in ~/.m2.
set -euo pipefail
cd "$(dirname "$0")"
python3 gen_cases.py
echo "########## PBS-Go (encoding/json, jsonutil/jsoniter, jsonparser)"; (cd go && go run .)
J=~/.m2/repository/com/fasterxml/jackson/core
CP=$J/jackson-core/2.18.6/jackson-core-2.18.6.jar:$J/jackson-databind/2.18.6/jackson-databind-2.18.6.jar:$J/jackson-annotations/2.18.6/jackson-annotations-2.18.6.jar
echo "########## PBS-Java (Jackson)"; (cd java && java -cp "$CP" Surrogates.java)
echo "########## Prebid.js (V8 JSON, TextDecoder/TextEncoder)"; (cd node && node surrogates.mjs)
echo "########## serde_json (Trusted Server; a serde typed back end)"; (cd rust && cargo run -q)
echo "########## prototype runtime (runtime/rs Doc)"; (cd rt && cargo run -q)
echo "########## typed guest helpers (typed/src/j.rs)"; (cd typed && cargo run -q 2>/dev/null)
P=../../../../prebid-core-wt-typed-codegen/prototype/profile-compiler/hostgo/payload
echo "########## boundary cost"; (cd cost && cargo run -q --release --bin native -- "$P" \
  && cargo build -q --release --lib --target wasm32-unknown-unknown \
  && node cost.mjs target/wasm32-unknown-unknown/release/surrogates_cost.wasm "$P")
