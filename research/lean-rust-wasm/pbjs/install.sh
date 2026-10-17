#!/bin/bash
# Copy the Form A (and Form B comparison) Prebid.js integration into a *scratch* Prebid.js clone.
# usage: install.sh <prebid.js clone> <imports-backend.wasm> <dom-backend.wasm>
# NB: library dir names must not share a prefix (webpack.conf.js cacheGroup test is a prefix match).
set -e
H=$(cd "$(dirname "$0")" && pwd); P=$1
mkdir -p "$P/libraries/sharedAdapter" "$P/libraries/wasmHandles" "$P/libraries/wasmBytes"
cp "$H/sharedAdapter.js" "$P/libraries/sharedAdapter/"
cp "$H/../js/glue-imports.js" "$P/libraries/wasmHandles/glue.js"
grep -v 'roundtrip' "$H/../js/glue-dom.js" > "$P/libraries/wasmBytes/glue.js"
T="$H/openxSharedBidAdapter.tmpl.js"
wasm() { # $1 module, $2 wasm, $3 glue lib
  python3 - "$T" "$P/modules/$1.js" "$2" "$3" <<'PY'
import sys, base64
t, out, wasm, lib = sys.argv[1:]
s = open(t).read()
s = s.replace('__LOGIC_IMPORT__', "import { wasmAdapter } from '../libraries/%s/glue.js';" % lib)
s = s.replace('__LOGIC__', "const LOAD = wasmAdapter('%s');" % base64.b64encode(open(wasm, 'rb').read()).decode())
open(out, 'w').write(s)
PY
}
wasm openxSharedBidAdapter "$2" wasmHandles
wasm openxSharedDomBidAdapter "$3" wasmBytes
# Form B comparison: same logic as plain JS in the module itself
python3 - "$T" "$P/modules/openxSharedJsBidAdapter.js" "$H/../js/openx-logic.js" <<'PY'
import sys
t, out, logic = sys.argv[1:]
s = open(t).read()
l = open(logic).read().replace('export function', 'function')
s = s.replace('__LOGIC_IMPORT__', '').replace('__LOGIC__', l + '\nconst LOAD = () => ({ makeRequests, makeBids, isValid });')
open(out, 'w').write(s)
PY
