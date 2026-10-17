#!/usr/bin/env bash
# Usage: run-sweep.sh <label> <server-pid> [rps...]
# Assumes the stub (port 9000) and the PBS under test (port 8000) are already running.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
label=$1; pid=$2; shift 2
LOADGEN=${LOADGEN:-loadgen}
WARMUP=${WARMUP:-20s}; DUR=${DUR:-30s}
for rps in "${@:-500}"; do
  for n in 1 3 5 10; do
    "$LOADGEN" -pid "$pid" -rps "$rps" -warmup "$WARMUP" -dur "$DUR" \
      -body "$here/requests/auction-$n.json" -label "$label bidders=$n"
  done
done
