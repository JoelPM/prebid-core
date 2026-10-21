# PROTOTYPE: Can the Definition Compiler emit typed Rust that keeps OpenX and PubMatic within ~+10 µs per call?

Throwaway prototype for [#17](https://github.com/JoelPM/prebid-core/issues/17) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It builds on [`prototype/ts-transpiler`](https://github.com/JoelPM/prebid-core/tree/prototype/ts-transpiler/prototype/ts-transpiler): the same Adapter Definitions, front end, subset checker, parity harness and fuzz, copied here. It measures against the hand-written floor from [Can typed codegen bring a generated PubMatic within ~+10 µs per call on PBS-Go?](https://github.com/JoelPM/prebid-core/issues/16) (`research/typed-codegen`, copied into `typed-ref/`). Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

**Partly.** The Definition Compiler generates typed Rust from the unchanged Restricted TypeScript Definitions, with parity and JS semantics exact. It gets OpenX, the Proof of Concept's Adapter, to the ~+10 µs gate. But it does not get within 15% of the hand-written floor: it is 1.42× (OpenX) and 1.67× (PubMatic) of it.

Guest-only time in wasm (PBS-Go / wazero), `lt` payloads. All guests were measured in one session on a quiet machine; raw output is in [`results/bench-level1-r2.txt`](results/bench-level1-r2.txt), [`results/bench-level1.txt`](results/bench-level1.txt) and [`results/bench-level0.txt`](results/bench-level0.txt).

| guest | OpenX `lt` | ÷ floor | PubMatic `lt` | ÷ floor |
|---|---:|---:|---:|---:|
| hand-written typed (floor, #16), bump allocator | **7.04 µs** | 1.00 | **10.36 µs** | 1.00 |
| transpiled TS on the generic runtime (#15) | 15.09 | 2.1 | 33.52 | 3.2 |
| Level 0 typed back end | 14.21 | 1.9 | 28.63 | 2.75 |
| Level 1 typed back end | 10.87 | 1.54 | 19.39 | 1.87 |
| Level 1 + per-call bump allocator | **10.01** | **1.42** | **17.28** | **1.67** |

| per call vs the Hand-written Adapter, Level 1 + bump | overhead | process CPU at 1 / 2 / 4 / 8 goroutines | gate |
|---|---:|---|---|
| OpenX `lt` | **+8.8 µs** | +9.9 / +9.9 / +10.2 / +9.2 | ✅ at ~+10 |
| OpenX `heavy` | +11.9 µs | | ❌ just over |
| PubMatic `lt` | +16.7 µs | +18.7 / +18.6 / +19.9 / +21.2 | ❌ |
| PubMatic `heavy` | +25.5 µs | | ❌ |
| *floor, for comparison: OpenX / PubMatic `lt`* | *+5.0 / +9.1* | *+6.2 / … / +5.9; +11.6 / … / +13.2* | |

Correctness held at every step, for every guest:

- **Parity:** 33/33 fixtures, with the same 3 pinned Known Differences, against both the fixtures and the Hand-written Adapter's full output.
- **TS vs Rust:** identical to the TS as written on every fixture.
- **PBS-Go's own `adapterstest`:** 30/33, failing exactly the three Known Difference fixtures.
- **Differential fuzz:** 0 differences in 77,063 calls. The fuzz now also uses lone surrogates, broken pairs and emoji, which the new runtime handles per [What happens to a lone UTF-16 surrogate on its way to a Shared Adapter?](https://github.com/JoelPM/prebid-core/issues/23).

**Reading:**

- **The hard analysis is tractable.** Restricted TypeScript's rules (fresh locals, one-level writes, read-only inputs) make "which input paths does a Phase read" and "which locals are copy-with-overrides" decidable from the source. The compiler found every read on the bench payloads: no shape misses on `lt`.
- **The remaining gap is spread thinly** over the generated code's value model, not concentrated in one pattern (see "Where the gap is").
- **Gains are shrinking:** each of the last rounds gave 5–20%.
- **The ABI is now the bigger lever.** #16 found that 50–70% of the floor's own time is re-scanning JSON the Host already parsed. In this prototype, the scanner (`skip`) is the single largest cost of generated OpenX too.

## What was built

```
transpiler/typed.mjs     Level 0 typed back end: shape analysis + spread-plus-overrides over rt2 values
transpiler/typed1.mjs    Level 1: views (a struct per shape node), member arena, plans; Level 0 as fallback
transpiler/cli-typed*.mjs  -> gen/rs-typed/, gen/rs-typed1/ (generated Rust, committed for reading)
runtime/rt2/             runtime for both: span values, JS strings (UTF-16 code units), shapes, views,
                         arena, plans, frames; JS semantics as in SUBSET.md, plus #23's string contract
guest-typed/ guest-typed1/  wasm guests (same ABI as guest/ and typed-ref/); bin/fuzz, bin/native
typed-ref/               the hand-written floor (#16), unchanged but for the crate name
harness/fuzz.mjs         now with lone surrogates; FUZZ_BIN picks the guest; Host string slots compared
                         as the ABI carries them (see "ABI details")
run.sh                   rebuilds and reruns everything here; results/ has the measured run
```

The front end and the subset rules are unchanged: same Definitions, same 35 rejection cases. Both back ends compile both Adapters with no hand-written code per Adapter.

### Level 0: shapes and spread-plus-overrides

1. **Shape analysis.** For each Phase, the compiler collects the input paths it reads. It follows aliases (`const banner = imp.banner`), callbacks (`p.keywords.filter(k => k.value…)`), `Object.entries(x).filter(...).map(([k, v]) => …)`, the `params` list (each element is `imp.ext.bidder`), and module helpers, interprocedurally. The result is a static shape per input document (request, response, outgoing request). Decoding indexes exactly those paths in one scan, and everything else stays a span.
2. **Values are spans, not arena nodes.** Strings stay escaped spans until read, numbers keep their input text (exact pass-through, parsed on first use), and untouched containers stay raw. Indexed objects remember their span, so emitting them unchanged is one copy.
3. **Spread-plus-overrides.** Keys are interned as pre-escaped byte strings. The outgoing request in MakeBids is decoded only if a bid Phase reads its imp.

Result: 1.9× / 2.75× the floor, barely better than the generic runtime. Profiling showed why. Every indexed object was a heap vector of members with linear key lookups (plus quadratic duplicate detection, removed), and output was a tree built and then emitted.

### Level 1: views, member arena, plans

1. **Views.** Every shape node compiles to a Rust struct with one field per key read: a leaf value, an array of leaves, a list of structs, or a nested struct. Its decoder is a single `match` on key bytes, filling the struct in place. `imp.ext.bidder.unit` compiles to a field access.
2. **Member arena.** Objects a Phase copies (spread, `without`, `Object.entries`) also record their members in one vector per call: spans plus links, with nested copy sources linked from their parent member. Copying never re-scans and allocates nothing per object.
3. **Plans.** A fresh local built by spreading a view (`const out = { ...imp, tagid }`) compiles to a plan: source members plus override slots. Plans nest (`out.banner = { ...banner, w, h }`, `out.site = { ...out.site, publisher: { ...out.site.publisher, id } }`) and handle `without` and `nonempty`. They are emitted straight into the output frame: untouched members as raw spans, overrides in place, new keys last (allowed by ADR 0001). The bid Phase's plan over the bidder's bid *is* the overrides frame, with no JSON diff.
4. **Fused `Object.fromEntries(list.map(x => [k, v]))`, lazy `split`, UTF-8 templates and joins, a shared empty array.** These came from allocation counts.
5. **Fallback.** Anything outside these forms is a Level 0 value: open `Json`, `json()` results, small computed objects, string pipelines. That keeps every output correct, at Level 0 speed there.

### Where the gap is (Level 1, native profiles and allocation counts)

| | floor (#16) | Level 1 | |
|---|---:|---:|---|
| OpenX `lt`, MakeRequests + MakeBids, native | 2.85 µs | 4.02 µs | 39 + 24 allocations per call |
| PubMatic `lt`, native | 3.98 µs | 7.13 µs | 96 + 42 allocations per call |

What's left, in profile order:

- **Scanning (`skip`), the single largest item.** The floor pays this too.
- **Allocation:**
  - a slot vector and a `Box` per plan;
  - vectors for lists;
  - strings for templates and joins;
  - `Rc` for computed arrays and objects.

  The per-call bump allocator recovers about 2–3 µs of PubMatic's time in wasm.
- **Value clones and drops.** Phase code passes dynamic values, even where the TS type says `string` or `number`.
- **Struct moves.**

Phase code is still Level 0 value code on top of the views. PubMatic's adSlot parsing, the keywords pipeline and the `key_val` builder run on dynamic values. #16 measured string views, fusion and hoisting at about 2 µs, consistent with what remains.

## Requirements for a back end that reaches the floor

These update #16's list with what generating the code taught.

1. **Copy-with-overrides is recognizable from Restricted TypeScript.** #16 called this the hardest piece; it isn't. Fresh locals, one-level writes and read-only inputs make every spread-then-write local a plan, decidable from the source. *Done here.*
2. **One-pass decoding needs no dependency ordering at all.** Decode first into views (a two-pass index, as decided here), then run the Phases. No speculation or redo. *Done here; costs nothing measurable over the floor's single pass.*
3. **Typed primitive locals.** `string`-typed locals should be the string type, `number` an `f64`, and `T | undefined` an `Option<T>`, instead of dynamic values. This is the main remaining codegen work.
4. **Plans without allocation.** Slots inline (a per-site generated struct, or an arena), and nested plans without boxes.
5. **Stream plans during decoding where nothing depends on later input,** as the floor does. That avoids even the arena pass.
6. **An allocator that suits the call shape.** A per-call bump arena helps generated code where it didn't help the floor. It has a hazard, though: lazily initialized globals must be created before the arena is on. A shared empty array crashed the guest until it was. Every guest-side global would need that rule.

## ABI details found on the way

- **Deal priority** travels as an int32. `1e21` saturates to 2147483647 in Rust, where a JS `|0` would wrap; the harness now mirrors the ABI.
- **Host string slots can't carry lone surrogates.** Errors, bid type, seat, currency and kv string values are decoded into native strings, so a lone surrogate becomes U+FFFD there (the #23 question). Request bodies and overrides are JSON, and keep it exactly.
- **Guest size grows:** Level 1 + bump is 201 KB (OpenX) and 318 KB (PubMatic) of wasm, against 110 / 206 KB for the floor.

## Caveats

- One machine (macOS arm64). Not rerun on x86-64 Linux. PBS-Java not covered.
- Same payloads as #14 and #16: OpenX-shaped, with PubMatic params injected. PubMatic `heavy` shows 4 shape misses per call (dynamic re-indexing of `imp.ext.data` values a module helper reads). `lt` has none.
- The fuzz runs the native guests without the bump allocator. The bump variant is covered by the fixtures and `adapterstest`.
- Only OpenX and PubMatic. Constructs no Adapter uses yet fall back to Level 0 or are rejected, for example the request Phase reading `req.imp`, or copy sources in the outgoing request.
