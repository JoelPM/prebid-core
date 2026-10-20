#!/bin/sh
# Reproduces every result in ../params-schema-subset.md. Needs node, go, cargo, java, python3, and the
# PBS-Go / PBS-Java checkouts and jars named in catalogue.py and below. Build output goes to $TMPDIR.
set -e
cd "$(dirname "$0")"
M2=${M2:-$HOME/.m2/repository}
CP="$M2/com/networknt/json-schema-validator/1.5.6/json-schema-validator-1.5.6.jar:$M2/com/fasterxml/jackson/core/jackson-databind/2.18.6/jackson-databind-2.18.6.jar:$M2/com/fasterxml/jackson/core/jackson-core/2.18.6/jackson-core-2.18.6.jar:$M2/com/fasterxml/jackson/core/jackson-annotations/2.18.6/jackson-annotations-2.18.6.jar:$M2/org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar:$M2/com/ethlo/time/itu/1.10.3/itu-1.10.3.jar"
export CARGO_TARGET_DIR="${TMPDIR:-/tmp}/params-schema-subset-target"
mkdir -p out
python3 -I catalogue.py --json out/catalogue.json > out/catalogue.txt
node gen-cases.mjs out/catalogue.json > cases.json
node gen-values.mjs > values.json

# 1. raw catalogue + probe patterns, each engine as its validator calls it
node js.mjs cases.json u > out/js-u.json
node js.mjs cases.json "" > out/js.json
(cd rust && cargo run -q --release --bin regex-diff -- ../cases.json > ../out/rust.json)
(cd go && go run . ../cases.json > ../out/go.json)
java -cp "$CP" Java.java cases.json > out/java.json 2>/dev/null
node compare.mjs cases.json out/js-u.json out/rust.json out/go.json out/java.json > out/patterns.txt
node compare.mjs cases.json out/js-u.json out/js.json > out/js-u-vs-plain.txt

# 2. the proposed subset: classify, translate per engine, re-run, compare with ECMA-262
node subset.mjs cases.json > out/subset.txt
node js.mjs out/cases-js.json u > out/tr-js.json
(cd rust && cargo run -q --release --bin regex-diff -- ../out/cases-rust.json > ../out/tr-rust.json)
(cd go && go run . ../out/cases-go.json > ../out/tr-go.json)
java -cp "$CP" Java.java out/cases-java.json > out/tr-java.json 2>/dev/null
node compare-translated.mjs cases.json out/tr-js.json out/tr-rust.json out/tr-go.json out/tr-java.json > out/translated.txt

# 3. formats, numbers, lengths, combinators through PBS-Go's and PBS-Java's real validators
(cd go && go run ./values ../values.json > ../out/values-go.json)
java -cp "$CP" JavaValues.java values.json > out/values-java.json 2>/dev/null
node values-js.mjs values.json > out/values-js.json
(cd rust && cargo run -q --release --bin values -- ../values.json > ../out/values-rust.json)
node values-print.mjs values.json out/values-go.json out/values-java.json out/values-js.json out/values-rust.json > out/values.md

# 4. backtracking cost of feedad's pattern (and its star-height-1 rewrite)
node redos.mjs > out/redos.txt
java Redos.java >> out/redos.txt
# 5. the proposed numeric-bound rule, and the catalogue against the whole proposed subset
node bounds.mjs > out/bounds.txt
node check-catalogue.mjs > out/outside.txt
tail -1 out/patterns.txt out/translated.txt
