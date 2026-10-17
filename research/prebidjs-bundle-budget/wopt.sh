#!/bin/bash
exec ${WASM_OPT:-wasm-opt} -Oz --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types --enable-multivalue --enable-mutable-globals --strip-debug --strip-producers "$1" -o "$2"
