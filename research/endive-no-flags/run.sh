#!/usr/bin/env bash
# Reruns every measurement in ../endive-no-flags.md. Run build-guests.sh first.
# Needs: Temurin 25 ($TEMURIN), Maven, a prebid-server-java build (PBSJ_CP = its target/classes plus
# `mvn dependency:build-classpath`), and Endive main installed as 999-SNAPSHOT
# (`./mvnw -Dquickly -Ddev install -pl compiler-maven-plugin,redline/runner,runtime,compiler -am`).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); trg=$here/../typed-rust-guest
out=${OUT:-$here/out}; res=$here/results; secs=${SECS:-2}
cd "$here/module"
for v in O3 O3-split; do
  mvn -q -B package -Dendive.version=999-SNAPSHOT -Dwasm="$out/$v.wasm" -Dmodname="bench.S_${v//-/_}" -DbuildDir="$out/snap-$v"
done
mvn -q -B dependency:build-classpath -Dwasm=x -Dmodname=x -Dmdep.outputFile="$out/mod-cp.txt"
mvn -q -B dependency:build-classpath -Dwasm=x -Dmodname=x -Dendive.version=999-SNAPSHOT -Dmdep.outputFile="$out/snap-cp.txt"
(cd "$trg/java" && mvn -q dependency:build-classpath -Dmdep.outputFile="$out/jb-cp.txt")
# JBench's own deps minus Endive 1.1.0, so each run picks one Endive version.
jb=$(tr ':' '\n' < "$out/jb-cp.txt" | grep -v '/run/endive/' | paste -sd: -)
base="$PBSJ_CP:$jb"
"$TEMURIN/bin/javac" -proc:none -nowarn -d "$out/jclasses" -cp "$base:$(cat "$out/mod-cp.txt")" "$trg/java/JBench.java" "$here/java/EBench.java"
mods=$(for d in "$out"/mod-*/classes; do printf '%s:' "$d"; done)
rel="$out/jclasses:$mods$base:$(cat "$out/mod-cp.txt")"
snap="$out/jclasses:$out/snap-O3/classes:$out/snap-O3-split/classes:$base:$(cat "$out/snap-cp.txt")"
j() { "$TEMURIN/bin/java" --enable-native-access=ALL-UNNAMED "$@"; }
cd "$trg"
j -cp "$rel" EBench payload native "$secs" 4 > "$res/native.txt"
j -cp "$rel" EBench payload "runtime:$out/O3.wasm" "$secs" 4 > "$res/runtime-O3.txt"
j -XX:-DontCompileHugeMethods -cp "$rel" EBench payload "runtime:$out/O3.wasm" "$secs" 4 > "$res/runtime-O3-hugemethods.txt"
for v in O3 Os O2 O3-inl50 O3-split O2-split O3-split-wasmopt O3-outlined; do
  j -cp "$rel" EBench payload "bytecode:bench.G_${v//-/_}" "$secs" 4 > "$res/bytecode-$v.txt"
done
j -XX:-DontCompileHugeMethods -cp "$rel" EBench payload bytecode:bench.G_O3_split "$secs" 4 > "$res/bytecode-O3-split-hugemethods.txt"
j -cp "$rel" EBench payload redline:bench.G_O3 "$secs" 4 > "$res/redline-1.1.0-O3.txt"
j -cp "$snap" EBench payload bytecode:bench.S_O3_split "$secs" 4 > "$res/snapshot-bytecode-O3-split.txt"
j -cp "$snap" EBench payload redline:bench.S_O3 "$secs" 4 > "$res/snapshot-redline-O3.txt"
j -cp "$snap" EBench payload redline:bench.S_O3_split "$secs" 4 > "$res/snapshot-redline-O3-split.txt"
