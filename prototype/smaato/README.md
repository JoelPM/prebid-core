# PROTOTYPE: Can Restricted TypeScript transpiled to Rust express OpenX and PubMatic within budget?

Throwaway prototype for [#15](https://github.com/JoelPM/prebid-core/issues/15) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)), testing Form E′ after [Can a Definition Compiler express OpenX and PubMatic within budget?](https://github.com/JoelPM/prebid-core/issues/14) switched to it. It reuses that prototype's Rust runtime, wasm guest ABI, PBS-Go Host binding, parity harness and bundle measurement ([`../profile-compiler`](../profile-compiler/README.md)). Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

| Measure (from #15) | OpenX | PubMatic |
|---|---|---|
| Parity on `adapterstest`: TS as written **and** transpiled Rust/wasm, vs fixtures and the Hand-written Adapter's full output | ✅ 10/10 | ✅ 23/23, 3 via the same pinned Known Differences |
| TS vs Rust, the 33 fixtures | identical | identical |
| TS vs Rust, differential fuzz (77k calls on mutated fixture inputs) | ✅ 0 differences in 38,740 calls | ✅ 0 differences in 38,323 calls |
| Prebid.js runtime ≤ 3 KB gz (in context, real `gulp build`) | ✅ **1.10 KB** (753 B Prebid Core + 350 B glue) | (shared) |
| Prebid.js Adapter ≤ Hand-written +25% gz | ✅ **92%** (1,079 vs 1,167 B). The D prototype was 107%. | not like for like (browser contract differs, #9) |
| Subset: every TS/Rust difference pinned in the runtime or rejected | ✅ 12 pinned semantics (7 inherited, 5 new). 35/35 rejection cases. Both Adapters needed no escape hatch. | |
| *(not this ticket)* PBS-Go/wazero overhead, `lt` | +13.0 µs (D: +9.1) | +32.0 µs (D: +20.9) |

**Reading:** E′ works. Both Adapters are written once as plain, typed TypeScript functions, with no escape hatch, no expression language and no `any`. The same source runs in Prebid.js as written and, transpiled, in PBS-Go. It reaches parity on every fixture through both, and TS and Rust agree on every input the fuzz produced. PubMatic, which broke Form D (45–48% escape hatch), is ordinary code here: string parsing in `let`s, `filter`/`map`/`fromEntries`, and one module-level helper. Prebid.js is smaller than with the YAML Definitions. Server overhead got *worse*, because restricted TS emitted against the generic dynamic runtime does more copying than D's narrow rules did. That is the typed back end's job, sized by [Can typed codegen bring a generated PubMatic within ~+10 µs per call on PBS-Go?](https://github.com/JoelPM/prebid-core/issues/16).

## What was built

```
adapters/        the Adapter Definitions: openx.ts, pubmatic.ts (+ params types, hand-written from defs/*.params.json)
core/            Prebid Core, TS Implementation: ortb.ts (OpenRTB + Prebid ext types), index.ts (helpers,
                 defineAdapter, and build(): the driver that runs a Definition's Phases for one side)
transpiler/      the Definition Compiler: transpile.mjs (TS compiler API front end, subset checker, Rust back
                 end), cli.mjs, rejects.test.mjs (35 subset cases)
SUBSET.md        Restricted TypeScript as prototyped: allowed, rejected and why, pinned semantics
runtime/rs/      the D prototype's Rust runtime, plus src/js.rs (JS-exact builtins the transpiled code calls)
gen/rs/          generated Rust, committed for reading
guest/           wasm guest (unchanged ABI); src/bin/fuzz.rs runs the generated Rust natively for the fuzz
hostgo/ harness/ pbjs/   reused; parity.mjs now runs adapters/*.ts as written; harness/fuzz.mjs is new
run.sh           rebuilds everything and reruns every number here (PBJS=<scratch Prebid.js clone> for sizes)
results/         raw output of the measured run
```

### What an Adapter Definition looks like

See [`adapters/openx.ts`](adapters/openx.ts) and [`adapters/pubmatic.ts`](adapters/pubmatic.ts). The four Phases are functions. The `imp` and `bid` Phases may `return reject(message)`. Extensions return add-only patches (`server: { request: () => ({ ext: { bc: 'hb_pbs_1.0.0' } }) }`).

| | non-blank, non-comment lines | PBS-Go | PBS-Java | Prebid.js |
|---|---:|---:|---:|---:|
| OpenX | 62 (YAML Definition: 48) | 256 | 238 | 193 |
| PubMatic | 134 (YAML Definition: 83) | 571 | 559 | 772 |

The TS is longer than the YAML but reads as ordinary code, and every value is typed. PubMatic's adSlot parsing type-checks down to its `?.` chains.

Decisions taken while charting the subset (HITL, this session):

- **Mutation:** only locals the function created. Inputs and parameters are read-only.
- **Extensions:** patches applied add-only, so the rule holds by construction.
- **Coercion:** only through Core `str` / `num` / `int`. JS coercions are rejected.
- **This prototype's Rust:** reuses the dynamic runtime. Typed codegen is #16.

### Writing it surfaced

- **Typing open data is the main friction.** `imp.ext.data`, `bidderparams` and `adserver` are `Json`, so authors narrow with `obj(...)`, `typeof` or `Array.isArray`. It's correct, and a few lines longer than `any`-style code.
- **Spread then nested write is a real trap.** `out.banner.w = 1` after `{ ...imp }` mutates the input in JS. The subset rejects it, and authors write `out.banner = { ...banner, w }`. PubMatic needed this twice.
- **Intended behavior got sharper.** For `imp.ext.data` values that aren't strings, numbers, booleans or string arrays, the Hand-written Go Adapter writes a stray `||`. The Definition skips them, and no fixture is affected. The YAML runtime would have printed `k=` instead.
- **`isValid` duplicates the params schema.** Definitions declare `required: { all, anyOf }`, and params types are hand-written. Both should be generated from the schema.

## Parity

`node harness/parity.mjs <pbs>` runs the Definitions *as written* through `build(def, 'server')`. `--rs out/rs` checks the transpiled Rust running under wazero through the PBS-Go Host binding. Each is compared with the fixture expectations, with the Hand-written Adapter's full output (meta and deal priority included), and with each other. Result: 33/33 for both, with the same three Known Differences as #14 (PubMatic: the PAAPI `bidder` field, canonical native `adm`, a bid without `ext`). TS and Rust were identical on every fixture. PBS-Go's own `adapterstest` on the wasm guest passes 30/33 and fails exactly the three Known Difference fixtures.

Sensitivity: changing the Server Extension's `ext.bc` makes 10 fixtures fail.

## Semantics

**Fuzz** (`harness/fuzz.mjs`, [`results/fuzz.txt`](results/fuzz.txt)): 20k mutated requests per bidder, plus bid responses, seeded from the fixtures. Typed fields get values of their declared type: edge strings (` `, `﻿`, `U+0085`, emoji, `' 12 '`), `-0`, `1e21` and missing fields. Open `Json` fields get arbitrary nested JSON. TS (as written) and the transpiled Rust (native) were compared after normalizing only representation (bid overrides re-applied, empty slots). The fuzz reached 34k request bodies, 9.7k rejected imps, 52k kept and 6.9k rejected bids, 720 warnings, 12k PAAPI responses and 14k bids with meta. It found **0 differences**, and the TS threw 0 times.

Sensitivity: removing lowercasing from the runtime's `toLowerCase` shows up as 36 differing calls. Two other planted runtime bugs, `join` printing `null` and `split` trimming parts, went unnoticed, because neither Adapter can observe them: both filter before `join` and trim after `split`. **The fuzz verifies the paths these Adapters use, not the runtime in general.** The runtime needs its own conformance suite (Test262-style) before any Adapter relies on paths no Adapter has exercised.

**Pinned or rejected:** see [`SUBSET.md`](SUBSET.md). The D runtime's seven pinned behaviors were still needed. Writing JS-exact Rust for the new constructs added five more. The notable one: JS keeps `undefined` inside arrays, and the D runtime dropped it, so it now has a real `undefined` node. Three things can't be pinned cheaply and are rejected instead: aliasing (writes after escape, nested writes through a shallow copy), `Object.keys` on locally built objects with undefined members, and JS coercions. Known residual differences: integers above 2^53 in TS, and the key order of a deleted-then-reassigned member (JSON-equal, not byte-equal).

## Prebid.js

`node pbjs/install.mjs <scratch clone>` copies the Definition files verbatim into `modules/<bidder>SharedBidAdapter.ts`. Only import paths are rewritten, plus a footer that registers `build(def, 'client')` through the D prototype's `ortbConverter` glue. Then it runs `gulp build`, which also runs Prebid.js's own `tsc`. Raw output: [`results/pbjs.txt`](results/pbjs.txt) (Prebid.js 43a96fbee).

| gz bytes, in context | this prototype | D prototype (#14) | budget |
|---|---:|---:|---:|
| Prebid Core runtime + glue (one-time) | 1,103 | 1,068 | ≤ 3,072 |
| OpenX Shared Adapter module | 1,079 (92%) | 1,257 (107%) | ≤ 1,459 (125%) |
| PubMatic Shared Adapter module | 1,513 | 1,633 | (not like for like) |

The Definition modules shrink because hand-written TS minifies better than generated runtime calls. The Server Extension's code also ships to the browser (a few dozen bytes for OpenX). Stripping it is part of the open bundling question.

## Server overhead (for #16, not this ticket)

[`results/wazero.txt`](results/wazero.txt) and [`results/native.txt`](results/native.txt). Same method and machine class as #14. Pooled instance, and correctness is checked against the Hand-written Adapter before timing.

| µs per call | overhead | CPU overhead at 1 / 4 / 8 goroutines | D prototype |
|---|---:|---|---:|
| OpenX `lt` | +13.0 | +15.0 / +15.5 / +15.2 | +9.1 |
| OpenX `heavy` | +24.4 | | +19.6 |
| PubMatic `lt` | +32.0 | +35.0 / +37.2 / +40.2 | +20.9 |
| PubMatic `heavy` | +49.5 | | +34.4 |

Transpiling general TS to the generic runtime costs 1.4–1.5× D's emitted rules. There are three causes:

- Every spread copies the object (`d.own`).
- Phase results are objects the driver reads back.
- Bid overrides are found by diffing the returned bid against the input, through JSON.

D emitted path-sets straight into an owned root and override slots directly. These are exactly the patterns #16's typed back end has to recognize ("copy with overrides"). They are now requirements for it.

## Caveats

- One machine (macOS arm64). Not rerun on x86-64 Linux.
- Prebid.js: build and type-check only, as in #14. The client path wasn't run against Prebid.js's specs or in a browser.
- Only OpenX and PubMatic, and only the server side's fixtures. Smaato is still deferred.
- The subset is what these two Adapters needed. Wider Adapters will add constructs (arithmetic on strings, array `.includes`, closures), and each needs pinning or rejecting.
- The escape check for writes is by source order. Inside `for..of` bodies it is approximate.
- Params types and `required` are hand-written, and should be generated from the params schema.
