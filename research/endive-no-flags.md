# Can Endive run the typed guest within budget without JVM flags?

Research for [#13](https://github.com/JoelPM/prebid-core/issues/13) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It builds on [#12](https://github.com/JoelPM/prebid-core/issues/12) ([findings](https://github.com/JoelPM/prebid-core/blob/research/typed-rust-guest/research/typed-rust-guest.md)), reuses its guest, payloads and `JBench` paths, and uses the vocabulary in [`CONTEXT.md`](../CONTEXT.md).

## TL;DR

- **Yes, but only with Endive's experimental Redline backend, built from Endive `main`.** The released Endive 1.1.0 can't do it.
  - **Redline** compiles the guest to native code with Cranelift at build time, ships it in the jar, and calls it through Panama FFM. It needs a stock JDK 25+ (PBS-Java ships on Corretto 25), no GraalVM and no JVM flags.
  - On Endive `main` (`1580f53`), the typed guest's E path on Redline costs **−0.7 µs** per call against PBS-Java's real `OpenxBidder` (16.3 µs) on the `lt` payload. At 4 threads it costs **−1.5 µs** of process CPU, and on #3's `heavy` payload **+5.8 µs**.
    - It is cheaper than the Hand-written Adapter on `lt` because the guest's raw pass-through replaces `OpenxBidder`'s Jackson tree rewriting.
    - That beats GraalWasm on a GraalVM JDK (#12: +2.7 µs `lt`, +12.6 µs `heavy`).
  - **Redline in the 1.1.0 release fails badly: +42 µs single-threaded, +101 µs CPU at 4 threads.** It starts a watchdog `Thread` on every call into native code (a no-op export call takes 21.5 µs). This is upstream issue [#201](https://github.com/bytecodealliance/endive/issues/201), fixed on `main` by [#210](https://github.com/bytecodealliance/endive/pull/210), which isn't released yet. With the fix, a call costs 0.07 µs.
- **Plain Endive (JVM bytecode): the flag can be replaced, but the budget still fails.**
  - Keeping the guest's hot functions under HotSpot's 8,000-bytecode JIT limit gets exactly what `-XX:-DontCompileHugeMethods` got: **+12.0 µs** (`lt`), **+11.6 µs** CPU at 4 threads, **+27.5 µs** (`heavy`). The budget is ~7.5 µs, so it **fails**.
  - The fix that worked: `#[inline(never)]` on the serde visitors plus two small helper functions. Only one hot function (`typed::make_requests`, 16 KB of JVM bytecode) was over the limit.
  - Turning the flag on top of the split guest gains nothing (+11.6 µs), so ~+12 µs is plain Endive's floor for this guest.
  - The remaining cost is code quality. On bytecode the guest runs `mr_typed` in 11.4 µs; on Redline it takes 3.0 µs and on wazero 3.1 µs (#12, write included).
- **Knobs that don't help:**
  - `opt-level=2`: +31.7 µs.
  - A lower LLVM inline threshold: +36.3 µs.
  - `wasm-opt -Oz --outlining`: +39.7 µs.
  - `wasm-opt -O3` after the split: no change.
  - `opt-level=s` gets most of the way (+13.4 µs) without code changes, but its MakeBids is slower.
- **Upstream roadmap (primary sources):**
  - Endive doesn't split oversized functions. The maintainer tried and dropped it in favour of Redline ([#170](https://github.com/bytecodealliance/endive/issues/170)).
  - The only other bytecode speed-ups discussed upstream need JVM flags (`-XX:-ClipInlining`, `-XX:MaxTrivialSize`) or custom memory ([#224](https://github.com/bytecodealliance/endive/issues/224)).
  - **Redline is the project's answer to bytecode performance.**
- **Caveat: one machine.** Apple M5 Max (macOS arm64), Temurin 25.0.4.1. Redline's x86-64 Linux code was built but not run.

## Method

- **Machine and toolchains:** same machine as #12. Temurin 25.0.4.1+1 (PBS-Java's image is Corretto 25), Rust 1.99.1, binaryen 133, PBS-Java master `a1f9ddb2f`.
- **Endive versions:**
  - Endive 1.1.0 (latest release, 2026-09-03).
  - Endive `main` at [`1580f53`](https://github.com/bytecodealliance/endive/commit/1580f5349ae0ce9a771fa42ee8397ba6d2553685) (2026-10-15), built locally as `999-SNAPSHOT`.
- **Paths and overhead:** same D/E paths, correctness check and "overhead = WASM path − native `OpenxBidder` in the same JVM" definition as #12.
  - E is the passing shape: the Host parses the bids, the guest receives a projection of the response, and returns binary annotations.
  - Single-threaded numbers are the median of 5. CPU numbers are process CPU per call at 4 threads, one instance per thread, median of 3 windows.
- **Build:** each guest variant is compiled ahead of time with Endive's Maven plugin ([`module/pom.xml`](endive-no-flags/module/pom.xml)). The plugin always emits JVM bytecode, plus Redline native code for `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`.
  - "bytecode" runs use the module's `safeBuilder()`, and "redline" runs use `builder()`. The bench prints that native code was really in use.
  - The bytecode path matches #12's runtime compiler (both +34.3 µs on the O3 guest).
- **Method sizes:** bytecode size per generated JVM method comes from `javap` on the compiled module. Names come from the guest's name section.
- **Code:**
  - [`build-guests.sh`](endive-no-flags/build-guests.sh) builds the variants and the size listings.
  - [`run.sh`](endive-no-flags/run.sh) runs the benches.
  - [`java/EBench.java`](endive-no-flags/java/EBench.java) is the bench (it reuses `JBench`).
  - Raw output is in [`results/`](endive-no-flags/results/).
  - The guest change is the `split` cargo feature in [`typed.rs`](typed-rust-guest/guest/src/typed.rs). Without the feature, LLVM inlines the helpers back: `make_requests` is 15,990 B vs 16,299 B before the refactor, and E is +34.3 µs as in #12.

## Why plain Endive needs the flag, and how to avoid it

- HotSpot won't JIT (C1 or C2) any method whose bytecode exceeds `HugeMethodLimit` while `DontCompileHugeMethods` is on. Such a method stays in the bytecode interpreter forever.
  - `DontCompileHugeMethods` is a `product` flag, `true` by default.
  - `HugeMethodLimit` is a `develop` flag fixed at **8000** in product builds. Only the boolean can be changed ([`compiler_globals.hpp`](https://github.com/openjdk/jdk25u/blob/master/src/hotspot/share/compiler/compiler_globals.hpp), [`compilationPolicy.cpp`](https://github.com/openjdk/jdk25u/blob/master/src/hotspot/share/compiler/compilationPolicy.cpp) `can_be_compiled`: `if (DontCompileHugeMethods && m->code_size() > HugeMethodLimit) return false;`).
- Endive turns each WASM function into one JVM method. Its compiler keeps only its own dispatch chunks under that limit (`endive.hugeMethodLimit`, [`Compiler.java`](https://github.com/bytecodealliance/endive/blob/main/compiler/src/main/java/run/endive/compiler/internal/Compiler.java)). It never splits guest functions.
  - A WASM function over the JVM's 64 KB method limit can't be compiled at all; it falls back to the interpreter ([build-time compiler docs](https://github.com/bytecodealliance/endive/blob/main/docs/docs/execution/build-time-compiler.md)).
  - Splitting oversized functions is an open request ([#170](https://github.com/bytecodealliance/endive/issues/170)). The maintainer's reply: "mechanical splitting can be done but dramatically impacts performance … After extensive analysis and experiments I decided to drop the effort and focused on Redline".

**Largest generated methods per guest variant** ([`results/sizes-summary.txt`](endive-no-flags/results/sizes-summary.txt); D/E use `typed::make_requests` and `typed::make_bids_annot`):

| Guest variant | Hot functions over 8,000 B | `typed::make_requests` | `typed::make_bids_annot` |
|---|---|---:|---:|
| O3 (#12's guest) | `make_requests` | 15,990 | 4,833 |
| O2 | `make_requests` | 15,046 | 4,271 |
| O3, `-inline-threshold=50` | `make_requests` | 16,536 | 4,476 |
| O3 → `wasm-opt -Oz --outlining` | `make_requests` | 16,429 | 5,007 |
| Os | none | 2,773 | 1,175 |
| **O3 + `split` feature** | **none** | < 1,667 (largest pieces: `ImpExt` visitor 4,110, `Imp` visitor 3,150, `write_imp` 1,667) | 4,833 |

- The functions still over 8,000 in the split builds (`value::make_request`, `typed::make_bids_json`) belong to #12's A–C variants, which aren't on the D/E path.
- **The `split` change:**
  - `#[inline(never)]` on each hand-written serde `visit_map`/`visit_seq`.
  - The request parse and the per-imp writer moved into `#[inline(never)]` functions.
  - About 15 lines, all behind `cfg_attr(feature = "split", …)`.
- For a Shared Adapter this would be a **build-time rule** ("no compiled function over 8,000 JVM bytecodes"). CI can check it with the same `javap` pass. Splitting would be up to the author or a proc-macro, since no compiler flag does it reliably: lowering LLVM's inline threshold made `make_requests` *bigger*.

## Results (payload `lt` unless noted; overhead vs native `OpenxBidder` in the same JVM, µs per MakeRequests+MakeBids)

| Endive build | Guest | JVM flags | D | **E** | E, CPU at 4 threads | E on `heavy` | `mr_typed` | `mb_typed_annot` on projection |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 1.1.0 runtime compiler | O3 | none | +44.1 | **+34.3** | +37.2 | +81.5 | 31.9 | 4.9 |
| 1.1.0 runtime compiler | O3 | `-XX:-DontCompileHugeMethods` | +21.5 | +11.4 | +11.6 | +28.2 | 11.5 | 4.9 |
| 1.1.0 bytecode | O3 | none | +43.6 | +34.3 | +36.6 | +80.2 | 31.9 | 4.8 |
| 1.1.0 bytecode | O2 | none | +41.6 | +31.7 | +33.8 | +72.5 | 30.2 | 4.8 |
| 1.1.0 bytecode | O3 `-inline-threshold=50` | none | +49.2 | +36.3 | +39.5 | +85.2 | 33.7 | 4.9 |
| 1.1.0 bytecode | O3 → `wasm-opt -Oz --outlining` | none | +51.5 | +39.7 | +43.1 | +91.5 | 35.5 | 5.0 |
| 1.1.0 bytecode | Os | none | +28.9 | +13.4 | +13.7 | +31.7 | 12.4 | 5.7 |
| 1.1.0 bytecode | **O3 + split** | **none** | +22.0 | **+12.0** | **+11.6** | **+27.5** | 11.4 | 4.9 |
| 1.1.0 bytecode | O2 + split | none | +22.0 | +11.8 | +11.5 | +27.6 | 11.3 | 4.8 |
| 1.1.0 bytecode | O3 + split → `wasm-opt -O3` | none | +22.4 | +11.9 | +12.2 | +27.6 | 11.3 | 4.9 |
| 1.1.0 bytecode | O3 + split | `-XX:-DontCompileHugeMethods` | +21.9 | +11.6 | +11.9 | +27.6 | 11.5 | 4.9 |
| `main` bytecode | O3 + split | none | +21.5 | +11.5 | +11.5 | +27.8 | 11.4 | 4.8 |
| 1.1.0 **Redline** | O3 | none | +47.6 | +41.9 | +101.4 | +50.0 | 23.9 | 22.5 |
| `main` **Redline** | O3 | none | +1.8 | **−0.7** | **−1.5** | **+5.8** | 3.0 | 1.3 |
| `main` **Redline** | O3 + split | none | +1.7 | −0.8 | −1.7 | +6.3 | 3.0 | 1.3 |

- **Native baselines:** `OpenxBidder` runs 16.0–16.4 µs on `lt` (19.6–20.0 µs CPU at 4 threads) and 21.8–22.8 µs on `heavy` across runs, consistent with #12.
- **Repeatability:** within a run, the five medians agree to < 0.5 µs. #12's Endive numbers reproduce: +34.1 and +12.4 then vs +34.3 and +11.4 now.
- **Redline boundary costs** (`main`):
  - An export call is 0.07 µs, against 0.01 µs for bytecode.
  - Writing the 1.6 KB request into native memory takes 0.02 µs. Unlike GraalWasm's polyglot API, Endive's `Memory.write` is a bulk copy.
  - 1.1.0's 21.5 µs per call is the per-call watchdog thread ([#201](https://github.com/bytecodealliance/endive/issues/201)): "create, start and then interrupt a new watchdog `Thread` on **every** call into native code".
- **Redline guest speed:** `mr_typed` 3.0 µs and `mb_typed_annot` 1.3 µs. That is on par with wazero in #12 (3.1 µs incl. write and 1.4 µs) and ~4× faster than Endive bytecode at its best.

## Answers

### Can plain Endive (JVM bytecode) hit ~7.5 µs without flags? No.

- The flag can be dropped: a split guest without it matches the flag exactly (+12.0 vs +11.4–11.6 µs). But the bytecode floor is ~+12 µs on `lt` and ~+28 µs on `heavy`.
- That's ~8 % per-auction CPU at 5–10 bidders on #11's baselines. It **fails** criterion (3) at catalogue scale, and passes the one-adapter PoC gate (~0.6–1 %).
- The gap is how fast the JIT'd guest runs (`mr_typed` 11.4 µs vs 3.0 µs native-compiled), not the boundary. Upstream's leads for closing it on bytecode all need JVM flags (C2 inlining limits) or a custom memory ([#224 comment](https://github.com/bytecodealliance/endive/issues/224)): "Getting the same speed without JVM flags would take careful function-size work in the compiler … That may never be worth the complexity".

### Does Endive have a flag-free passing option? Yes: Redline, once the per-call-thread fix ships.

- **Endive `main` Redline: E is −0.7 µs (`lt`), −1.5 µs CPU at 4 threads, and +5.8 µs on `heavy`.** At 5–10 bidders that's within noise of today's per-auction CPU, the only server measurement so far under 7.5 µs on both payloads.
- **What it requires** ([Redline docs](https://github.com/bytecodealliance/endive/blob/main/docs/docs/experimental/redline.md), [1.1.0 release post](https://github.com/bytecodealliance/endive/blob/main/docs/blog/2026-09-03-endive-1.1.0.md)):
  - **Platforms:** `redlineExperimental` on the Endive Maven plugin plus the `redline-runner-experimental` dependency (Panama FFM, Java 25+). A jffi runner exists for Java 11+.
  - **Build output:** native code is generated at build time for Linux/macOS/Windows on x86-64/aarch64 and bundled as jar resources. Nothing compiles at runtime. On any other platform it silently falls back to the build-time bytecode (so the `split` guest still matters as the fallback).
  - **WASM features:** no SIMD, exception handling, GC or multi-memory. The Shared Adapter guest flags already exclude SIMD (#1, "How Hosts consume Prebid Core").
  - **Stability:** it is **experimental**. "We want to be able to perform breaking changes without respecting SemVer" ([why.md](https://github.com/bytecodealliance/endive/blob/main/docs/docs/experimental/why.md)).
  - **Jar size:** native code is ~1.2–1.5 MB per platform for this guest. The guest still carries #12's unused A–C code, so a single-path guest would be smaller.
- **No JVM flags needed today, but a warning.** On JDK 25 the FFM downcall prints a one-time "restricted method" warning without `--enable-native-access`. A future JDK will deny it by default ([JEP 472](https://openjdk.org/jeps/472)).
  - PBS-Java runs as an executable jar, so `Enable-Native-Access: ALL-UNNAMED` in its manifest avoids both the warning and a command-line flag. JEP 472 documents this attribute.
- **What it is not:** "pure JVM" in #3's sense. It runs Cranelift-generated machine code in the JVM process, outside the JVM's verifier and managed heap (linear memory is an `mmap`'d off-heap reservation).
  - Redline's security story is Cranelift's bounds-checked code with RX-only code pages ([Redline post](https://github.com/bytecodealliance/endive/blob/main/docs/blog/2026-04-16-chicory-redline.md)). That's the same model as Wasmtime, so it's comparable to what PBS-Go would get from a compiling runtime.
  - PBS-Java maintainers would be asked to accept JNI-free native code via FFM, not a GraalVM JDK.

## Caveats

- **One machine.** macOS arm64 (M5 Max), Temurin 25.0.4.1, not Corretto on x86-64 Linux. The `x86_64-unknown-linux-gnu` Redline code was generated but not run.
- **Unreleased Endive.** The passing Redline numbers are from `main` at `1580f53`. The fix ([#210](https://github.com/bytecodealliance/endive/pull/210)) and [#228](https://github.com/bytecodealliance/endive/pull/228) (precompiled trampolines) landed after 1.1.0, and no 1.2 release date is published. Redline 1.1.0 must not be used.
- **Experimental module.** API and artifact IDs may change without SemVer. A PoC could pin a version, but production would want Redline out of experimental.
- **Memory not measured.** Redline reserves each instance's maximum linear memory as virtual `mmap` space and commits it on growth. RSS per pooled instance (criterion 6) wasn't measured.
- **Same guest shortcuts and Java-semantics normalization as #12**, and the same single Adapter (OpenX). Redline's advantage should hold for Adapters with more real logic, since it's a compiler-quality gap.
- **Not measured:** Redline's jffi runner (Java 11+); Redline under PBS-Java's real load test; interrupt/timeout behaviour under the new shared watchdog.

## Sharp questions / fog surfaced

1. **PBS-Java's option without a GraalVM JDK is Endive Redline, not plain Endive.** The maintainer question changes from "would PBS-Java accept a GraalVM JDK?" to "would PBS-Java accept experimental, FFM-loaded native code (Cranelift, bundled per platform, `Enable-Native-Access` in the manifest)?" When does Endive release #210 and take Redline out of experimental?
2. **Re-run Redline on x86-64 Linux / Corretto 25**, ideally inside #11's load test with instance pooling, and measure RSS per instance. This folds into the existing "Production-grade benchmarks" fog.
3. **Guest build rule for the bytecode fallback:** if Redline ever falls back (unsupported platform, missing runner), the guest runs as bytecode. Should Prebid Core enforce "no function over 8,000 JVM bytecodes" in CI so the fallback is +12 µs rather than +34 µs? This belongs to "How Hosts consume Prebid Core" (guest build flags as a cross-Host contract).
