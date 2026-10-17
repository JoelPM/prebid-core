#!/usr/bin/env bash
# Rebuilds the guest and reruns every measurement in ../typed-rust-guest.md.
# Needs: Rust with wasm32-unknown-unknown, Go 1.25+, a prebid-server checkout at ../../../prebid-server,
# a prebid-server-java build (PBSJ_CP = its target/classes plus `mvn dependency:build-classpath`),
# Temurin 25 ($TEMURIN), GraalVM CE 25 JDK ($GRAAL), Maven. #3's payload generator output in $HEAVY.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=${OUT:-$here/out}; mkdir -p "$out"
export CARGO_TARGET_DIR=$out/target
(cd "$here/guest" && cargo build -q --release --target wasm32-unknown-unknown --lib)
cp "$out/target/wasm32-unknown-unknown/release/guest.wasm" "$out/guest.wasm"
(cd "$here/guest" && CARGO_PROFILE_RELEASE_OPT_LEVEL=s cargo build -q --release --target wasm32-unknown-unknown --lib)
cp "$out/target/wasm32-unknown-unknown/release/guest.wasm" "$out/guest-Os.wasm"
(cd "$here/guest" && cargo build -q --release --bin native && "$out/target/release/native" "$here/payload" lt heavy) > "$here/results/rust-native.txt"

cd "$here"
go run ./gen payload "$HEAVY"
go run ./hostgo -wasm "$out/guest.wasm" -par 1,4,8 -dur 2s > results/wazero.txt

(cd java && mvn -q dependency:build-classpath -Dmdep.outputFile="$out/jb-cp.txt")
CP="$PBSJ_CP:$(cat "$out/jb-cp.txt")"
"$TEMURIN/bin/javac" -proc:none -d "$out/jclasses" -cp "$CP" java/JBench.java
CP="$out/jclasses:$CP"
"$TEMURIN/bin/java" -cp "$CP" JBench payload "$out/guest.wasm" native 1 4 > results/java-native-temurin.txt
"$GRAAL/bin/java" -cp "$CP" JBench payload "$out/guest.wasm" native 1 4 > results/java-native-graalvm.txt
"$TEMURIN/bin/java" -cp "$CP" JBench payload "$out/guest.wasm" endive 1 4 > results/endive-O3.txt
"$TEMURIN/bin/java" -XX:-DontCompileHugeMethods -cp "$CP" JBench payload "$out/guest.wasm" endive 1 4 > results/endive-O3-hugemethods.txt
"$TEMURIN/bin/java" -cp "$CP" JBench payload "$out/guest-Os.wasm" endive 1 4 > results/endive-Os.txt
"$GRAAL/bin/java" -cp "$CP" JBench payload "$out/guest.wasm" graal 1 4 > results/graalwasm-O3.txt
