# Can each server Host embed a WASM module acceptably?

Research for [#3](https://github.com/JoelPM/prebid-core/issues/3) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). Vocabulary follows [`CONTEXT.md`](../CONTEXT.md).

## TL;DR

- **PBS-Go: yes.** [wazero](https://github.com/tetratelabs/wazero) is pure Go, has no cgo, and depends only on Go and `x/sys`. It runs a Rust-compiled OpenX **Adapter** in **~104 µs per call** on a reused instance, against **~64–71 µs** for PBS-Go's real Hand-written OpenX Adapter: about +35–40 µs per bidder call. Fresh instance per call costs ~233 µs. A Go-compiled guest is not viable (~743 µs, 8.4 MB module).
- **PBS-Java: viable but costly, and the best option has strings attached.** Endive (the Bytecode Alliance fork of Chicory) needs no native code and is Apache-2.0. Its runtime compiler runs the same Rust guest in **~400 µs**, about **14× a native Jackson baseline (~28 µs)**. That cost lands on the Vert.x event-loop thread, which calls the Adapter inline. GraalWasm runs it in **~121 µs**, but only on a GraalVM JDK (PBS-Java ships on Corretto 25). On stock Temurin 25 it falls back to an interpreter (~8 ms). The community *polyglot isolate* option (UPL, 25.1+) does work on stock JDK, but each host↔guest call crosses a boundary costing ~0.28 µs, which made the naive ABI ~560 µs.
- **Trusted Server: compile from source is the only realistic path.** A Rust Prebid Core crate as a normal Cargo dependency (TS already takes git deps such as `edgezero-*` and uses `serde_json`) costs nothing at the boundary and works on Fastly, Cloudflare and Spin. Component composition only fits Spin. It is unconfirmed on Fastly and doesn't apply to Cloudflare's `wasm32-unknown-unknown`/wasm-bindgen build.
- **Form C (JS engine in WASM) is expensive on every server Host.** Javy/QuickJS under wazero: **~527 µs per call**, of which ~238 µs is just instantiating the pre-initialized QuickJS image. On the JVM, quickjs4j (QuickJS AOT-compiled to bytecode by Endive) takes **~1.26 ms per call**. Javy modules don't run on Endive's compiler at all (SIMD opcodes unsupported). On Endive's SIMD interpreter they hit a JSON.parse failure unless Javy's simd-json is disabled, and then take ~61 ms. Native V8 runs the same JS in ~45 µs, so form C is roughly 10–30× native.
- **Budget context.** Prebid.js's default s2s timeout is the lesser of 75 % of `bidderTimeout` or 750 ms. PBS-Java clamps per-bidder tmax to `[50, 5000]` ms. A 0.1–0.4 ms translation cost is small against latency, but it is **CPU per bidder per auction**, and that is what decides go criterion (3). Whether +40 µs (Go) or +370 µs (Java) is "within noise" depends on PBS's per-auction CPU baseline, which this ticket didn't measure (see Fog).

## Method

Everything ran on an Apple M5 Max (macOS, arm64), single-threaded, in steady state after warm-up. Treat the numbers as **relative**. Production x86 boxes will differ in absolute terms, but the ratios should hold roughly.

- **Workload:** one Adapter round trip, `MakeRequests` then `MakeBids`, on a realistic payload. The request is 3.1 KB with 4 imps (3 banner, 1 rewarded video), site, device, 5 EIDs, GDPR/GPP and schain. The response is 11.3 KB with 4 bids and ~1.5 KB of `adm` each. The generator is in [`gen/main.go`](server-wasm-embedding/gen/main.go).
- **Native baselines:**
  - **Go:** a verbatim copy of PBS-Go's `adapters/openx/openx.go`. The `adapters` package was stubbed because it imports `config`, which imports viper, and viper doesn't build for wasip1.
  - **Rust:** a hand port over `serde_json::Value`.
  - **Java:** a hand port over Jackson trees, since PBS-Java uses Jackson.
  - **JS:** a hand port run on Node 26 (V8).
- **Correctness check:** the outgoing OpenX request body is byte-for-byte semantically identical across the Go adapter, the Rust port (native and every WASM runtime) and the JS port (V8, Javy/wazero, quickjs4j and Endive).
- **Guests:**
  - **Rust:** `wasm32-unknown-unknown` cdylib with LTO, `opt-level=3`, `panic=abort`. **122 KB.** ABI is `alloc`/`dealloc`/`adapt(ptr,len,ptr,len)->u64`.
  - **Go:** the real adapter code built with `GOOS=wasip1` and `-buildmode=c-shared` + `go:wasmexport`. **8.4 MB.**
  - **JS:** Javy 9.1.0, statically linked. **1.3 MB.** It is a WASI command, so each invocation is a fresh instance with stdin/stdout I/O.
- **Code:** all benchmark source is in [`server-wasm-embedding/`](server-wasm-embedding/) and the raw output is in [`results/`](server-wasm-embedding/results/). In the Endive output, the label "Chicory runtime-compile" is a leftover string; that run used Endive.

## Results (µs per Adapter call, lower is better)

| Host runtime | Guest | Reused instance | Fresh instance/call | Notes |
|---|---|---:|---:|---|
| **Native** Go (real PBS-Go OpenX) | — | 64–71 | — | 97 KB, 970 allocs/op |
| **Native** Rust (serde_json) | — | 41.8 | — | |
| **Native** Java 25 (Jackson tree) | — | 28.5 | — | |
| **Native** Node 26 / V8 (JS port) | — | 45 | — | |
| wazero 1.12 compiler | Rust | **103.8** | 233 | compile 22 ms once; 1.25 MB linear memory; noop call 0.02 µs |
| wazero 1.12 compiler | Go (wasip1) | 743 | 12,942 | compile 1.17 s; 37 MB linear memory; Go-in-wasm GC is the cost |
| wazero 1.12 compiler | Javy (QuickJS) | n/a | **527** | empty-JS instantiate alone 238 µs; 3.7 MB alloc/op; simd-json flag made no difference |
| wazero 1.12 interpreter | Rust / Javy | 6,250 | 20,666 (Javy) | interpreter not viable |
| Endive 1.1.0 runtime compiler (Temurin 25) | Rust | **403** | 421 | compile 140 ms; noop 0.01 µs. Chicory 1.7.5 identical (395/414); `-XX:-DontCompileHugeMethods` → 361 |
| Endive 1.1.0 interpreter | Rust | 16,178 | 15,864 | not viable |
| Endive 1.1.0 | Javy | — | compiler: **fails** (`Unhandled opcode: V128_LOAD`) | SIMD interpreter: JSON.parse throws with default simd-json; with `-J simd-json-builtins=n`, 61,133 µs |
| quickjs4j 0.1.0 (QuickJS → Endive build-time compiled) | JS | **1,262** (same engine) | 2,638 | noop JS fn 107 µs; engine create 152 ms |
| GraalWasm 25.0.2 on GraalVM CE 25 JDK | Rust | **121** | 184 | context+instantiate 107 ms; noop 0.03 µs |
| GraalWasm 25.0.2 on Temurin 25 | Rust | 8,062 | 7,836 | fallback runtime = interpreter only |
| GraalWasm isolate-community 25.4 on Temurin 25 | Rust | 562 | 957 | noop 0.28 µs; cost is the ~1,800 `writeBufferLong` crossings needed to copy 14 KB in (no bulk write API) |
| Trusted Server (Fastly/CF/Spin) | Rust crate compiled in | ≈ in-module Rust speed | — | no boundary; WASM-vs-native slowdown already paid by all of TS. Measured ~2.5× native under wazero; Wasmtime (Fastly) not measured |

**Memory:**
- **Rust guest:** 1.25 MB of linear memory per live instance. A pool of one instance per core is a few tens of MB.
- **Javy:** 1.5 MB per instance, plus ~3.7 MB of host allocation per call (instantiation copies the snapshot).
- **Go guest:** 37 MB per instance.
- **JVM:** quickjs4j and the Endive JS runs left ~1.1–1.3 GB of heap in use at exit (unbounded benchmark loop, not tuned). Treat this as "GC pressure is real", not as a footprint figure.

## Per Host

### PBS-Go

- **Runtime choice: wazero.** It "has *zero dependencies*, and doesn't rely on CGO", with "no dependencies except Go and `x/sys`" ([README](https://github.com/tetratelabs/wazero)). It is Apache-2.0, 1.0 since March 2023, and currently v1.12.0.
  - The compiler is supported on amd64/arm64 only. Elsewhere it falls back to the interpreter, which is ~60× slower in our run, so production must be amd64/arm64.
  - Alternatives like wasmtime-go/wasmer-go need cgo and native libraries.
- **Dependency practice:**
  - `go.mod` has ~45 direct deps and is vendored at build time (`go mod vendor` in the [Dockerfile](https://github.com/prebid/prebid-server/blob/master/Dockerfile)).
  - The Dockerfile already sets `CGO_ENABLED 1` "because some modules depend on native C code" (51Degrees, WURFL), so cgo isn't a hard veto. Still, a pure-Go runtime is the easier sell.
  - The contributor docs (`docs/developers/contributing.md`, `code-reviews.md`) state no dependency policy beyond "inject dependencies".
- **Threading:** `api.Function.Call` "is not goroutine-safe" (wazero `api/wasm.go`). PBS-Go calls adapters from per-bidder goroutines, so it needs a pool of instances (one `sync.Pool` of modules) or a fresh instance per call (+130 µs).
- **Startup cost:** compiling the Rust guest once takes ~22 ms. wazero has a compilation cache for repeat starts.
- **Verdict:** meets "nothing obviously vetoable". Overhead is ~+35–40 µs per OpenX call versus the Hand-written Adapter (+50–60 %), most of it serde_json-in-wasm speed rather than the boundary (a noop call costs 20 ns).

### PBS-Java

- **Endive (formerly Chicory):** Dylibso's Chicory was forked into the Bytecode Alliance as **Endive** ([repo](https://github.com/bytecodealliance/endive); 1.0.0 June 2026, 1.1.0 September 2026; `run.endive:*` on Maven Central). Chicory's last release is 1.7.5 (March 2026). New work should target Endive.
  - Pure JVM, Apache-2.0, needs Java 11+. Its only dependency is ASM (for the compiler).
  - The runtime compiler translates each Wasm function to a JVM method. Functions that are too big fall back to the interpreter ([docs](https://endive.run/docs/execution/runtime-compiler)).
  - A build-time compiler / Maven plugin removes the ~140 ms startup compile, but steady state is the same JIT'd bytecode.
  - Its README lists performance as "Ongoing". Measured cost is ~400 µs per call, 3.9× wazero and 14× native Java.
  - `Instance` "is not thread-safe" ([docs](https://endive.run/docs/)). PBS-Java invokes `bidder.makeHttpRequests`/`makeBids` inline on the Vert.x event loop (`HttpBidderRequester.java`), so it needs one instance per event-loop thread. Each 0.4 ms call blocks that loop.
  - **SIMD:** the Endive compiler rejects v128 opcodes. The separate `simd` interpreter module depends on `jdk.incubator.vector`: Chicory 1.7.5's version broke on JDK 25 and 27 (`NoSuchFieldError UNSIGNED_LT`), while Endive 1.1.0's ran. So guests must be built **without** `+simd128`, which is the Rust default for `wasm32-unknown-unknown`.
- **GraalWasm:** the fastest JVM option (~121 µs) and UPL-licensed (`org.graalvm.polyglot:wasm`). But optimizing execution needs a GraalVM JDK.
  - On "Oracle JDK 25 or OpenJDK 25" the optimizing runtime is available "only through a polyglot isolate", otherwise "Guest application code is executed in interpreter-only mode" ([embedding docs](https://www.graalvm.org/latest/reference-manual/embed-languages/)). Our run confirmed ~8 ms on Temurin. Manually putting `jdk.graal.compiler` on the upgrade module path with JVMCI failed on Temurin 25.0.4 (config mismatch).
  - Community isolates (`wasm-isolate-community`, UPL, 25.1+) add ~23 MB of native image per platform and work on stock JDK. But each `Value` call is ~0.28 µs, so the ABI would need to move bytes in a few calls; there is no bulk `writeBuffer`. Not tried: passing a host `ByteBuffer`, or having the guest pull input via one imported function.
  - Switching PBS-Java's base image from `amazoncorretto:25` to GraalVM JDK is the kind of change maintainers might veto.
- **Dependency practice:**
  - Maven with ~89 declared artifacts, Java 25 (`extra/pom.xml`).
  - The [code-style doc](https://github.com/prebid/prebid-server-java/blob/master/docs/developers/code-style.md) asks for versions as `pom.xml` properties and bans using transitive deps directly. There is no rule against adding a runtime.
  - Endive adds runtime+wasm+wasi+compiler+ASM (~0.6 MB of jars). GraalWasm adds Truffle (~17 MB `truffle-api`) plus the language jars.
- **Verdict:** viable on a pure-JVM runtime, but at ~+370 µs CPU per bidder call on the event loop. That probably fails criterion (3) unless Endive's performance improves or PBS-Java accepts GraalVM/isolates.

### Trusted Server

- **Build shape:** a single Rust workspace (`rust-toolchain` 1.95, edition 2024) targeting `wasm32-wasip1` for Fastly and Spin and `wasm32-unknown-unknown` for Cloudflare.
  - It already depends on `serde_json`, has a `trusted-server-openrtb` types crate, and an `integrations/` module that includes `prebid.rs`, which calls a remote PBS.
  - It already takes git-tagged deps (`edgezero-* v0.0.9` from IABTechLab).
  - [CONTRIBUTING](https://github.com/IABTechLab/trusted-server/blob/main/CONTRIBUTING.md) says to keep platform-specific deps out of `trusted-server-core`. AGENTS.md says "Do not add unnecessary dependencies without justification".
- **Option 1, compile from source:** a `prebid-core` Rust crate (no I/O, no clock, no threads, `serde_json`) as a workspace or git dep.
  - Zero boundary cost, one artifact, works on all three platforms.
  - Constraints: no `std::time::Instant/SystemTime::now` (TS lints for this because it panics on Cloudflare), no threads, and no C deps (C complicates `wasm32-unknown-unknown`).
- **Option 2, component composition** (`wac`/`wasm-tools compose`): needs component-model hosting.
  - Spin is component-native.
  - The Cloudflare adapter is a wasm-bindgen core module, so composition doesn't apply there.
  - Fastly's WASI 0.2 / component support for Compute services could not be confirmed from Fastly docs. TS uses the `fastly` 0.12 SDK on `wasm32-wasip1`.
  - **Don't plan on composition.**
- **Platform limits that matter:**
  - Fastly gives 128 MB heap, **50 ms CPU** per request, a 100 MB package, and 32 backend requests ([limits](https://docs.fastly.com/products/compute-resource-limits)). By default it starts a fresh sandbox per request; reusable sandboxes are opt-in ([lifecycle](https://www.fastly.com/documentation/guides/compute/developer-guides/sandbox-lifecycle/)), and TS has an experimental `reusable-sandbox` feature.
  - Cloudflare gives 64 MiB uncompressed per Worker, 128 MB memory, and 1 s startup ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
  - A Rust adapter adds ~100 KB.
- **Form C on TS:** embedding QuickJS in TS's module (for example via rquickjs) means compiling C to both wasm targets (wasi-sdk; harder for `-unknown-unknown`). It adds ≥ ~0.9–1.3 MB (Javy README: static modules are "at least 869 KB") and costs ~0.3–0.5 ms of QuickJS work per call out of Fastly's 50 ms CPU budget. On Cloudflare the host *is* V8, so a JS Adapter could run natively instead (unexplored).
- **Verdict:** form A/B fits TS with no runtime cost. Form C is possible but heavy.

## Form C (JS engine in WASM) overall

- **Runtime cost:**
  - wazero + Javy: ~527 µs, about 12× V8 and 8× the Go Hand-written Adapter. The floor is ~238 µs per call because Javy modules are one-shot WASI commands. Keeping one QuickJS instance and `invoke`-ing precompiled bytecode would remove part of that, but wasn't measured on wazero.
  - JVM: quickjs4j is the maintained route at ~1.26 ms per call even with a warm engine.
- **Maturity:** quickjs4j is 0.1.0 (Apache-2.0, maintained by the Chicory/Endive author). Javy is a Bytecode Alliance project at 9.1.0.
- **Conclusion:** form C fails criterion (3) on PBS-Java and is marginal on PBS-Go. It needs a reusable-instance design and a per-auction CPU baseline before it can be judged.

## Sharp questions / fog surfaced

1. **What is PBS's per-auction CPU baseline?** "Within noise" needs a denominator: CPU per auction and per bidder call in PBS-Go and PBS-Java under realistic load. Without it, +40 µs (Go) and +370 µs (Java) can't be judged.
2. **Is ~400 µs on Endive fundamental?** Profile it: Endive's codegen for serde_json-heavy code, memory bounds checks, and HotSpot inlining limits. An alternative Rust guest built on typed structs or `simd-json`-free fast paths might narrow the gap. Endive's "Performance" roadmap item and its experimental "redline" compiler artifacts are worth asking about.
3. **Would PBS-Java maintainers accept GraalVM JDK or the community polyglot isolate (+23 MB native lib per platform)?** If so, design a coarse-grained ABI with one call in and one call out, and re-measure the isolate path.
4. **Guest build flags are a cross-Host contract.** No `simd128` (Endive), no clock, no threads, panic=abort, and `wasm32-unknown-unknown` with no WASI imports. Should Prebid Core pin these as part of the package spec (feeds "How Hosts consume Prebid Core")?
5. **Fastly component-model support** is unverified. It only matters if anyone pushes composition over compiling from source.
6. **Form C reuse design:** measure Javy's dynamic-linked plugin `invoke` on a long-lived instance under wazero and Wasmtime before ruling form C fully out.
7. **Production-hardware numbers:** rerun on x86-64 Linux at PBS-typical concurrency, with instance pools, to see GC and allocator contention (Javy's 3.7 MB/op and the JVM heap growth).
