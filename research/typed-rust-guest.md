# Can a typed Rust guest cut PBS-Go's WASM overhead to ~10 µs per call?

Research for [#12](https://github.com/JoelPM/prebid-core/issues/12) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It builds on [#3](https://github.com/JoelPM/prebid-core/issues/3) ([findings](https://github.com/JoelPM/prebid-core/blob/research/server-wasm-embedding/research/server-wasm-embedding.md)) and [#11](https://github.com/JoelPM/prebid-core/issues/11) ([findings](https://github.com/JoelPM/prebid-core/blob/research/pbs-cpu-baseline/research/pbs-cpu-baseline.md)). Vocabulary follows [`CONTEXT.md`](../CONTEXT.md).

## TL;DR

- **PBS-Go: yes, with room to spare.** With a typed guest and a lean ABI, a Shared OpenX Adapter under wazero adds **+6–7 µs per call** over PBS-Go's real Hand-written Adapter (21.6 µs) on #11's load-test payload. Under 1–8 concurrent goroutines it adds **at most +6 µs of process CPU** per call (between −3 and +6 µs, depending on the pool). #3's design measured the same way adds **+58 µs**.
  - At 5–10 bidders, all Shared, that is about **+2.5–3 % per-auction CPU**, inside criterion (3)'s ≤ 5 %.
- **PBS-Java: only GraalWasm on a GraalVM JDK gets there.**
  - **GraalWasm** with the same guest adds **+2.7 µs** single-threaded and **+2.0 µs** CPU at 4 threads over PBS-Java's real `OpenxBidder` (16 µs). That passes the ~7.5 µs budget. It needs one more trick: the Host sends the guest a small projection of the bid response instead of the raw 6 KB. Without that trick it adds +12.6 µs. On #3's heavier payload it adds +12.6 µs even with the projection.
  - #3 already showed GraalWasm runs interpreter-only on a stock JDK (~8 ms per call). PBS-Java ships on Corretto.
  - **Endive** (pure JVM, any JDK) gets its best result, **+12.4 µs**, only with the JVM-wide flag `-XX:-DontCompileHugeMethods`. That is ~8 % per-auction CPU at 5–10 bidders, so it **fails** the budget. That's still ~30× better than #3's +370 µs. With default JVM flags its best is +34 µs.
- **What mattered, in order:**
  1. **Typed structs with borrowed raw pass-through, instead of `serde_json::Value`.** This saves 40 µs per call on wazero, 46 on GraalWasm and 97 on Endive, and is most of the win.
  2. **The Host keeps the OpenRTB parse.** The guest returns a small binary record per bid instead of JSON bids for the Host to parse again (−4.5 µs wazero, −2 GraalWasm, −10 to −48 Endive).
  3. **Send the guest only the response fields the Adapter reads** (−1 µs wazero, −10 GraalWasm, −10 Endive).
  4. **Instance pooling is mandatory, but any pool will do.** A fresh wazero instance per call costs +140–190 µs of CPU. `sync.Pool`, a channel pool and per-goroutine instances all land within noise of each other.
  5. **Raw boundary cost is negligible on wazero:** a call is 10 ns and a 6 KB write is 50 ns. On GraalWasm it is not, because the polyglot API has no bulk memory write (~2 µs per 1.6 KB).
- **Caveat: one machine.** All numbers come from an Apple M5 Max (macOS arm64). Criterion (3) is defined on x86-64 Linux, and these numbers haven't been rerun there.

## Method

- **Machine and toolchains:**
  - Machine: Apple M5 Max, macOS arm64, single-socket. Treat the numbers as relative.
  - Go 1.27.2 + wazero 1.12.0 (compiler) against PBS-Go master `a916b19ef`.
  - Temurin 25.0.4.1 and GraalVM CE 25.0.2 JDK against PBS-Java master `a1f9ddb2f`.
  - Endive 1.1.0 and GraalWasm (`org.graalvm.polyglot:wasm`) 25.0.2.
  - Rust 1.99.1, `wasm32-unknown-unknown`, LTO, `panic=abort`, `opt-level=3` (a second `opt-level=s` build for Endive). No `simd128`.
- **Baselines are the real Hand-written Adapters, called as the exchange calls them:**
  - **Go:** `openx.Builder(...)` from the checkout, `MakeRequests` then `MakeBids`.
  - **Java:** `new OpenxBidder(url, JacksonMapper(ObjectMapperProvider.mapper()))`, `makeHttpRequests` then `makeBids`. PBS-Java was compiled from source and the bench runs against its classes.
- **What "overhead" means here:** the WASM path starts from the same in-memory request object the Hand-written Adapter gets (`*openrtb2.BidRequest` / `BidRequest` POJO). It must end with the same outputs: `RequestData` plus `BidderResponse`/`TypedBid` in Go, `HttpRequest` plus `List<BidderBid>` in Java. Everything in between counts as overhead:
  - Host serialization of the request.
  - Every copy in or out of guest memory.
  - The guest's run.
  - Host decoding of the guest's output.
  - Per call: overhead = WASM path − native path, same process, same payload, reused instance unless stated.
- **Correctness:** every variant's outgoing body is semantically equal to the Hand-written Adapter's (JSON-compared), and every bid's type/video/meta/price/adm/ext matches. The check runs before each benchmark. On Java, two known `OpenxBidder` divergences from PBS-Go are normalized away (see Caveats).
- **Payloads** (generator: [`gen/main.go`](typed-rust-guest/gen/main.go)):
  - **`lt`** (primary, since criterion (3) is derived from it) is #11's load-test auction (`auction-10.json`, 3 banner imps), transformed for OpenX exactly as #11's adapter bench does. The reply is #11's stub response: 3 bids with ~1.4 KB `adm` each. The request is 1.6 KB, the response 6.0 KB.
  - **`heavy`** is #3's payload: 4 imps including rewarded video, 5 EIDs, 4 bids. The request is 3.1 KB, the response 11.3 KB.
- **Timing:**
  - Single-threaded runs are the median of 5 (Go: `testing.Benchmark`; Java: time-boxed after warm-up).
  - Concurrency runs report process CPU (user+sys, so GC and JIT are included) per call, as the median of 3 windows.
- **Code:** [`typed-rust-guest/`](typed-rust-guest/) holds the code and [`results/`](typed-rust-guest/results/) holds the raw output. [`run.sh`](typed-rust-guest/run.sh) reruns everything.

### Guest and ABI variants

One guest module ([`guest/src/`](typed-rust-guest/guest/src/)) exports all of these. A–C are there to isolate what each change buys.

| | Guest code | ABI / boundary |
|---|---|---|
| **A** | #3's guest: `serde_json::Value`, parse → clone → re-serialize | #3's ABI: `alloc` ×2, write ×2, one `adapt(req, resp)` call that re-parses the request inside MakeBids, JSON out (body as an escaped string + full bids), `dealloc` ×2. Host JSON-decodes the output. |
| **B** | same Value code | **lean ABI**: one guest-owned input buffer reused across calls (Host caches its pointer); separate `mr_*`/`mb_*` exports, as MakeRequests and MakeBids run on either side of the HTTP call; MakeBids gets a small binary imp table instead of the request. Output read in place. Still JSON bids out. |
| **C** | **typed**: hand-written serde visitors decode only what OpenX reads or rewrites (`imp[].banner/video/native/bidfloor/rwdd/ext.bidder`, `bid.impid/mtype/cat/dur/ext`). Every other subtree is a borrowed `&RawValue` copied to the output verbatim. `adm` is skipped, never materialized. | lean ABI, JSON bids out (raw bid pass-through) |
| **D** | typed | lean ABI; **the Host parses the bid response itself** (as the Hand-written Adapter would). The guest returns a ~40 B/bid binary record (type, dur, cat[0], meta ids), which the Host attaches to its own parsed bids. |
| **E** | typed | as D, but the guest receives a **projection** of the Host's parsed response: only `impid, mtype, cat, dur, ext` per bid (~460 B instead of 6 KB). Same guest parser. |

## Results (payload `lt`, µs per MakeRequests+MakeBids call)

### PBS-Go / wazero ([`results/wazero.txt`](typed-rust-guest/results/wazero.txt))

| Path | One goroutine, reused instance | Overhead vs native |
|---|---:|---:|
| Native PBS-Go OpenX (MakeRequests 8.0 + MakeBids 13.4) | **21.6** | — |
| A: #3 guest + #3 ABI | 79.6 | **+58.1** (3.7×) |
| B: Value guest, lean ABI | 73.3 | +51.7 |
| C: typed guest, JSON bids out | 33.2 | +11.6 |
| D: typed guest, Host parses bids, binary annotations | 28.7 | **+7.2** |
| E: D + response projection | 27.5 | **+5.9** |

Process CPU per call under concurrency (incl. GC), median of 3 × 2 s:

| goroutines | native | D, instance per goroutine | E, instance per goroutine | D, `sync.Pool` | D, channel pool | D, fresh instance per call |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 32.5 | 34.4 (+1.9) | 34.2 (+1.7) | 30.1 (−2.4) | 29.5 (−3.0) | 222 (+190) |
| 4 | 28.7 | 33.8 (+5.1) | 33.0 (+4.3) | 31.7 (+3.0) | 31.5 (+2.8) | 174 (+145) |
| 8 | 31.5 | 37.6 (+6.2) | 37.4 (+5.9) | 36.6 (+5.2) | 36.9 (+5.4) | 172 (+140) |

- **Variation between configurations** is ±3 µs (GC pacing), so the pool flavours can't be told apart. Within a configuration, runs agree to < 1 µs.
- **Where D's +7 µs goes:**
  - MakeRequests: the Host's `jsonutil.Marshal` of the request (6.3 µs) replaces the Hand-written Adapter's own marshal. The guest then re-emits the body, mostly as raw slice copies, in 3.1 µs including the write. Net about +1.7 µs.
  - MakeBids: the Host's `jsonutil.Unmarshal` of the response (12.7 µs) is the same work native does. The guest's skim of the response adds 4.6 µs (+4 µs net). E cuts that to 1.4 µs, plus 2.1 µs for the Host's projection.
- **Boundary costs:**
  - `CallWithStack`: 10 ns. `Call`, which allocates its result slice: 20 ns.
  - 6 KB `Memory.Write`: 50 ns.
  - `alloc`+`dealloc` pair: 60 ns.
  - Fresh `InstantiateModule`+`Close`: 53 µs and 1.1 MB.
  - Linear memory per instance: 1.25 MB.
- **WASM vs native Rust:** the same guest functions compiled natively ([`results/rust-native.txt`](typed-rust-guest/results/rust-native.txt)) run `mr_typed` in 1.75 µs and `mb_typed_annot` in 2.6 µs. wazero is ~1.7–1.8× slower.
- **`heavy` payload:** native 52.5 µs (noisy, 47–55); D +6.4 µs; E −2.0 µs.
  - PBS-Go's own OpenX MakeRequests is costly here (23.5 µs: it round-trips every `imp.ext` through `map[string]json.RawMessage` and `customParams` through `map[string]interface{}`). The guest's raw pass-through beats it.
  - So overhead doesn't simply scale with payload size.

### PBS-Java

Native `OpenxBidder` is **15.9–16.4 µs** single-threaded on `lt` and **19.4–20.9 µs** of process CPU per call at 4 threads, on both JDKs ([`java-native-temurin.txt`](typed-rust-guest/results/java-native-temurin.txt), [`java-native-graalvm.txt`](typed-rust-guest/results/java-native-graalvm.txt)). That is cheaper than PBS-Go's 21.6 µs. Each runtime below is compared against native measured in the same JVM.

| Path (overhead vs native, µs) | GraalWasm, GraalVM JDK | Endive, Temurin, default flags | Endive, `-XX:-DontCompileHugeMethods` | Endive, guest `opt-level=s` |
|---|---:|---:|---:|---:|
| B: Value guest, lean ABI | +60.4 | +189.9 | +173.5 | +229.6 |
| C: typed, JSON bids out | +14.7 | +92.5 | +33.2 | +45.5 |
| D: typed, Host parses bids | +12.6 | +44.8 | +22.9 | +30.0 |
| **E: D + response projection** | **+2.7** | +34.1 | **+12.4** | +14.0 |
| E, process CPU/call at 4 threads (one instance per thread) | **+2.0** | +37.3 | +12.4 | +14.1 |
| E on `heavy` | +12.6 | +84.6 | +28.9 | +32.1 |

Raw output: [`graalwasm-O3.txt`](typed-rust-guest/results/graalwasm-O3.txt), [`endive-O3.txt`](typed-rust-guest/results/endive-O3.txt), [`endive-O3-hugemethods.txt`](typed-rust-guest/results/endive-O3-hugemethods.txt), [`endive-Os.txt`](typed-rust-guest/results/endive-Os.txt).

- **GraalWasm: the boundary is the cost.** The polyglot `Value` API in 25.0.2 has a bulk `readBuffer(long, byte[], int, int)`, but writes only come one primitive at a time (`writeBufferByte/Short/Int/Long/…`, checked with `javap` on `polyglot-25.0.2.jar`). Writing `lt`'s 1.6 KB request takes 1.96 µs, about 10 ns per 8-byte word.
  - In D, writing the 6 KB response is ~7 of `mb_typed_annot`'s 11.6 µs. E's projection removes it (1.9 µs).
  - What's left on `lt` is the 1.6 KB request write plus `mr_typed` (5.5 µs including the write).
  - On `heavy` the 3.1 KB request costs 3.8 µs to write and `mr_typed` takes 11 µs, so E lands at +12.6 µs.
- **Endive: HotSpot's huge-method rule hurts it most.** HotSpot by default refuses to JIT any method over 8,000 bytecodes (`DontCompileHugeMethods`, a product flag, `true` by default). Endive translates each WASM function into one JVM method, and LTO'd Rust has some very large functions (serde's inlined visitors).
  - Turning the rule off cuts `mr_typed` from 32 to 11.7 µs and C from +92 to +33 µs.
  - Building the guest at `opt-level=s` (smaller functions) gets most of that without touching the JVM flag (12.5 µs). But its MakeBids skim is slower (22.7 vs 16.4 µs).
  - Even at best, Endive runs the guest **~3.5–4× slower than wazero**: `mb_typed_annot` on the 461 B projection takes 5.2 µs vs 1.4 µs. Calls themselves are cheap (noop 10 ns), so the cost is in code quality, not the boundary.

## Answers

### Does PBS-Go reach ~10 µs per call? Yes.

- D/E add +6–7 µs per call single-threaded and at most +6 µs of process CPU per call at 1–8 goroutines.
- With #11's baselines (1,170 µs at 5 bidders, 2,070 µs at 10), every bidder as a Shared Adapter at ~6 µs adds about **+2.6 % (5 bidders) and +2.9 % (10 bidders)**, under criterion (3)'s 5 %.
- The PoC gate (one Shared Adapter) adds ~0.3–0.5 %.

### Does PBS-Java reach ~7.5 µs per call? Only GraalWasm on a GraalVM JDK, only with the projection, and only on the lighter payload.

- **GraalWasm E:** +2–3 µs on `lt`, about +1.2–1.8 % per auction. But +12.6 µs on `heavy`, because request bytes are written one word at a time.
- **Endive:**
  - Best is +12.4 µs, and only with a JVM-wide flag operators may not accept. That's ~8 % per auction at 5–10 bidders: **fails** at catalogue scale.
  - It passes the PoC gate: one Shared Adapter at +12–14 µs is ~0.8–1.9 % per auction.
  - With default flags it's +34 µs, which still passes the PoC gate (≤ 38 µs) but by little.
- **GraalWasm's JDK requirement (from #3):** GraalWasm only gets optimizing execution on a GraalVM JDK. On stock Oracle/OpenJDK 25 it needs a polyglot isolate, otherwise it's interpreter-only ([embedding docs](https://www.graalvm.org/latest/reference-manual/embed-languages/)). #3 measured ~8 ms per call on Temurin. Isolate calls cross at ~0.28 µs each, and with no bulk write, the lean ABI would still need ~200 crossings just for `lt`'s request. **The isolate path doesn't rescue the ~7.5 µs budget** unless GraalVM adds a bulk buffer write. This is an inference from #3's per-crossing cost; it wasn't measured here.

### Which optimizations matter

| Change | wazero | GraalWasm | Endive (huge-methods on) | Verdict |
|---|---:|---:|---:|---|
| Value → typed borrowed structs (B→C) | −40 µs | −46 µs | −140 µs | **The big one.** Skipping `adm` and copying untouched subtrees raw is most of it. |
| JSON bids out → Host parses, binary annotations back (C→D) | −4.5 | −2 | −10 | Worth it: avoids parsing the response twice. |
| Raw response in → projection of the Host's parse (D→E) | −1.2 | −10 | −10 | Small on wazero, decisive on JVM runtimes. Needs the Adapter to declare which bid fields it reads. |
| #3 ABI → lean ABI (A→B) | −6 | n/a | n/a | Comes from not re-parsing the request in MakeBids and not escaping the body into a JSON string. Fewer copies by themselves save < 0.2 µs on wazero. |
| Fresh instance → any pool | −140 to −190 | (JVM: one instance per event-loop thread) | | Mandatory; pool flavour doesn't matter. |
| Binary instead of JSON for the *request* | not tried | | | The guest's job is to emit a JSON body, and the Host serializes the request anyway: native PBS-Go pays the same marshal. With raw pass-through the guest's re-emit is ~3 µs (wazero). |

## Caveats

- **One machine.** macOS arm64 (M5 Max), not the x86-64 Linux that criterion (3) names. wazero's compiler supports both, so the ratios should roughly carry over, but no x86 numbers exist.
- **One Adapter.** OpenX's logic is light: most of its work is JSON shuffling, which the typed guest turns into memcpy. Adapters with more real logic will pay wazero's ~1.7–1.8× native-Rust slowdown on that logic. Adapters that inspect `adm` lose E's projection benefit.
- **Research shortcuts in the guest:**
  - Object keys are borrowed `&str`, so a key containing a JSON escape fails to parse (OpenRTB keys never need escapes).
  - `delDomain`/`platform` take the last valid imp's value, as PBS-Go does. PBS-Java takes the first.
- **Java semantics are PBS-Go's.** The guest ports PBS-Go's adapter, and `OpenxBidder` differs in two ways that the Java check normalizes away: it sets `video.ext.rewarded` from `imp.ext.prebid.is_rewarded_inventory` rather than `imp.rwdd`, and it keeps an empty `imp.ext` (`{}`).
- **`HttpRequest.payload` on the Java WASM path.** It carries the *original* `BidRequest`, because the guest's modified request exists only as bytes. The Hand-written path carries the modified POJO. Whether PBS-Java core needs the modified POJO was not checked.
- **CPU-under-concurrency numbers include GC.** They move ±3 µs between configurations. The single-threaded medians are tighter (< 1 µs spread).
- **Not measured:** x86-64 Linux; a full PBS load test with Shared Adapters wired in; the GraalWasm isolate with the lean ABI; Wasmtime; `wasm-opt`; Endive's build-time compiler (#3: same steady-state code as the runtime compiler).

## Sharp questions / fog surfaced

1. **The Shared Adapter interface now has a performance-driven shape.** The Host owns the OpenRTB parse. MakeRequests is "request bytes in, body bytes out". MakeBids takes a Host-made projection of the bids plus an imp table and returns per-bid annotations, not bids. That needs each Adapter to **declare which response fields it reads** (a manifest). Is that acceptable to the Adapter-author experience? It feeds "How Hosts consume Prebid Core".
2. **Would PBS-Java accept a GraalVM JDK base image?** It's the only measured JVM path under 7.5 µs. Otherwise, could GraalVM add a bulk `writeBuffer(long, byte[], int, int)` to the polyglot `Value` API? That's the missing piece for both the in-process and isolate paths.
3. **Endive's code quality on serde-heavy guests** is ~3.5–4× wazero, even with huge-method compilation on. Ask Endive about its performance roadmap. Also try splitting the guest so no WASM function exceeds HotSpot's 8,000-bytecode limit (e.g. `#[inline(never)]` on visitors) as a flag-free alternative to `-XX:-DontCompileHugeMethods`.
4. **Request size matters on JVM runtimes.** GraalWasm E goes from +2.7 µs (1.6 KB request) to +12.6 µs (3.1 KB request). Criterion (3) should be checked against a realistic distribution of per-bidder request sizes, not one payload.
5. **x86-64 Linux rerun** of `hostgo` and `JBench`, ideally inside #11's load test with Shared Adapters wired in, before treating "Go passes" as settled.
