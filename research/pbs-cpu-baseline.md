# What is PBS's per-auction CPU baseline?

Research for [#11](https://github.com/JoelPM/prebid-core/issues/11) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It follows on from [#3](https://github.com/JoelPM/prebid-core/issues/3) ([findings](https://github.com/JoelPM/prebid-core/blob/research/server-wasm-embedding/research/server-wasm-embedding.md)). Vocabulary follows [`CONTEXT.md`](../CONTEXT.md).

## TL;DR

- **Nobody publishes a per-auction CPU figure for either PBS.** No Prebid doc, issue, PR or discussion gives CPU per auction or requests per core. The closest maintainer statements are qualitative: JSON is "perhaps 10–30%" of CPU, an average request is ~5 KB, and PBS has "not much benchmark coverage". PBS-Go's two in-repo auction benchmarks are broken and only time the HTTP 400 rejection path (details below).
- **Measured baseline.** This was a local load test: macOS arm64, 4 cores, 1,000 auctions/s, 3 banner imps, a stub bidder in a separate process, no stored requests, no cache, no analytics.

  | | 1 bidder | 5 bidders | 10 bidders | Each extra bidder (5→10) |
  |---|---:|---:|---:|---:|
  | PBS-Go | ~0.66–0.86 ms | **~1.17 ms** | **~2.07 ms** | ~180 µs |
  | PBS-Java | ~0.48 ms | **~0.75 ms** | **~1.51 ms** | ~150 µs |

  At 5–10 bidders, repeat runs agree within 1–3 %.
- **Today's Hand-written Adapters are a small slice of that.** On the same payload, `MakeRequests`+`MakeBids` costs **~21–33 µs per call** natively in Go (46 µs for sharethrough, which makes 3 HTTP requests). That is ~12–14 % of a PBS-Go auction. The rest of each bidder's cost is PBS core work: per-bidder request preparation, JSON, gzip, HTTP and bid processing.
- **WASM overhead as a share of per-auction CPU.** The table assumes every bidder is a Shared Adapter, using #3's per-call deltas (measured on a larger payload, so this is the worst case):

  | | 5 bidders | 10 bidders | If overhead scales with this payload's adapter work |
  |---|---:|---:|---:|
  | PBS-Go / wazero (+40 µs) | **+17 %** | **+19 %** | +8 % |
  | PBS-Java / Endive (+370 µs) | **+250 %** | **+245 %** | +110 % |
  | PBS-Java / GraalWasm (+93 µs) | **+62 %** | **+62 %** | +27 % |

  With only one Shared Adapter (the Proof of Concept), the overheads are Go +2–3 %, GraalWasm +6–12 % and Endive +25–50 %.
- **Proposed threshold for go criterion (3).** On x86-64 Linux, at 5–10 bidders, Shared Adapters together may add **≤ 5 % of per-auction PBS CPU**, and p99 latency must stay within run-to-run noise. That works out to a per-call overhead of about **≤ 10–12 µs on PBS-Go and ≤ ~7.5 µs on PBS-Java**. A separate PoC gate would require one Shared Adapter in a 5–10-bidder auction to add ≤ 5 %. Against these numbers:
  - PBS-Go passes the PoC gate but **fails** at catalogue scale by ~2–4×. The guest needs to get faster.
  - GraalWasm is borderline at the PoC gate.
  - Endive fails both.

## Sources checked (published data, maintainers, issues)

| Source | What it says |
|---|---|
| [prebid/prebid-server#3437](https://github.com/prebid/prebid-server/issues/3437) "Performance Optimization Discussion" (open) | No baseline numbers. A host (Slind14) claims PBS-Go "could be 6 to 10 times faster", and that their proprietary stack does "an equal amount of QPS at 1/8th of the CPU usage". Maintainer SyntaxNode: PBS "is often run at a very high scale, where efficiency gains can directly translate to cost savings", and "There's not much benchmark coverage in this project". |
| [prebid/prebid-server#4759](https://github.com/prebid/prebid-server/issues/4759) sonic evaluation (open) | Asks "What fraction of CPU does prebid-server spend in JSON in production?" SyntaxNode answers "to check. perhaps 10-30%", and "I think an average of 5k would be reasonable" for request size. Benchmarks are JSON-codec only (M4 Pro). |
| [prebid/prebid-server#3754](https://github.com/prebid/prebid-server/issues/3754) | A host sees ~5K goroutines in normal operation and says the "golang scheduler spends a lot of CPU time" at high RPS. No per-auction figure. |
| [PBS hosting docs](https://github.com/prebid/prebid.github.io/blob/master/prebid-server/hosting/pbs-hosting.md) | "a mix of network and CPU work". No sizing numbers. |
| prebid-server-java issues | Searched for performance, benchmark, cpu, load test, throughput, latency and event loop: nothing quantitative. The only CPU-related item is `server.cpu-load-monitoring` ([PR #2635](https://github.com/prebid/prebid-server-java/pull/2635), ported to Go as [#3151](https://github.com/prebid/prebid-server/issues/3151)). |
| GitHub Discussions (both repos), web search | Nothing about PBS per-auction CPU or per-core QPS. |

### PBS-Go's in-repo benchmarks don't measure an auction

[`endpoints/openrtb2/auction_benchmark_test.go`](https://github.com/prebid/prebid-server/blob/master/endpoints/openrtb2/auction_benchmark_test.go) on master (`a916b19ef`):

- **`BenchmarkOpenrtbEndpoint`** reports 6.5 µs/op and 92 allocs. That is the cost of returning 400 `request.site should include at least one of request.site.id or request.site.page`. Adding `site.page` surfaces a second 400, `unknown bidder: 'appnexus'`, at 25 µs wall and 45 µs CPU per op.
- **`BenchmarkValidWholeExemplary`** reports ~3.1–3.8 µs/op and 25 allocs. It reuses one `httptest.NewRequest` for every iteration, so after the first iteration the body is empty.

Raw output: [`results/pbs-go-repo-benchmarks.txt`](pbs-cpu-baseline/results/pbs-go-repo-benchmarks.txt). Neither benchmark is usable as a baseline. PBS-Java has no JMH or auction benchmarks.

## Load test method

All code is in [`pbs-cpu-baseline/`](pbs-cpu-baseline/).

- **Hosts:**
  - PBS-Go master `a916b19ef`, built with Go 1.27.2, run with `GOMAXPROCS=4`.
  - PBS-Java master, built with `mvn package` and run on Temurin 25.0.4.1 with `-XX:ActiveProcessorCount=4 -Xms2g -Xmx2g` and `server.http.server-instances: 4`.
  - Configs are in [`config/`](pbs-cpu-baseline/config/). Every bidder's endpoint is overridden to the stub. Currency fetch is off, GDPR defaults to 0, and there's no account, stored request or cache.
- **Bidders:** appnexus, openx, pubmatic, ix, triplelift, sovrn, sharethrough, criteo, medianet and smartadserver, used in that order for the 1/3/5/10-bidder runs.
  - All are real Hand-written Adapters.
  - Several use gzip toward the bidder by default, which is kept here because that's production behaviour.
  - Every run returned 3 bids per bidder and no errors (`sanity:` lines).
- **Request:** [`requests/gen.py`](pbs-cpu-baseline/requests/gen.py) builds a 2.0–3.3 KB request with:
  - 3 banner imps (2 sizes each) with gpid
  - site, device and 5 EIDs
  - schain, `us_privacy`
  - `targeting` with `includebidderkeys`
- **Stub bidder:** [`stub/main.go`](pbs-cpu-baseline/stub/main.go) runs as a separate process, so its CPU isn't counted against PBS. It returns one bid per imp (~1.4 KB `adm`) after a 20 ms think time.
- **Load generator:** [`loadgen/main.go`](pbs-cpu-baseline/loadgen/main.go) sends at a fixed rate (open loop). It warms up for 15–40 s, then measures for 30 s.
  - **CPU** is the server process's user+sys time from `ps` across the measured window, divided by the number of completed requests.
  - [`run-sweep.sh`](pbs-cpu-baseline/run-sweep.sh) drives the sweep.
- **Adapter microbenchmark:** [`adapterbench/adapters_test.go.txt`](pbs-cpu-baseline/adapterbench/adapters_test.go.txt), dropped into a PBS-Go checkout. It runs each adapter's `MakeRequests`+`MakeBids` on exactly the per-bidder request and stub response used in the load test.

## Results

### Per-auction CPU (µs of server CPU per `/openrtb2/auction`)

| Host, load | 1 bidder | 3 | 5 | 10 | Cores used at 10 bidders | p50 / p99 latency at 10 bidders |
|---|---:|---:|---:|---:|---:|---:|
| PBS-Go, 1,000 rps, run 1 | 658 | 1,016 | 1,159 | 2,090 | 2.09 of 4 | 21.2 / 24.8 ms |
| PBS-Go, 1,000 rps, run 2 | 864 | — | 1,183 | 2,066 | 2.06 | 21.2 / 22.4 ms |
| PBS-Go, 1,500 rps | — | — | 1,117 | 2,012 | 3.01 | 22.8 / 30.3 ms |
| PBS-Java, 1,000 rps, run 1 | 474 | 635 | 745 | 1,497 | 1.50 | 21.4 / 23.5 ms |
| PBS-Java, 1,000 rps, run 2 | 484 | — | 749 | 1,524 | 1.52 | 21.5 / 23.8 ms |
| PBS-Java, 2,000 rps | — | — | 865 | 1,669 | 3.31 | 27.2 / 146 ms |

Raw output: [`results/pbs-go-sweep.txt`](pbs-cpu-baseline/results/pbs-go-sweep.txt) and [`results/pbs-java-sweep.txt`](pbs-cpu-baseline/results/pbs-java-sweep.txt).

**How load changes the per-auction figure:**
- **Go at low load:** with `GOMAXPROCS=18` at 200 rps, PBS-Go spends 1.5 ms (1 bidder) to 6.6 ms (10 bidders) per auction ([`results/pbs-go-sweep-gomaxprocs18.txt`](pbs-cpu-baseline/results/pbs-go-sweep-gomaxprocs18.txt)). Go's scheduler pays to spin up and park idle threads, and that cost is spread over fewer requests. CPU per auction keeps falling until the box is busy.
- **Java near saturation:** PBS-Java gets ~10 % dearer per auction as it nears saturation.
- **Which numbers to use:** the 1,000 rps rows are the "realistic load" figures. Both Hosts are at ~40–50 % of 4 cores there.

**Per-bidder cost:**
- The 5→10 slope is ~180 µs per bidder for PBS-Go and ~150 µs for PBS-Java.
- The 1→5 slope is lower: ~100 µs and ~70 µs.
- A least-squares fit over the 1/3/5/10-bidder medians gives roughly **Go ≈ 560 µs fixed + 147 µs/bidder** and **Java ≈ 290 µs fixed + 116 µs/bidder**.

### Native Hand-written Adapter cost on the same payload (PBS-Go)

| appnexus | openx | pubmatic | ix | triplelift | sovrn | sharethrough | criteo | medianet | smartadserver |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 29.2 µs | 30.4 | 27.6 | 27.5 | 27.1 | 27.6 | 46.3 (3 HTTP reqs) | 23.0 | 24.2 | 33.0 |

These are µs per `MakeRequests`+`MakeBids` round trip, with 130–520 allocs/op ([`results/pbs-go-adapter-bench.txt`](pbs-cpu-baseline/results/pbs-go-adapter-bench.txt)). The mean is ~30 µs.

- **Share of the auction:** 5 bidders spend ~142 µs in adapters, ~12 % of a 1.17 ms auction. 10 bidders spend ~296 µs, ~14 % of 2.07 ms.
- **Comparison with #3:** #3 measured OpenX at 64–71 µs on a heavier payload: 4 imps including video, and an 11.3 KB response with 4 bids. This payload costs ~0.44× as much. Assuming WASM overhead scales with adapter work, #3's deltas shrink by the same factor, which gives the "scaled" column below.
- **PBS-Java:** no equivalent microbenchmark was run. #3's Jackson port (28.5 µs on the heavier payload) suggests native Java adapters are already cheaper than Go's.

### Where PBS-Go's CPU goes (pprof, treat with suspicion)

`go tool pprof -focus` was run on a 20 s profile at 10 bidders and 1,000 rps ([`results/pbs-go-pprof-focus.txt`](pbs-cpu-baseline/results/pbs-go-pprof-focus.txt)). It attributes:
- **49 %** to `syscall.*` (mostly socket `write`)
- **25 %** to scheduler park/wake (`pthread_cond_*`)
- **17 %** to JSON
- **8 %** to the background GC
- **1.5 %** to `adapters/`

The adapter share contradicts the microbenchmark (~14 %), and the same profile at 200 rps gives `adapters/` 6 %. Go's SIGPROF-based profiler on macOS appears to over-attribute samples to threads sitting in syscalls. So **use the profile only qualitatively**: on macOS a large part of PBS's CPU is kernel and scheduler overhead. On Linux that share should be smaller. If it is, the per-auction denominator shrinks and **the percentages below go up**.

## WASM overhead as a share of per-auction CPU

The baselines are the 1,000 rps medians: Go 1,170 µs (5 bidders) and 2,070 µs (10 bidders); Java 750 µs and 1,510 µs. "Measured" uses #3's per-call deltas as-is. "Scaled" multiplies them by 0.44 for this lighter payload.

| Runtime (per-call delta: measured / scaled) | All 5 bidders Shared | All 10 Shared | 1 of 5 Shared | 1 of 10 Shared |
|---|---:|---:|---:|---:|
| PBS-Go, wazero (+40 / +18 µs) | +17 % / +7.5 % | +19 % / +8.5 % | +3.4 % / +1.5 % | +1.9 % / +0.9 % |
| PBS-Java, Endive (+370 / +163 µs) | +247 % / +109 % | +245 % / +108 % | +49 % / +22 % | +25 % / +11 % |
| PBS-Java, GraalWasm on GraalVM (+93 / +41 µs) | +62 % / +27 % | +62 % / +27 % | +12 % / +5.5 % | +6.2 % / +2.7 % |

How these come about:
- **PBS-Java looks worse than PBS-Go for two reasons.** Its WASM runtimes are slower, and its per-auction baseline is ~35 % lower on this box, so the same delta is a bigger share.
- **Endive's delta also lands on the Vert.x event loop.** At +370 µs × 10 bidders, that's 3.7 ms of event-loop time per auction (see #3).

## Proposed threshold for go criterion (3)

"Within noise" taken literally means ~1–3 %: that's the run-to-run spread at 5–10 bidders here. Nothing passes that at catalogue scale. A defensible, testable version:

1. **Catalogue-scale gate (the real go criterion).** On x86-64 Linux, at PBS-typical concurrency, with 5–10 bidders all running as Shared Adapters, the Host's CPU per auction rises by **≤ 5 %** over the same auction with Hand-written Adapters, and p99 auction latency is unchanged within run-to-run noise.
   - In per-call terms, that is ≲ 0.05 × (per-auction CPU ÷ bidders): about **≤ 10–12 µs on PBS-Go and ≤ ~7.5 µs on PBS-Java**. That's roughly ≤ 0.3–0.4× of a native adapter call.
   - 5 % is about the smallest change a host can attribute in capacity planning. It's also small next to the 2–3× wins hosts are chasing in #3437.
2. **PoC gate (to justify building the Proof of Concept).** With only the Shared OpenX Adapter in a 5–10-bidder auction, the Host's CPU per auction rises by ≤ 5 %. In per-call terms that allows ≲ 60 µs (Go) and ≲ 38 µs (Java).

Status against these gates:

| | PoC gate | Catalogue gate |
|---|---|---|
| PBS-Go / wazero | **pass** (+1–3 %) | **fail** (+8–19 %). Needs a ~2–4× faster guest, e.g. typed structs instead of `serde_json::Value`, or less copying across the boundary |
| PBS-Java / GraalWasm | borderline (+3–12 %) | fail (+27–62 %) |
| PBS-Java / Endive | fail (+11–49 %) | fail (+108–247 %) |

## Caveats

- **Hardware:** this is macOS arm64 (M5 Max), not production x86-64 Linux. Absolute CPU is not portable, and kernel/scheduler overhead is heavier on macOS (see the pprof note). If Linux spends less CPU on syscalls, the denominator shrinks and the overhead percentages grow.
- **The auction is deliberately lean.** There are no stored requests, no Prebid Cache round trip, no analytics adapters, no modules or hooks, no TCF string, no floors and no currency conversion. Each of those adds per-auction CPU and makes the percentages smaller. These two effects pull in opposite directions; only a production-like Linux run settles it.
- **Stub vs real bidders:** the stub answers instantly apart from its 20 ms sleep, with 3 bids per bidder. Real bidders often no-bid (cheaper `MakeBids`) or return video/native (dearer).
- **Adapter mix:** the WASM deltas come from one adapter (OpenX) on #3's payload. Per-adapter cost varies ~2× (21–46 µs natively).

## Sharp questions / fog surfaced

1. **What does the guest cost look like with typed structs?** The catalogue gate needs PBS-Go's per-call WASM overhead at ≤ ~10 µs, against ~18–40 µs today. Is that reachable with typed `serde` structs, borrowed strings, or fewer copies across the boundary? This decides whether form B passes criterion (3) even on PBS-Go.
2. **Run this harness on Linux x86-64**, with a production-like auction: stored request, Prebid Cache, TCF, analytics. That firms up the denominator; the harness is ready to reuse.
3. **Is "≤ 5 % at catalogue scale" acceptable to PBS maintainers?** Or would they accept a per-adapter cost model, where a bidder opts in and the host pays only for Shared Adapters it enables? This could be part of maintainer sounding.
4. **Should PBS-Go's broken auction benchmarks be reported upstream?** Both time the 400 path. A working one would give the project (and this effort) a regression baseline.
5. **PBS-Java needs a native adapter microbenchmark** on the same payload, plus Endive/GraalWasm runs on it, to replace the scaled estimates in this doc.
