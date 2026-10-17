# Can a lean Rust→WASM Adapter fit the Prebid.js size budget?

Research for [#10](https://github.com/JoelPM/prebid-core/issues/10), part of map [#1](https://github.com/JoelPM/prebid-core/issues/1). It builds on [#4](https://github.com/JoelPM/prebid-core/issues/4) (`research/prebidjs-bundle-budget` branch).
Date: 2026-10-16. Toolchain: rustc 1.99.1 `wasm32-unknown-unknown` (`opt-level="z"`, LTO, `codegen-units=1`, `panic="abort"`), binaryen `wasm-opt -Oz` v132. Prebid.js `43a96fbe`. PBS-Go OpenX adapter and fixtures from the local `prebid-server` checkout. All sizes are `gzip -9` unless marked otherwise. Raw numbers are in [`lean-rust-wasm/results.txt`](lean-rust-wasm/results.txt).

## TL;DR: no, Form A is not viable in Prebid.js

- **I built a realistic, lean Rust Adapter, and it is correct.** It is `no_std` with no allocator, no serde, no `core::fmt` and no float parsing. It ports the real OpenX logic: the full PBS-Go `MakeRequests`/`MakeBids`, plus the Prebid.js profile extras. It passes **all 47 checks in PBS-Go's openx `adapterstest` fixtures** in both backends, and 9 more client-profile checks against a plain-JS port.
- **The one-time runtime fits easily.** Measured in context in a real Prebid.js bundle, the runtime plus the field-by-field glue costs **≈ 1.0 KB**, against a ~3 KB budget.
- **The per-Adapter cost does not fit, and the gap is structural.** The best design (field-by-field imports, wasm inlined as base64) costs **3.1 KB in context for OpenX, against 1.18 KB for today's JS OpenX Adapter (2.7×).**
  - The translation logic alone compiles to **1.78 KB of wasm** (2.27 KB once base64-inlined). The *same* logic written as JS minifies to **1.11 KB**.
  - Wasm bytecode for property-poking code is simply less dense than minified JS: each `get` is roughly ptr const + len const + handle + call.
  - With zero glue and no base64 (fetched as raw `.wasm`), it would still be about 2.6 KB in context.
- **miniserde doesn't help.** Its floor is **23.2 KB**, worse than serde_json's 19.5 KB. A hand-written scanner/emitter floor is **0.9 KB**, but that backend's OpenX build is still **5.1 KB** in context.
- **Verdict: Form A (Rust→WASM in Prebid.js) fails go criterion (2).** It also still carries #4's CSP (`'wasm-unsafe-eval'`) and `--ES5` blockers. Prebid.js should run a TypeScript/JS Shared Adapter, so the choice narrows to **B or C**. The lean Rust core *does* work on the servers, but servers gain nothing from leanness, and the authoring cost is high (see §5–6).

## 1. What was built

All the code is under [`lean-rust-wasm/`](lean-rust-wasm/). `build.sh` builds every variant, runs `wasm-opt -Oz`, prints sizes and runs the parity harness.

**Adapter logic, written once:** [`ox-lean/src/openx.rs`](lean-rust-wasm/ox-lean/src/openx.rs). The Adapter is ORTB→ORTB. The Host has already built the generic ORTB (PBS core or Prebid.js's `ortbConverter`) and put each bid's params in `imp.ext.bidder`.

- **`make_requests` (server profile)** mirrors `adapters/openx/openx.go` line by line:
  - skips non-banner/video/native imps, and reports bad `imp.ext.bidder` as an error
  - `tagid` comes from `unit` (number or string)
  - `customFloor` (number or numeric string) applies only when `bidfloor` is not > 0
  - `imp.ext` is copied minus `prebid`/`bidder`, plus `customParams`
  - `video.ext` becomes `{rewarded:1}` when `rwdd==1`, and is dropped otherwise
  - `request.ext = {bc, delDomain, platform}`, where the last imp wins, as in Go
- **Client profile** adds what `modules/openxBidAdapter.js` layers on `ortbConverter`:
  - `bc=hb_pb_ortb_2.0`, `at:1`, `device.dnt:0`
  - `regs.coppa`, `test`, `response_template_name` and `divid`
  - the `params.video` merge
  - first-bid params, and keeps the existing `ext`
- **`make_bids`** mirrors Go's `MakeBids`:
  - currency defaults to USD
  - `fledge_auction_configs` becomes a list of configs
  - bid type comes from `mtype`, falling back to the matching imp (banner wins)
  - `BidVideo` (primary category, duration)
  - `BidMeta` (dsp_id, buyer_id, brand_id given as numbers or numeric strings)
  - HTTP status handling is left to the Host, which is still an open interface question.
- **`is_valid`** is Prebid.js's `isBidRequestValid`.
- Not included: `getUserSyncs`, which map #1 puts out of scope. It stays JS in the Prebid.js module and is counted in the per-Adapter cost, exactly as in today's Adapter.

`openx.rs` is written against a 20-method `Doc` trait (opaque `Copy` handles: get, len, at, set, del, push, clone_obj, truthy, …). Two backends implement it, so the same Adapter source builds either way:

| backend | shape | intended Host |
|---|---|---|
| **`dom`** ([`dom.rs`](lean-rust-wasm/ox-lean/src/dom.rs)) | Bytes in, bytes out. A hand-written JSON scanner builds a node arena that borrows spans of the input, and an emitter writes the result. One bump pointer over linear memory, reset every call. No allocator, no number parsing (numbers and strings stay as raw spans), no UTF-8 validation, no `fmt`. | Server Hosts, which already hold JSON bytes |
| **`imports`** ([`imports.rs`](lean-rust-wasm/ox-lean/src/imports.rs)) | Field by field. JS owns the objects. Wasm calls 20 imported functions (`g`et, `s`et, `a`t, …) on handle indices. Keys are `(ptr,len)` strings in wasm's data segment, which the glue decodes once and caches. No JSON in wasm at all. | Prebid.js |

**Verification:** [`js/parity.mjs`](lean-rust-wasm/js/parity.mjs) runs each build against `prebid-server/adapters/openx/openxtest/{exemplary,supplemental}/*.json`. It compares the outgoing request body, the error count, currency, bids+type and fledge configs. Results: **dom 47/47, imports 47/47.** The client profile has no fixtures, so it is checked differentially against a plain-JS port of the same logic ([`js/openx-logic.js`](lean-rust-wasm/js/openx-logic.js), itself 47/47 on the fixtures) on 9 cases: **9/9 for both backends.**

**Prebid.js integration:** [`pbjs/`](lean-rust-wasm/pbjs/). `install.sh` drops the files into a scratch Prebid.js clone, and `measure.sh` concatenates the built chunks the way `gulp bundle` does.

- `libraries/sharedAdapter/sharedAdapter.js` is the generic Prebid Core runtime. It wraps `ortbConverter` so that:
  - each imp gets `ext.bidder = params` and `ext.prebid.adunitcode`
  - the wasm `makeRequests` runs on the converter's ORTB
  - TypedBids go back through `converter.fromORTB` with `mtype` and `meta` applied
  - the request's object identity is preserved, because `fromORTB` looks up its context by reference
- `libraries/wasmHandles/glue.js` or `libraries/wasmBytes/glue.js` holds the glue for one backend.
- `modules/openxSharedBidAdapter.js` holds the spec, `getUserSyncs` and the base64 wasm, which is compiled synchronously on first use.
- A Form B comparison module, `openxSharedJsBidAdapter.js`, has the same shape with the logic as plain JS.
- Caveat: this builds with `gulp build`, but I did not run it through Prebid.js's unit tests. The wasm cores themselves are what the parity harness verified.

## 2. Sizes

### Wasm artifacts

| artifact | raw | gzip | brotli |
|---|---:|---:|---:|
| serde_json floor (from #4) | 38.9 KB | 19.5 KB | 17.1 KB |
| **miniserde floor**, `json::Value` (0.1.46, std, dlmalloc) | 44.9 KB | **23.2 KB** | 20.4 KB |
| miniserde floor, derived structs | 49.6 KB | 25.1 KB | 22.0 KB |
| **hand-written scanner+emitter floor** (`dom,floor`: parse + re-emit only) | 1.5 KB | **0.90 KB** | 0.84 KB |
| OpenX, `dom` backend, wasm-opt | 6.2 KB | 3.23 KB | 2.88 KB |
| ↳ base64 | 8.2 KB | 4.14 KB | 3.89 KB |
| **OpenX, `imports` backend, wasm-opt** | 3.1 KB | **1.78 KB** | 1.59 KB |
| ↳ base64 | 4.1 KB | **2.27 KB** | 2.12 KB |
| *same logic as plain JS (`openx-logic.js`, esbuild --minify)* | *2.2 KB* | ***1.11 KB*** | *1.00 KB* |

- miniserde loses to serde_json because its floor is dominated by `std`, dlmalloc, `core::fmt` and float parse/print (ryu-style), not by serde's generics.
- Getting under 1 KB took dropping *all* of those: no allocator, numbers kept as raw text, no error strings.
- Base64 inlining adds 27–28% after gzip, consistent with #4's ~30%.
- Packing `ptr|len` into one i32 per import call saved 190 B raw but *added* 3 B gzip, so I dropped it. That variant also broke, because rustc places data above the 1 MiB stack.

### In a real Prebid.js bundle (in-context marginal cost, gzip)

This is a `gulp build --modules=…` build, so its core (61.8 KB) is smaller than #4's full build. Only the deltas matter.

| what is added | Δ gzip | vs budget |
|---|---:|---|
| `ortbConverter` (already paid by OpenX today) | 2,097 B | — |
| **today's OpenX Adapter** | **1,177 B** | the per-Adapter bar |
| Prebid Core runtime (`sharedAdapter`, generic) | 360 B | one-time |
| + `imports` glue (`wasmHandles`) | 615 B | one-time → **975 B total ✓ (≤ ~3 KB)** |
| + **OpenX Shared Adapter, `imports` wasm (base64) + spec + getUserSyncs** | **3,131 B** | **✗ 2.7× the 1,177 B bar** |
| + `dom` glue (`wasmBytes`) instead | 274 B | one-time → 634 B ✓ |
| + OpenX Shared Adapter, `dom` wasm (base64) + spec + getUserSyncs | 5,131 B | ✗ 4.4× |
| *Form B comparison: same logic as plain JS + spec + getUserSyncs* | *1,301 B* | *≈ at par (+10%)* |

The per-Adapter 3.1 KB breaks down roughly as follows:

- about 2.3 KB of base64 wasm
- about 0.7 KB of JS that stays JS anyway (spec, `getUserSyncs`; 683 B standalone)
- a little glue for the call

Even best case, served as raw `.wasm` from the CDN distribution with no base64, it is about **2.6 KB**. That still needs the new async load gate described in #4 §6.

### Why "lean" can't close the gap

The fixed floor is solved. The `imports` design has essentially **no per-Adapter runtime**: no JSON code, no allocator, ~100 B of module overhead. So the per-Adapter number is pure code density. The same OpenX translation is **1.78 KB as wasm against 1.11 KB as minified JS (1.6×), or 2.27 KB once inlined (2.0×).**

Adapter code is almost entirely property reads and writes. In wasm each one is `i32.const ptr; i32.const len; local.get h; call $g` plus result plumbing, and the key bytes still sit in the data segment. Minified JS writes `e.ext.bidder`, and gzip squeezes repeated identifiers far better than it squeezes LEB128 bytecode.

The `dom` backend avoids the call boundary but brings its own ~0.9 KB scanner into *every* Adapter's module. Wasm modules can't share code across Prebid.js's per-module chunks without dynamic linking, and the logic is no smaller.

## 3. Runtime cost (Node 26 / V8, Apple Silicon; PBS-Go `multi-imp` fixture)

| path | compile+instantiate | makeRequests | makeBids |
|---|---:|---:|---:|
| `dom` via browser glue (JSON.stringify → wasm → JSON.parse) | ~170 µs | 9.4 µs | 8.5 µs |
| `imports` (field by field) | ~170 µs | 5.9 µs | 2.5 µs |
| plain JS port | ~5 µs | 1.85 µs | 0.22 µs |
| `dom` core alone, bytes → bytes (1.9 KB in, 1.5 KB out) | — | 4.0 µs | — |

All of these are trivial per auction. Wasm is 3–10× slower than JS in the browser and costs ~0.17 ms to compile on first use. Source: [`js/bench.mjs`](lean-rust-wasm/js/bench.mjs).

## 4. Counting everything for Prebid.js

| | one-time | per Adapter (OpenX) | verdict |
|---|---|---|---|
| Budget (from #4) | ≤ ~3 KB | ≤ 1.18–1.26 KB | |
| Naive serde_json (from #4) | ~19.5 KB | ~10 KB | ✗ ✗ |
| Lean, `dom` backend | 0.6 KB | 5.1 KB | ✓ ✗ |
| **Lean, `imports` backend** | **1.0 KB** | **3.1 KB** (≈2.6 KB unbase64'd) | **✓ ✗** |
| Plain-JS Shared Adapter, same runtime (Form B shape) | 0.36 KB | 1.30 KB | ✓ ≈ |

On top of the bytes, #4's non-size blockers still apply to any wasm in Prebid.js:

- the publisher's CSP needs `'wasm-unsafe-eval'`
- the `--ES5` build cannot load wasm
- Prebid.js gains a Rust toolchain or a prebuilt-blob dependency
- base64 blobs cannot be reviewed in PRs

## 5. Authoring ergonomics of the lean design

The lean core is what makes the floor vanish, and it is also what makes adapters unpleasant to write.

- **No serde, no structs.** Adapters poke untyped handles: `d.get(p, "customFloor")`, `d.pos_num(v)`, `d.set(imp, "bidfloor", n)`. Everything is stringly keyed, and there is no compile-time ORTB schema. That gives up Rust's main selling point for this use.
- **Borrow-checker friction.** A `&mut self` trait means calls can't nest: `d.truthy(d.get(p, "test"))` does not compile, so every intermediate needs a `let`. `openx.rs` is **268 lines** for logic that is **70 lines** of JS (`openx-logic.js`), 211 lines in today's Prebid.js Adapter including user syncs and hooks, and 315 lines in PBS-Go.
  - Here's one fragment, the video rewarded rule. Rust:

    ```rust
    let rwdd = d.get(imp, "rwdd");
    if d.str_eq(rwdd, "1") { let r = d.obj(); let one = d.int(1); d.set(r, "rewarded", one); d.set(v, "ext", r); } else { d.del(v, "ext"); }
    ```

    JS: `if (imp.rwdd == 1) v.ext = { rewarded: 1 }; else delete v.ext;`
- **No `String`/`format!`, no `f64` math, no `Vec`/`HashMap`** without adding back an allocator and `fmt`, which is exactly the floor we removed.
  - Anything numeric has to be a Host import or raw-text tricks: currency conversion, floor arithmetic, `parseInt` semantics.
  - So does building a URL, such as a sync URL or an endpoint with macros.
  - The trait would keep growing Host functions, and each one must be implemented identically in every Host.
- **Semantics live in two places.** "Truthy", "numeric string" and "to string" are re-implemented in the JS glue and in the Rust `dom` backend. Their edge cases (`"0"`, `" 1"`, `1e3`, `-0`) must agree with each other and with Go/Java/JS. I matched them for the fixtures, but this is a parity-bug factory.
- **Toolchain.** Contributors need `cargo`, the wasm target and binaryen, or a CI job that builds and commits blobs. Reviewers can't read a base64 diff, so Prebid.js would need reproducible builds checked in CI.

## 6. Would the same lean core be acceptable on the servers?

- **Functionally, yes.** The `dom` backend is the natural server shape: bytes in, bytes out, one entry per call, nothing to share between calls. It passes every PBS-Go fixture, runs in about 4 µs per `makeRequests` in V8, and has no allocator, threads or WASI, so it fits Trusted Server's single-module constraint.
- **But servers gain nothing from leanness and pay for it:**
  - *Robustness.* The scanner is deliberately lenient. It does no JSON validation, leaves `\u` escapes in keys undecoded, keeps duplicate keys and passes numbers through as raw text (e.g. `0.500000` stays `0.500000`, where Go would re-emit `0.5`). That is semantically equal JSON but not byte-equal. Bidder responses are untrusted input. A server Host would want strict parsing, which costs bytes nobody on a server cares about.
  - *Ergonomics.* Same as §5. Server adapter authors (Go/Java) are used to typed ORTB structs.
  - *The `imports` backend is browser-only in practice.* A server Host would have to expose its object model as ~20 host functions (wazero host funcs over `map[string]any`, or Chicory/wasmtime over Jackson trees) and pay a boundary crossing per property access.
- **What the `Doc` trait shows:** one Adapter source can target different backends. The same `openx.rs` could compile against a serde_json-backed `Doc` for servers (fat, strict, fast to write) and a lean one for browsers. Since the browser side fails the budget anyway, that only matters if Form B's Rust server core wants a thin abstraction layer. For servers on their own, the plain serde/typed-struct approach is the better default.

## Implications for the map

- **Form A is out for Prebid.js.** The one-time runtime can be made tiny (≈1 KB), but per-Adapter wasm is about 2–2.7× today's JS Adapter even with no JSON runtime, no allocator and real OpenX logic, because of wasm's code density against minified JS. No remaining lean trick closes a 2× code-density gap.
- **Prebid.js runs JS/TS Shared Adapters: Form B or Form C.** A plain-JS ORTB→ORTB OpenX on a 360 B generic runtime came in at 1.30 KB, about at par with today's 1.18 KB. The extra ~10% is mostly *server-profile code shipped to the browser* (rewarded video, fledge, BidVideo, meta parsing, type fallback). That is a new design question: see below.
- **Servers:** Rust/WASM (Form B) or JS-in-WASM (Form C) remain open. If Rust, write against typed structs or serde, not the lean core.

## New sharp questions / fog

- **Profile-specific code in a Shared Adapter.** Server-only paths ship dead in the browser bundle, and client-only paths ship dead to servers. Prebid.js would need either a build-time profile flag that it tree-shakes (the existing `FEATURES.*` mechanism?), or separate client/server entry points per Adapter. How much does it cost across the median adapter?
- **Form B Prebid.js integration seam.** This prototype's `ortbConverter` wrapper (params in `imp.ext.bidder`, TypedBids fed back through `fromORTB` with `mtype`/`meta`) worked at 360 B. Is that the shape of the Shared Adapter interface? And who owns `ttl`/`netRevenue`/the native request?
- **TypedBid and error shape** are still open (HTTP status codes, `BidVideo`, `BidMeta` zero-vs-absent, fledge naming). Every Host-side shim depends on them.
- **Forms B and C are now the same thing in Prebid.js** (TS runs natively). The B-vs-C choice is purely a server-side question: Rust/WASM core and a hand-port of each Adapter's logic to Rust (two Implementations) vs a JS engine in wasm running the one TS Adapter. That is criteria (3) and (4) on the servers, not Prebid.js bytes.

## Sources

- `prebid-server/adapters/openx/openx.go`, `openrtb_ext/imp_openx.go`, `adapters/openx/openxtest/**` (local checkout)
- `Prebid.js/modules/openxBidAdapter.js`, `libraries/ortbConverter/converter.ts` (`fromORTB` looks up its context by request object via `REQ_CTX` WeakMap), `webpack.conf.js` (per-`libraries/*` cacheGroups), at `43a96fbe`
- #4 findings: `research/prebidjs-bundle-budget.md` on branch `research/prebidjs-bundle-budget`
- Local measurements in [`lean-rust-wasm/results.txt`](lean-rust-wasm/results.txt). Crates: miniserde 0.1.46. Tools: rustc 1.99.1, binaryen 132, esbuild (Prebid.js devDeps), Node 26.11.1
