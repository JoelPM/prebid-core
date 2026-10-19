# PROTOTYPE: Can a Definition Compiler express OpenX and PubMatic within budget?

Throwaway prototype for [#14](https://github.com/JoelPM/prebid-core/issues/14) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)), testing Form D from [Which Prebid Core forms go to prototype?](https://github.com/JoelPM/prebid-core/issues/7). Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

| Measure (from #7) | OpenX | PubMatic |
|---|---|---|
| 1. `adapterstest` parity, generated TS **and** generated Rust/wasm | ✅ 10/10 | ✅ 23/23, 3 via pinned Known Differences |
| 2. Prebid.js runtime ≤ 3 KB gz (in context, real `gulp build`) | ✅ **1.07 KB** (703 B runtime + 365 B glue) | (shared) |
| 2. Adapter ≤ Hand-written +25% gz | ✅ **107%** (1,257 vs 1,167 B) | ~~27%~~ not like for like (see below) |
| 3. PBS-Go / wazero ≤ ~+10 µs per call, `lt` payload | ✅ **+9.1 µs** (+11 µs CPU under 1–8 goroutines) | ❌ **+20.9 µs** (+24–28 µs CPU) |
| 3. same, `heavy` payload | ❌ +19.6 µs | ❌ +34.4 µs |
| 4. Escape hatch ≤ ~20% of translation logic | ✅ 9% of rules (lenient) / 27% (strict) | ❌ **45–48% of rules, 62–64% of expression nodes** |
| Switch: expression language needs loops / functions / mutable state | none needed | **bounded comprehensions** (`map`/`filter`, 11 uses); no functions, no mutable state |
| Switch: TS and Rust disagree on a fixture | identical output on all 33 fixtures — after pinning 7 JS semantics into the Rust runtime (below) | |

**Reading:** OpenX is what Form D was made for: a page of mappings, inside every budget on `lt`. PubMatic trips the E′ switch on the escape-hatch criterion by a wide margin, and arguably on "loops". It is about half string parsing, key/value building and list comprehensions, and the expression language had to grow into a small functional language (lets, templates, 23 builtins, three comprehension macros) to say it. The server overhead misses are a separate problem from the language. They come from the generic dynamic runtime the generated code calls, not from wasm or the ABI (see "Where the server time goes").

## What was built

```
defs/                     Adapter Definitions (YAML + JSON Schema) and Known Differences
  openx.yaml  pubmatic.yaml  *.params.json (PBS-Go's bidder-params)  definition.schema.json  known-differences.yaml
compiler/                 the Definition Compiler (Node)
  el.js       expression language: parser, classifier (mapping vs escape hatch)
  def.js      loads a Definition, builds core+Client Extension and core+Server Extension models,
              enforces Extension rules (no deletes, no `keep`, no errors; add-only at runtime)
  emit-ts.js  TS back end        emit-rs.js  Rust back end        stats.js  measure 4
runtime/ts/core.ts        Prebid Core runtime, TS (~1 KB gz)
runtime/rs/               Prebid Core runtime, Rust: arena over the input bytes, JS semantics
gen/                      generated code, committed for reading: gen/ts/<bidder>.<side>.ts, gen/rs/<bidder>_<side>.rs
guest/                    wasm guest: generated Rust behind a framed ABI, one module per Adapter
hostgo/                   PBS-Go Host binding (host/shared.go) + tools: golden, sharedout, bench, adapterstest test
harness/parity.mjs        parity harness (TS directly; Rust via hostgo/cmd/sharedout)
pbjs/                     Prebid.js Host glue (sharedAdapter.ts), installer, bundle measurement
run.sh                    rebuilds everything and reruns every number in this file
results/                  raw output of the measured run
```

### The Definition format

YAML, one file per Adapter. Every value is an expression in a small language (EL). Expressions **read the input**, and `set` rules **write the output** in order. `~` deletes a field, and `keep` leaves it as it is. Phases:

- **imp**: once per imp (`imp`, `p` = `imp.ext.bidder`, `req`), with `let`, `check` ([condition, message]: reject the imp with an error) and `set`.
- **request**: once per request, after the imps (`req`, `imps`, `params` = accepted imps' params), with `let` and `set`.
- **bid**: once per bid (`bid`, `imp` = the request imp it answers, looked up only if a rule reads it, `resp`). It has `let`, `check` (drop the bid with an error), `warn` (record an error, keep the bid), `set` (overrides on the bid), and the fields `type`, `seat`, `dealPriority`, `video` and `meta`.
- **response**: `currency`, `paapi`.

`client:` and `server:` hold the Extensions. They may only add: `set` rules never overwrite what core produced (enforced at runtime), there are no deletes, and an Extension may add `drop` rules and an `endpoint`. OpenX's Client Extension adds `imp.ext.divid`, `ext.bc`, `at`, `device.dnt`, `regs.coppa` and `test`. Its Server Extension adds `ext.bc`.

The EL in brief: paths (`imp.ext.bidder.unit`, `at[0]`), literals, `??` `||` `&&` `!` `==` `!=` `<` `>` and `?:` with JavaScript truthiness, object and array literals (`[...a]`), lookup tables (`{1: 'banner'}[bid.mtype]`), templates, builtins (`str num int trim lower split join contains len max keys entries fromEntries type json stringify nonempty without merge first`), and the CEL-style macros `list.map(x, e)`, `list.filter(x, e)` and `list.some(x, e)`. There is no assignment, no user-defined functions and no recursion. Every expression is total, so a missing path is absent and never an error.

### How each side runs

- **Prebid.js**: generated TS on plain JS objects. The Host glue builds ORTB with `ortbConverter`, puts params in `imp.ext.bidder`, runs the Shared Adapter's ORTB→ORTB edits, and feeds its bids back through `fromORTB`. It builds and type-checks in `gulp build`. *Not exercised in a browser or in Prebid.js's unit tests.*
- **PBS-Go**: generated Rust compiled to wasm, run under wazero with a `sync.Pool` of instances. The ABI is research/typed-rust-guest's variant D: the Host marshals the request and parses the bid response itself, and the guest returns the body bytes plus framed per-bid annotations (type, seat, deal priority, video/meta as key/value frames, and JSON overrides for changed bid fields).
- **Runtime design (Rust)**: an arena of nodes over one buffer that starts as the input. Strings stay escaped, untouched containers are re-emitted with one `memcpy` of their input span, the output root is owned and mutated in place, and nested writes are copy-on-write. This is not generated typed structs (see below).

## Measure 1: parity

`harness/parity.mjs` checks each Shared Adapter on all 33 OpenX and PubMatic `adapterstest` fixtures. It compares against the fixture's expectations the way `adapterstest` does, and against the **Hand-written PBS-Go Adapter's full output** on the same input (`hostgo/cmd/golden`), which also covers meta and deal priority (`adapterstest` ignores both). Any difference must be a Known Difference whose pinned value matches. Separately, PBS-Go's own `adapterstest.RunSingleJSONBidderTest` runs against the wasm Shared Adapters (`hostgo/host/adapterstest_test.go`). It passes 30/33 and fails exactly the three Known Difference fixtures, data-race check included.

Known Differences (all PubMatic, [`defs/known-differences.yaml`](defs/known-differences.yaml)):

| fixture | kind | difference |
|---|---|---|
| `exemplary/fledge.json` | drift | The Host binding fills PAAPI `bidder` for every Shared Adapter. Go OpenX does; Go PubMatic doesn't. The exchange copies it to `adapter`. |
| `exemplary/native.json` | drift | Native `adm` is re-serialized canonically (no `\/` escapes), as PBS-Java's PubmaticBidder does. Go copies raw bytes. Same JSON, different string. |
| `supplemental/app.json` | bug | A bid without `ext` is valid. Go reports a jsoniter error for it. |

OpenX's three drift Known Differences from #8 (first imp's `delDomain`, error on unsupported imps, `imp.rwdd` only) don't show up in any PBS-Go fixture, so they are listed but not pinned.

The harness is sensitive: changing `join(k.value, ',')` to `';'` in `pubmatic.yaml` fails 16 fixtures on both back ends.

## Measure 2: Prebid.js bundle (in context, gzip -9, real `gulp build`)

| | Δ gz |
|---|---:|
| Prebid Core runtime + glue (one-time) | **1,068 B** (runtime 703, glue 365) |
| OpenX Hand-written module | 1,167 B |
| OpenX Shared module (generated TS + metadata + verbatim `getUserSyncs`) | **1,257 B (107%)** |
| PubMatic Hand-written module (+2,037 B of its own libraries) | 5,909 B |
| PubMatic Shared module | 1,633 B |

The PubMatic row is **not like for like**. Prebid.js's PubMatic carries browser-only logic this Definition doesn't have (renderer, gzip, per-media-type TTL, floor granularity, `onBidWon` CPM adjustment, imp optimization), and its `getUserSyncs` depends on module state set in `buildRequests`. That makes it the "browser contract differs" case from #9. The number only says the PBS-Go-shaped translation is small in TS.

## Measure 3: PBS-Go under wazero (Apple M5 Max, macOS arm64, Go 1.27.2, wazero 1.12.0)

Method as in research/typed-rust-guest: MakeRequests then MakeBids on the same `*openrtb2.BidRequest`, a pooled instance, median of 5. Before timing, the Shared Adapter's body and every TypedBid (incl. meta/video/seat) are checked equal to the Hand-written Adapter's. Raw output: [`results/wazero.txt`](results/wazero.txt).

| µs per call | native | Shared | overhead | CPU overhead at 1 / 4 / 8 goroutines |
|---|---:|---:|---:|---|
| OpenX `lt` | 22.5 | 31.6 | **+9.1** | +11.2 / +11.5 / +11.1 |
| OpenX `heavy` | 42.7 | 62.3 | +19.6 | |
| PubMatic `lt` | 24.3 | 45.2 | **+20.9** | +24.4 / +26.1 / +28.0 |
| PubMatic `heavy` | 37.9 | 72.3 | +34.4 | |

For comparison, research/typed-rust-guest's hand-written typed OpenX guest (same ABI) added +7.2 µs on `lt` and +6.4 on `heavy`.

### Where the server time goes

The Host's own work (marshal the request 5.5–11.1 µs, parse the response 11.8–22.9 µs) is the same work the Hand-written Adapter does, so the overhead is the guest:

| guest, µs | native Rust | wasm (wazero) | wasm ÷ native |
|---|---:|---:|---:|
| OpenX `lt` (mr + mb) | 2.3 + 3.2 | 11.8 | 2.2× |
| PubMatic `lt` | 6.7 + 3.7 | 22.8 | 2.2× |

Typed-rust-guest saw ~1.7× for wasm over native. The generated code is allocation-heavy (node arena, `String`s for string ops, list building), which costs more under wasm's allocator. A profile of PubMatic's `make_requests` shows ~20% parsing the request, ~14% emitting the body, ~20% the keywords → `fromEntries` → `merge` pipeline for `imp.ext`, and most of the rest in key lookups and copies. These are generic-runtime costs.

What it would take: **typed codegen**. Infer types from the params JSON Schema and OpenRTB, keep string-typed expressions in Rust `String`s/`&str` instead of arena nodes, fuse `filter`/`map`/`fromEntries`, and hoist literal and key interning. The prototype applied only runtime-level fixes, in order of gain: one-pass eager parse instead of nested lazy re-scans (14 → 4.4 µs for OpenX MB native), a lazy `imp` lookup in MakeBids, an owned root, allocation-free list walks, faster key compares, and key/value frames instead of `jsonutil` for video/meta.

## Measure 4: Definition and escape-hatch size

`node compiler/stats.js defs/*.yaml`. A *rule* is one let / check / warn / set / bid field / response field.

| | rules | escape hatch (strict) | escape hatch (lenient: `x > 0` counts as declarative) | Definition lines | PBS-Go | PBS-Java | Prebid.js |
|---|---:|---|---|---:|---:|---:|---:|
| OpenX | 11 | 3 (27%), 48% of nodes | 1 (9%), 8% of nodes | 48 | 256 | 238 | 193 |
| PubMatic | 44 | 21 (48%), 64% of nodes | 20 (45%), 62% of nodes | 83 | 571 | 559 | 772 |

PubMatic's escape-hatch rules are `adSlot` parsing (`split`/`trim`/`int`, 6 lets + 4 checks), keywords → `imp.ext` (`filter`/`map`/`fromEntries`/`join`), the `imp.ext.data` → `key_val` builder (`entries`/`filter`/`map`/`type`/template), the publisher and wrapper fold across imps (`first(params.map(...))`), alternate bidder codes (spread), `cat` truncation, and native `adm` re-serialization (`json`/`stringify`).

## Semantics that had to be pinned

The TS and Rust outputs are identical on every fixture, but only because the Rust runtime reproduces these JavaScript behaviors exactly:

1. Duplicate object keys read as the last value (JSON.parse).
2. `entries`/`keys` list integer-like keys first, ascending (JS property order).
3. JS assignment order: setting an existing key keeps its position.
4. `trim` uses JS's whitespace set (includes U+FEFF, excludes U+0085). Rust's `char::is_whitespace` differs.
5. Numbers compute as f64 and print like `String(n)` (via `ryu-js`). Non-finite becomes `null` in JSON.
6. `stringify` is canonical JSON.stringify, including lone-surrogate escapes. This was found by the native-adm fixture: raw-span copying kept `\/` where TS didn't.
7. `json()` is strict, like JSON.parse. Rust validates before parsing.

One known gap can't be pinned on the TS side: integers beyond 2^53 lose precision in Prebid.js (JS numbers). Raw pass-through keeps them exact in Rust. No fixture hits it. Prebid.js has the same limit today.

## Caveats

- One machine (macOS arm64). Not rerun on x86-64 Linux.
- Prebid.js: build and type-check only. The client path wasn't run against Prebid.js's specs or in a browser.
- Error texts that come from Go's JSON decoder (`invalidparam`, wrapper parse errors) aren't reproduced. The Shared Adapter relies on the params schema instead.
- Go's random map order (PubMatic `imp.ext.data` → `key_val`) means the Hand-written Adapter is nondeterministic for multi-key data. The Shared Adapter uses input order.
- Only OpenX and PubMatic, and only the server side's fixtures. Smaato (request-shape and header logic) is deferred, per #7.
