#!/bin/bash
# PROTOTYPE: in-context gzip sizes in a real Prebid.js bundle. Concatenates built chunks the way
# `gulp bundle` does (core + each module's dependencies.json chunks); only the deltas matter.
# usage: pbjs/measure.sh <prebid.js clone with build/dist from: gulp build --modules=openxBidAdapter,openxSharedBidAdapter,pubmaticBidAdapter,pubmaticSharedBidAdapter>
set -e
D=$1/build/dist; O=$(mktemp -d)
CORE="prebid-core chunk-core buildOptions viewport fpdUtils creative-renderer-safe creative-renderer-display"
gz() { local out=$O/$1; shift; : > "$out"; for c in "$@"; do cat "$D/$c.js" >> "$out"; echo >> "$out"; done; gzip -9c "$out" | wc -c | tr -d ' '; }
core=$(gz core $CORE)
ortb=$(gz ortb $CORE ortbConverter)
ox=$(gz ox $CORE ortbConverter openxBidAdapter)
rt=$(gz rt $CORE ortbConverter prebidCore sharedAdapter)
oxs=$(gz oxs $CORE ortbConverter prebidCore sharedAdapter openxSharedBidAdapter)
pmdeps="ortbConverter percentInView dealUtils connectionInfo boundingClientRect"
pmbase=$(gz pmbase $CORE $pmdeps)
pm=$(gz pm $CORE $pmdeps pubmaticBidAdapter)
pms=$(gz pms $CORE ortbConverter prebidCore sharedAdapter pubmaticSharedBidAdapter)
both=$(gz both $CORE ortbConverter prebidCore sharedAdapter openxSharedBidAdapter pubmaticSharedBidAdapter)
rtonly=$(gz rtonly $CORE ortbConverter prebidCore)
echo "core (prebid-core + its chunks)              gz $core"
echo "+ ortbConverter                              Δ $((ortb-core))"
echo "Prebid Core one-time runtime (prebidCore + sharedAdapter glue), in context:  Δ $((rt-ortb))   [of which TS runtime $((rtonly-ortb)), glue $((rt-rtonly))]   budget ≤ 3072"
echo "OpenX Hand-written Adapter, in context:      Δ $((ox-ortb))"
echo "OpenX Shared Adapter module, in context:     Δ $((oxs-rt))   ($(( (oxs-rt)*100/(ox-ortb) ))% of Hand-written; budget ≤ 125%)"
echo "PubMatic Hand-written Adapter, in context:   Δ $((pm-pmbase)) (+ its own libraries: $((pmbase-ortb)))"
echo "PubMatic Shared Adapter module, in context:  Δ $((pms-rt))   ($(( (pms-rt)*100/(pm-pmbase) ))% of Hand-written; NOT like for like, see README)"
echo "Second Shared Adapter on top of OpenX (PubMatic), marginal: Δ $((both-oxs))"
sm=$(gz sm $CORE ortbConverter smaatoBidAdapter)
sms=$(gz sms $CORE ortbConverter prebidCore sharedAdapter smaatoSharedBidAdapter)
echo "Smaato Hand-written Adapter, in context:     Δ $((sm-ortb))"
echo "Smaato Shared Adapter module, in context:    Δ $((sms-rt))   ($(( (sms-rt)*100/(sm-ortb) ))% of Hand-written; NOT like for like, see README)"
for c in prebidCore sharedAdapter openxBidAdapter openxSharedBidAdapter pubmaticBidAdapter pubmaticSharedBidAdapter smaatoBidAdapter smaatoSharedBidAdapter; do printf "  chunk %-28s raw %6d gz %5d\n" $c $(wc -c < $D/$c.js) $(gzip -9c $D/$c.js | wc -c); done
