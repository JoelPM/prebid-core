# RESEARCH: Can typed codegen bring a generated PubMatic within ~+10 µs per call on PBS-Go?

Research for [#16](https://github.com/JoelPM/prebid-core/issues/16) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It follows [#14](https://github.com/JoelPM/prebid-core/issues/14), whose prototype is the parent directory ([`../README.md`](../README.md)). Vocabulary follows [`CONTEXT.md`](../../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

**Mostly, not fully.** Rust in the shape a typed E′ back end would emit halves the guest's time in wasm. OpenX gets well inside the gate. PubMatic `lt` gets inside it per call (+9.0 µs), but its process CPU at 1–8 goroutines (+11.5 to +14.3 µs) stays just over. About half of what is left is the guest re-scanning JSON the Host has already parsed. That cost belongs to the ABI, and better codegen can't remove it.

Medians of two in-session runs, same bench, payloads and method as #14 (Apple M5 Max, macOS arm64, Go 1.27.2, wazero 1.12.0). Raw output: [`../results/typed-codegen.txt`](../results/typed-codegen.txt).

| µs per call vs the Hand-written Adapter | generated guest (#14), re-measured | typed guest (this) | gate |
|---|---:|---:|---|
| PubMatic `lt` overhead, one goroutine | +21.8 | **+9.0** (runs 9.2, 8.9) | ✅ ~+10 |
| PubMatic `lt` process CPU, p = 1 / 2 / 4 / 8 | +24.3 / +25.5 / +26.3 / +29.4 | **+11.5 / +12.0 / +12.7 / +14.3** | ❌ just over |
| PubMatic `heavy` overhead | +36.0 | +17.4 | ❌ |
| OpenX `lt` overhead | +9.7 | **+5.0** (runs 4.3, 5.6) | ✅ |
| OpenX `lt` process CPU, p = 1 / 2 / 4 / 8 | +11.0 / +11.6 / +11.4 / +10.9 | **+6.4 / +6.4 / +6.3 / +5.8** | ✅ |
| OpenX `heavy` overhead | +19.4 | **+7.2** | ✅ |

| guest only, µs (write + run + read) | generated, wasm | typed, wasm | typed, native Rust | **wasm ÷ native** (typed / generated) | scan floor (wasm) |
|---|---:|---:|---:|---:|---:|
| OpenX `lt` | 11.6 | 7.2 | 2.81 | **2.6×** / 2.2× | 5.3 |
| OpenX `heavy` | 25.4 | 13.6 | 5.69 | **2.4×** / 2.1× | 9.3 |
| PubMatic `lt` | 23.0 | 10.8 | 3.92 | **2.8×** / 2.2× | 5.5 |
| PubMatic `heavy` | 35.2 | 17.1 | 6.74 | **2.5×** / 2.3× | 9.4 |

The *scan floor* is the ABI round trip plus one JSON scan of the request and the response, with no Adapter logic (the `scan` research export). It is 50–55% of PubMatic's guest time and 70% of OpenX's. The ABI round trip alone is 0.2–0.3 µs.

- **Codegen wins:** about 13 µs per PubMatic `lt` call and 12 µs per OpenX `heavy` call. Natively the typed guest is 1.9–2.6× faster than the generated one; in wasm it is 1.6–2.1× faster.
- **What's left is mostly the ABI.** In variant D the guest re-scans the bid response the Host has already parsed, and copies the whole request through. OpenX's MakeBids takes about 5 µs on `lt`. The 6 KB response is about 80% of the bytes in the 5.3 µs scan floor.
- **wasm ÷ native got *worse*** as the code got leaner: 2.4–2.8×, against 2.1–2.3× for the generated guest. For the typed guest it isn't allocation: a bump allocator changes nothing (see ablation). What's left is mostly tight byte-scanning loops, and that is where wazero falls furthest behind LLVM on native arm64. Typed-rust-guest's ~1.7× was a serde guest with a different mix of work. Why it differs wasn't checked.

## What was built

```
typed/                    this research (a sibling of guest/, same ABI, same features per Adapter)
  src/j.rs                what typed generated code calls: a borrowing JSON cursor, a streaming writer,
                          and the 7 pinned JS semantics restated over &str and raw spans
  src/pubmatic.rs         PubMatic, hand-written as a typed back end would emit it
  src/openx.rs            OpenX (core + Server Extension), the same way
  src/lib.rs              the ABI (in_buf, <bidder>_mr/_mb, out_ptr; same frames) + a `scan` research hook
  src/bump.rs             `bump` feature: per-call bump allocator (ablation only)
  src/bin/native.rs       native timing on the same payloads
  run.sh                  reproduces everything below
../hostgo/cmd/bench       unchanged method; adds per-phase guest timings, ABI and scan floors, -bidders, -par ""
../hostgo/host/shared.go  unchanged ABI; adds GuestMR/GuestMB/GuestABI/GuestScan for the bench
```

What "the shape a typed back end would emit" means here:

- **Liveness-driven typed decoders.** One `match` on literal key bytes per input member. Only fields that some rule reads are decoded: `imp.ext.bidder` is typed from `defs/pubmatic.params.json`, and OpenRTB fields come from the rules. Every other member is a raw span, copied to the output as it streams by.
- **Streaming output.** The request body is written straight into the guest's output frame behind a length placeholder. A rejected imp is rolled back by truncation. `nonempty` on an output object is a truncation too.
- **Strings as views.** Every string expression is `Cow<'a, str>` borrowed from the input, and only `lower` on mixed case, `join` and templates allocate. `split` on a one-character literal is a lazy view: `at[1]` re-splits the borrowed string, so no list is built.
- **Fused pipelines.** `keywords.filter(...).map(...)` → `fromEntries` runs inside the params decoder in one walk: it joins each `value` as it is read and counts it for the `len > 0` filter. The `[dctr || kw.key_val, ...pairs].filter(s, s)` → `join('|')` chain builds one `String`. `first(params.map(...))` is a fold.
- **Interned keys and literals.** Output keys are pre-quoted `b"\"key_val\":"` baked into the binary, and separators are `char` patterns.
- **In place, one pass.** Values are decoded from the cursor, never by taking a span and re-parsing it. PubMatic's imp rules read `req.app` (for `displaymanager`), which the Host writes *after* `imp`. The imps are processed in place on the speculation that no app comes, and redone from their span if one does and yields a `dm`. `site` is rewritten in place because the imps, and so the publisher id, came first.
- **Lazy documents.** PubMatic's MakeBids never scans the request. OpenX builds its imp table only when a bid's `mtype` doesn't settle its type.
- **Dynamic fallback for `unknown`.** `json(bid.adm)` (native only) runs on the profile-compiler runtime's `Doc`, since the parsed adm is untyped.

Params read through `str()` (`adSlot`, `publisherId`, `kadfloor`, OpenX `unit`) stay raw and are coerced at use, as the Definition says. `pmzoneid` and `dctr` are typed as the schema says, so a non-string there decodes as absent. Without schema validation that would differ from the TS back end (see "New questions").

## Parity (a fast but wrong guest proves nothing)

Same checks as `../run.sh`, on every build including each ablation:

- `harness/parity.mjs --rs` on all 33 OpenX and PubMatic fixtures checks against the fixture expectations, against the Hand-written PBS-Go Adapter's full output (meta and deal priority included), and against the generated TS: **33/33, 3 via the same pinned Known Differences; identical to TS on every fixture**. All 11 ablation builds also get 33/33 and match TS.
- PBS-Go's own `adapterstest.RunSingleJSONBidderTest` under `-race` gives **30 pass, 3 fail**. The three failures are exactly the Known Difference fixtures (`exemplary/fledge`, `exemplary/native`, `supplemental/app`).
- The bench checks every payload before timing: the body and every TypedBid must equal the Hand-written Adapter's.
- The harness is still sensitive. Changing PubMatic's keyword `join` separator from `,` to `;` fails 16 fixtures, the same as for the generated guest.

## Ablation: which patterns account for the win

Each `abl_*` feature reverts one pattern and leaves the rest typed. Below is the guest-only time in wasm, one run each, Δ against the typed guest. OpenX has no code path for `abl_twopass`, so its Δ there (+0.2 to +0.3) is the noise floor.

| reverted pattern (feature) | PubMatic `lt` | OpenX `heavy` | PubMatic `heavy` | OpenX `lt` |
|---|---:|---:|---:|---:|
| typed guest | 10.8 | 13.6 | 17.1 | 7.2 |
| raw pass-through → decode untouched subtrees to a generic value and re-encode (`abl_passthru`) | **+8.8** | **+15.9** | +13.5 | +8.9 |
| in-place decode → take a span, then re-parse it (imps, bids, `bid.ext`, `site`) (`abl_rescan`) | **+5.1** | **+8.1** | +8.9 | +4.9 |
| interned keys/literals → quote and escape keys and allocate literals per use (`abl_nointern`) | +1.9 | +1.3 | +2.9 | +0.7 |
| lazy documents → scan what nothing reads (`abl_eager`) | +1.6 | +3.0 | +2.5 | +1.6 |
| string views → owned `String` per string op (`abl_owned`) | +0.9 | +1.2 | +1.6 | +0.9 |
| fused pipelines → materialize each `filter`/`map`/`entries` list (`abl_unfused`) | +0.8 | +0.2 | +1.4 | +0.1 |
| speculative single pass → imps held until `req.app` is known, then re-parsed (`abl_twopass`) | +0.7 | (+0.2) | +1.7 | (+0.3) |
| reuse the output buffer → fresh `Vec` per call (`abl_freshout`, runtime) | +0.4 | +0.4 | +1.1 | +0.7 |
| hoist `dm` out of the imp loop (`abl_nohoist`; payloads have no `app`) | +0.4 | +0.2 | +0.4 | +0.3 |
| *bump allocator instead of dlmalloc (`bump`, runtime)* | −0.6 | 0.0 | +0.1 | +0.1 |
| everything above reverted at once (`all`) | +18.5 | +27.7 | +29.3 | +15.3 |

How to read it:

- The generated guest already had raw pass-through and lazy documents. Its runtime copies untouched spans with a `memcpy`. So the two biggest rows say what a typed back end must **not lose**, not what it gains over #14. A back end that emits full serde-style OpenRTB structs would be slower than the generic runtime: `all` is 29 µs against the generated guest's 23 µs.
- Against the generated guest, PubMatic `lt` gains 12.2 µs. The other single reverts add up to about 10 µs of that: rescan, interning, views, fusion, the speculative pass, hoisting and the reused buffer. The rest is typed decoding itself: one `match` per member, against arena nodes and a linear member scan on every `get`. That can't be reverted without writing a third guest.
- Not worth it: a bump allocator (allocation isn't the wasm problem), 8-byte SWAR or SIMD (`memchr` with `+simd128`) string scanning, and opt-level 2 or `s`. In exploratory runs (not in the raw output), SWAR made PubMatic `lt` 2.6 µs *slower* in wasm, `memchr` was 0.5 µs slower, and the opt-levels moved nothing beyond noise. The ad markup in responses has an escape every few bytes, so wide scans rarely get to run.

## Requirements for the E′ transpiler's Rust back end (ranked by measured cost)

1. **Copy what no rule reads, as raw spans** (8.8–15.9 µs). Decoders are derived from the fields the TS reads, and every other member is copied untouched, never decoded into OpenRTB structs and re-encoded. Typed OpenRTB is for the fields read, not the whole request.
2. **Decode in place, in one pass** (4.9–8.9 µs). Don't hold a span and re-parse it later. Where a rule reads a field the input carries later (imp rules read `req.app`; `banner.w` depends on `imp.ext.bidder`), defer only what depends on it. Or speculate and redo, which is safe because the rules are pure.
3. **Stream the output** (folded into 1 and 2). Write the body straight into the guest's output buffer. Express rewrites as "copy the members not overwritten, then the overwritten ones" (spread-with-overrides). Roll back rejected imps by truncation.
4. **Intern keys and literals** (0.7–2.9 µs). Use pre-quoted output keys, static literal strings, and `char` separators for one-character literals.
5. **Read nothing nobody reads** (1.6–3.0 µs). The guest scans a document, or decodes a lookup like OpenX's imp table, only when a rule reads it, and only once.
6. **Strings as `Cow<'a, str>` views** (0.9–1.6 µs). Builtins return borrowed results when they can: `trim`, `lower` on lower-case ASCII, `split` on a literal.
7. **Fuse pipelines** (0.1–1.4 µs). Lower `filter`/`map`/`fromEntries`/`join`/`first` chains to one loop. When a list is read by one pipeline only, run that pipeline inside its decoder.
8. **Hoist loop-invariant reads out of the imp loop** (small, but free).
9. Runtime, not codegen: a reused output buffer (0.4–1.1 µs); a plain byte-scanning reader (wide scans didn't pay in wasm); integers printed without the float formatter; `unknown` (`json()`) served by a dynamic value type.

**Hard to generate from restricted TypeScript:**

- **Streaming rewrites and dependency order (2, 3).** The transpiler has to recognize `{...imp, tagid, banner: {...imp.banner, w}}`-style copy-with-overrides, including conditional nested sets (`banner?.w`) and deletes. It must also work out, per object, which outputs depend on members that come later in the input, and therefore defer or speculate. Speculation also needs side effects (errors, ids) to be reset when a pass is redone. This is the biggest piece of compiler work on this list.
- **Fusing into the decoder (7).** This needs escape analysis showing a list has exactly one consumer. Fusing a chain on its own is easy, since it is Rust iterator chains over lazy raw-array iterators.
- **Key order.** A streaming rewrite moves rewritten members to the end of their object. The output is JSON-equal to the TS back end's, which the parity harness and `adapterstest` accept, but not byte-equal. #14's pinned semantic 3 (JS assignment order) would have to be dropped for request bodies, or paid for with a re-walk.
- **Types at the boundary.** The TS types say `publisherId: string`, but PBS-Go's `adapterstest` doesn't validate params, and Prebid.js validates only what `isBidRequestValid` checks. Typed decoding needs a rule for schema-violating input (see below).
- **`||`/`&&` returning operands, `len()` of objects, integer-key order and the rest of JS's semantics.** These are easy as runtime helpers, but every typed fast path has to keep them. For example, `j::truthy` on raw spans and `members()` re-ordering integer-like keys for `entries` and `keys()[0]`.

## Method

As #14 and research/typed-rust-guest:

- MakeRequests then MakeBids on the same `*openrtb2.BidRequest`, through `host.Shared` with a `sync.Pool` of instances.
- Single-goroutine overhead is the median of 5 `testing.Benchmark` runs, Shared minus the Hand-written Adapter.
- Process CPU is `getrusage` over 2 s windows at p = 1, 2, 4, 8 goroutines, median of 3, for `lt` only, as before.
- Guest-only, per-phase, ABI-floor and scan-floor times use the same `single()` timer.
- Native times are the best of 5 × 20,000 calls on the payloads the Host writes into the guest (`cmd/dumppayload`).
- The generated guests were rebuilt and re-measured in the same session as the typed ones, interleaved over two runs, so the comparison doesn't lean on #14's numbers. Those reproduce within about 1 µs.

### Reproduce

```sh
cd prototype/profile-compiler
./typed/run.sh | tee results/typed-codegen.txt   # ~50 min; ABL="" skips the ablations, RUNS=1 one bench run
```

This needs what `../run.sh` needs: Node 22.6+, Rust with `wasm32-unknown-unknown`, Go 1.25+, and a prebid-server checkout at `../../../prebid-server` (a916b19ef measured). `../run.sh` itself had a step-order bug, timing the native guest before its payloads were written. That is fixed on this branch.

## Caveats

- **One machine (macOS arm64), with other apps running.** On PubMatic `lt`, single-goroutine overhead varied from +8.9 to +12.0 µs across separate runs. Guest-only time is stable (10.7–10.9 µs) and is the better comparison. Treat "+9.0" as "at the line", not as a margin. Not rerun on x86-64 Linux.
- **Hand-written, not generated.** This is the floor a back end could reach, and the transpiler doesn't exist yet. Some patterns (2, 3) need compiler analyses that may not be worth building.
- **Process CPU exceeds per-call overhead by 2–5 µs, for both guests, and the gap grows with goroutines.** It isn't GC: GOGC=400 changes nothing ([`../results/typed-codegen-gogc.txt`](../results/typed-codegen-gogc.txt)). A plausible cause, not measured, is cache pressure from per-instance linear memories. CPU for `heavy` isn't measured (the bench runs concurrency on `lt` only, as before).
- **Payloads are OpenX-shaped, with PubMatic params injected**, as in #14. Neither has `app`, `imp.ext.data` or native bids, so `dm`, the `key_val` pairs and the `json(adm)` fallback are exercised by fixtures only, not timed.
- **The ABI was held fixed (variant D), so the scan floor stays.** PBS-Java is not covered.

## New questions this raises

- Should the ABI stop making the guest re-scan the bid response? The Host could pass only the fields the Adapter declares, like the response projection GraalWasm needed in #12. The scan floor is now 50–70% of guest time.
- Is a JSON-equal but not byte-equal request body acceptable? If not, streaming rewrites cost a re-walk.
- Do all Hosts validate bidder params against the params schema before a Shared Adapter runs? Typed decoding treats a schema violation as absent, where TS would coerce or throw.
- Why does pooled-wasm process CPU grow with goroutines, when GC isn't the cause?
