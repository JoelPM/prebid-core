#!/bin/sh
# Reproduces results/: the case corpus, one probe per Host model, and the comparison.
# Needs sibling checkouts of prebid-server, prebid-server-java and trusted-server next to prebid-core
# (see the paths in go/go.mod and rust/Cargo.toml), Go, a JDK, Cargo and Node.
# JACKSON: a directory holding PBS-Java's Jackson 2.21.2 jars (core, databind, annotations 2.21,
# module-blackbird), the version Spring Boot 4.0.6's BOM gives PBS-Java.
set -e
cd "$(dirname "$0")"
: "${JACKSON:?set JACKSON to a directory of Jackson 2.21.2 jars}"
BUILD=${BUILD:-$(mktemp -d)}
node cases.mjs
(cd go && go run . ../cases ../shapes.json) > out-go.jsonl
CP=$(ls "$JACKSON"/*.jar | tr '\n' ':')
node java/gen-model.mjs ../../../prebid-server-java/src/main/java > java/Model.java
javac -nowarn -cp "$CP" -d "$BUILD" java/Model.java java/Probe.java 2>&1 | grep -v '^Note:' || true
java -cp "$CP$BUILD" Probe cases > out-java.jsonl
(cd rust && cargo run -q --release -- ../cases) > out-rust.jsonl
node compare.mjs
node effect.mjs   # needs the prototype/abi worktree next to this one (or pass its path)
