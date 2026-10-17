#!/bin/bash
# Concatenate built Prebid.js chunks the way `gulp bundle` does and report in-context sizes.
# usage: measure.sh <prebid.js clone with build/dist> <out dir>
set -e
H=$(cd "$(dirname "$0")/.." && pwd); D=$1/build/dist; O=$2; mkdir -p "$O"
CORE="prebid-core chunk-core buildOptions viewport fpdUtils creative-renderer-safe creative-renderer-display"
cat_() { local out=$1; shift; : > "$out"; for c in "$@"; do cat "$D/$c.js" >> "$out"; echo >> "$out"; done; }
cat_ "$O/core.js" $CORE
cat_ "$O/ortb.js" $CORE ortbConverter
cat_ "$O/ortb+openx.js" $CORE ortbConverter openxBidAdapter
cat_ "$O/ortb+rt.js" $CORE ortbConverter sharedAdapter
cat_ "$O/ortb+rt+openxJs.js" $CORE ortbConverter sharedAdapter openxSharedJsBidAdapter
cat_ "$O/ortb+rt+handles.js" $CORE ortbConverter sharedAdapter wasmHandles
cat_ "$O/ortb+rt+handles+openxWasm.js" $CORE ortbConverter sharedAdapter wasmHandles openxSharedBidAdapter
cat_ "$O/ortb+rt+bytes.js" $CORE ortbConverter sharedAdapter wasmBytes
cat_ "$O/ortb+rt+bytes+openxWasmDom.js" $CORE ortbConverter sharedAdapter wasmBytes openxSharedDomBidAdapter
for f in core ortb ortb+openx ortb+rt ortb+rt+openxJs ortb+rt+handles ortb+rt+handles+openxWasm ortb+rt+bytes ortb+rt+bytes+openxWasmDom; do
  bash "$H/sz.sh" "$O/$f.js" "$f"
done
for c in openxBidAdapter sharedAdapter wasmHandles wasmBytes openxSharedJsBidAdapter openxSharedBidAdapter openxSharedDomBidAdapter; do bash "$H/sz.sh" "$D/$c.js" "chunk $c"; done
