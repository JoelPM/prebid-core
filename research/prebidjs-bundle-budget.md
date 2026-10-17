# Prebid.js bundle budget, and how a non-JS Prebid Core would ship

Research for [#4](https://github.com/JoelPM/prebid-core/issues/4), part of map [#1](https://github.com/JoelPM/prebid-core/issues/1).
Date: 2026-10-16. Prebid.js at `43a96fbe` (11.43.0-pre), built locally with `npx gulp build`.

## TL;DR

- **Baseline (gzip -9, in a real concatenated bundle):** Prebid.js core alone is **67.1 KB**. Adding the OpenX Adapter costs **3.6 KB**: 2.2 KB for the shared `ortbConverter` library and **1.26 KB for OpenX itself**. The median Bid Adapter chunk is **1.3 KB**, p90 3.0 KB, max 8.4 KB (IX).
- **Rust→WASM in the browser is far over budget.** A toy OpenX-like Rust Adapter (serde_json, raw C ABI, `opt-level=z`, LTO, `wasm-opt -Oz`) comes to **29.2 KB gz** plus 0.4 KB of JS glue. Of that, about **19.5 KB is a fixed serde_json/alloc floor** and about **10 KB is adapter logic**. That logic alone is ~8× today's JS OpenX Adapter. Form A fails go criterion (2) for Prebid.js unless a much leaner Rust design proves otherwise.
- **QuickJS in the browser makes no sense:** 231 KB gz of wasm plus 14 KB of glue, to run JS inside a JS engine. Forms B and C both run the TypeScript Adapter natively in Prebid.js. QuickJS only matters on the server Hosts.
- **WASM support is not a blocker for the default build.** Every browser in Prebid.js's browserslist supports WASM plus all the post-MVP features recent Rust emits. The real blockers are **CSP** (pages with a CSP need `'wasm-unsafe-eval'`) and the **`--ES5` build**, which targets IE11, Chrome 50 and Safari 10. Those browsers have no WASM.
- **Prebid.js is already well into a TypeScript migration.** TS has been accepted since Prebid 10 (July 2025). Today 75/101 `src/` files and 172/874 module files are `.ts`. Babel `preset-typescript` builds them and `tsc` emits declarations. A TypeScript Prebid Core needs no build-system change at all. A WASM blob needs new plumbing, and that plumbing has gotchas.

## 1. Current sizes (baseline for the bundle-size go criterion)

### Method

`npx gulp build` in a temp clone, so the Prebid.js clone itself was not touched. That emits one webpack chunk per module into `build/dist/`. Library directories become their own shared chunks (`webpack.conf.js` `splitChunks.cacheGroups`: one group per `libraries/*` dir, plus `chunk-core`, `corejs` and `buildOptions`). `gulp bundle --modules=…` concatenates the needed chunks into `prebid.js`. `dependencies.json` lists each module's chunk dependencies. OpenX depends on `['chunk-core.js', 'ortbConverter.js']`.

Sizes are `gzip -9` and `brotli -q 11` with default features (VIDEO, NATIVE etc. on). "In context" means the size difference within one concatenated bundle. That is lower than a chunk compressed alone, because shared vocabulary compresses across files.

### Bundles

| Bundle | raw | gzip | brotli |
|---|---:|---:|---:|
| core only (chunk-core + fpdUtils + buildOptions + viewport + safe/display renderers + prebid-core) | 182.6 KB | **67.1 KB** | 57.9 KB |
| core + ortbConverter | 189.3 KB | 69.3 KB | 59.6 KB |
| core + ortbConverter + OpenX (`gulp bundle --modules=openxBidAdapter`) | 192.9 KB | **70.7 KB** | 60.7 KB |
| core + OpenX, Rubicon, AppNexus, IX, PubMatic | 288.2 KB | 101.2 KB | 86.3 KB |
| above + TCF, tcfControl, priceFloors, currency, userId, sharedId | 345.7 KB | 120.7 KB | 102.2 KB |

Marginal costs in context: **ortbConverter ≈ 2.2 KB gz** (paid once, shared by 156 of 528 Bid Adapters). **OpenX ≈ 1.26 KB gz.** The five popular big adapters average about 6.8 KB gz each in context, because they pull extra libraries (pbsExtensions, appnexusUtils, …).

### Individual chunks, gzipped standalone

| chunk | gzip | brotli |
|---|---:|---:|
| `chunk-core.js` | 60.6 KB | 52.3 KB |
| `prebid-core.js` | 2.6 KB | 2.4 KB |
| `ortbConverter.js` | 2.7 KB | 2.4 KB |
| `openxBidAdapter.js` | **1.55 KB** | 1.37 KB |
| `openxBidAdapter.metadata.js` | 0.39 KB | 0.29 KB |
| rubicon / appnexus / ix / pubmatic | 7.2 / 7.0 / 8.4 / 6.7 KB | |
| criteo / triplelift / sovrn / sharethrough / teads | 3.9 / 3.1 / 2.4 / 2.7 / 2.5 KB | |

All 528 `*BidAdapter.js` chunks (own code only, excluding library chunks), gzip standalone: **min 0.4, p25 0.8, median 1.33, mean 1.6, p75 2.0, p90 3.0, p99 6.4, max 8.4 KB.** OpenX sits at the 58th percentile. The raw list is in [`prebidjs-bundle-budget/adapter-chunk-sizes-gz.txt`](prebidjs-bundle-budget/adapter-chunk-sizes-gz.txt).

### Proposed thresholds for go criterion (2)

Prebid.js core is 67 KB gz, and publishers watch every KB.

- **One-time Prebid Core runtime ≤ ~3 KB gz** in context. That is about the size of `ortbConverter`, ≈4–5% of core. If Prebid Core *is* ortbConverter-shaped TypeScript, it may replace ortbConverter and cost ~0 net.
- **Per-Shared-Adapter cost ≤ the Hand-written Adapter it replaces**, measured in context. For OpenX that is **≤ 1.26 KB gz** (≤ 1.55 KB standalone).

## 2. What a Rust→WASM Adapter costs (Form A in the browser)

Built locally: rustc 1.99.1, `wasm32-unknown-unknown`, `opt-level="z"`, `lto=true`, `codegen-units=1`, `panic="abort"`, `strip=true`, then binaryen `wasm-opt -Oz` (v132). The toy Adapter in [`prebidjs-bundle-budget/toy-rust-adapter`](prebidjs-bundle-budget/toy-rust-adapter) does three things:

- validates `unit`/`delDomain`
- builds an OpenX-style ORTB request (banner/video imps, floor, ext, test flag)
- interprets an ORTB response into Prebid bids

It works on `serde_json::Value`, with JSON strings across a raw `alloc`/`dealloc`/`out_ptr` ABI. It covers less than the real OpenX Adapter and has no ortbConverter equivalent, so these numbers are a **lower bound** for a Value-based design.

| artifact | raw | gzip | brotli |
|---|---:|---:|---:|
| empty Rust cdylib | 55 B | 92 B | 57 B |
| **floor:** serde_json parse + serialize only | 38.9 KB | **19.5 KB** | 17.1 KB |
| **toy OpenX Adapter**, raw ABI | 62.7 KB | **29.2 KB** | 25.6 KB |
| JS glue for the raw ABI (minified) | 0.6 KB | 0.4 KB | 0.3 KB |
| same Adapter via wasm-bindgen 0.2.129: `.wasm` | 64.2 KB | 29.7 KB | 26.2 KB |
| wasm-bindgen `--target web` JS glue (minified) | 3.7 KB | 1.5 KB | 1.3 KB |
| toy Adapter wasm, base64-inlined into JS | 83.7 KB | 38.1 KB | 33.8 KB |

What this means:

- About 19.5 KB gz is a fixed runtime of serde_json, the allocator and core fmt. That is **~29% of Prebid.js core**, against a ~3 KB budget.
- About 10 KB gz is per-adapter logic, roughly **8× the 1.26 KB in-context JS OpenX Adapter**. `json!` and Value manipulation generate a lot of code.
- If every Adapter shipped as its own `.wasm`, each would carry the ~19.5 KB floor again. If all Adapters went into one `.wasm`, publishers would lose today's per-module build selection, or Prebid.js would need a custom per-build Rust compile.
- Inlining the wasm as base64, which is the easiest way to fit Prebid.js's concatenated single-file bundle, adds a further ~30% after gzip.

A leaner design could shrink the floor: `no_std` with a hand-written JSON scanner, `miniserde`, or passing JS objects field by field through imports. That has not been tried here. Closing a ~10 KB per-adapter gap down to ~1.3 KB looks implausible, though: minified JS that leans on the browser's built-in `JSON` and object model is very hard to beat with compiled code.

**Runtime cost (Node 26 / V8 on Apple Silicon, a proxy for desktop Chrome):** compile 0.22 ms and instantiate 0.04 ms for the 63 KB module. The first `buildRequests` takes 0.32 ms, steady state about 6.4 µs per call, against ~0.8 µs for an equivalent native JS function. That is trivial per auction, but it is not free. Source: [`bench.mjs`](prebidjs-bundle-budget/bench.mjs).

## 3. QuickJS-based runtime (Form C) in the browser

Measured from npm `@jitl/quickjs-*` 0.32.0 (quickjs-emscripten):

| artifact | raw | gzip | brotli |
|---|---:|---:|---:|
| QuickJS release-sync `.wasm` | 503 KB | **231.5 KB** | 199.0 KB |
| QuickJS release-asyncify `.wasm` | 1,028 KB | 360.5 KB | 284.5 KB |
| quickjs-emscripten-core + variant glue (esbuild min) | 51.6 KB | 14.3 KB | 12.9 KB |
| single-file browser build (wasm inlined) | 828 KB | 265.3 KB | 221.4 KB |

Runtime: load and instantiate takes 3.4 ms, `newContext` 1.3 ms, and evaluating a small adapter 2.6 ms. That excludes fetching 231 KB. A call costs about 10 µs.

At 3.5× the size of all of Prebid.js core, this is a non-starter in the browser, and it has no purpose there: the page already has a JS engine. **Under Form C, Prebid.js runs the TypeScript Shared Adapter natively, and QuickJS (or Javy etc.) is a server-Host concern only.** For Prebid.js bundle size, Forms B and C are the same thing: a TS Adapter compiled by Prebid.js's existing build.

## 4. WASM browser support

- Prebid.js's browser target is `package.json` `browserslist: ["> 0.25%", "not ios_saf 11", "not dead"]`. The README says: "6.x+ transpiles to target >0.25%; not dead. 11.22+ adds not ios_saf 11". Prebid 10 notes say tests target Chrome 109 minimum ([pb10-notes](https://docs.prebid.org/dev-docs/pb10-notes.html)).
- The resolved list today is: and_chr 154, and_ff 157, **and_uc 15.5**, chrome 109–154, edge 152–154, firefox 121–156, **ios_saf 16.6–27.0**, op_mob 80, opera 135, **safari 18.5–26.6**, samsung 30.
- `browsers.json`, the BrowserStack CI matrix, runs latest Chrome/Edge/Firefox/Safari, plus **Chrome 113 (Windows 10)** and **Safari 15.6 (Monterey)**.
- caniuse-lite, checked against that browserslist with [`wasmsupport.cjs`](prebidjs-bundle-budget/wasmsupport.cjs), reports **no unsupported browser** for any of:
  - `wasm`
  - `wasm-bulk-memory`, `wasm-multi-value`, `wasm-reference-types`
  - `wasm-signext`, `wasm-nontrapping-fptoint`, `wasm-mutable-globals`
  - `wasm-bigint`, `wasm-simd`, `wasm-threads`

  Safari 15.x (the CI floor) supports bulk-memory, reference-types and non-trapping float-to-int.
- **Toolchain gotcha.** Current rustc emits bulk-memory etc. by default for `wasm32-unknown-unknown`. wasm-opt rejected the module until those features were enabled explicitly. If an older browser ever matters, pin `-C target-cpu=mvp` or set explicit `target-feature`s.
- **`--ES5` build is incompatible.** `README.md` ("ES5 Output Support") targets "IE11+, Chrome 50+, Firefox 50+, Safari 10+", and `webpack.common.js` / `browsers-es5.json` test Chrome 50 and Firefox 65. IE11 has no WebAssembly, and neither do Chrome 50–56 or Safari 10. A WASM Prebid Core would need a JS fallback or would have to drop that output mode. A TS Prebid Core is unaffected.

## 5. CSP and `wasm-unsafe-eval`

- MDN, `script-src`: "If a page has a CSP header and `'wasm-unsafe-eval'` isn't specified in the `script-src` directive, WebAssembly is blocked from loading and executing on the page." `'unsafe-eval'` also allows it and overrides `'wasm-unsafe-eval'` ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)).
- `'wasm-unsafe-eval'` support is Chrome 97, Firefox 102 and Safari 16, per [mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) `http/headers/Content-Security-Policy.json`. Browsers older than that need full `'unsafe-eval'` to run wasm under a CSP. The current browserslist is entirely above those versions, but the CI floor Safari 15.6 is below.
- Prebid.js today uses no `eval`/`new Function` and no WebAssembly (grep of `src/`, `libraries/`, `modules/`). **Adopting WASM would add a new CSP requirement:** every publisher with a `script-src` policy would have to add `'wasm-unsafe-eval'` or Prebid Core would fail to load. That is a docs and support burden, and it fails silently for publishers who don't read release notes. A JS/TS Prebid Core adds no CSP requirement.
- The CSP that matters is the **publisher page's**, because Prebid.js runs in the top frame. Prebid.js maintainers cannot fix it on publishers' behalf.

## 6. Async instantiation and auction timing

- Prebid.js Adapter hooks (`isBidRequestValid`, `buildRequests`, `interpretResponse`) are **synchronous** in `bidderFactory`, so a WASM module must be instantiated before the first auction calls into it.
- Options:
  1. **Inline the bytes and compile synchronously** with `new WebAssembly.Module(bytes)` and `new WebAssembly.Instance`. Chromium allows synchronous main-thread compile up to **8 MB**; it was originally 4 KB, and [web.dev's loading guide](https://web.dev/articles/loading-wasm) still says 4 KB. See the [Chromium commit](https://chromium.googlesource.com/chromium/src/+/d1a1a8fdd9b28feaf5d3accc0578092444a1083e) raising the limit. That benchmark compiled 8 MB in under 200 ms on a Pixel 1. A 60 KB module would take ~0.2 ms on desktop and probably ≲2 ms on low-end mobile. This needs no new async seam and fits the concatenated bundle, but pays the ~30% base64 tax.
  2. **Fetch with `instantiateStreaming`** (the CDN distribution could serve `.wasm` next to its chunks). This adds a network round trip and an async gate. Prebid.js would have to defer `processQueue` or `requestBids` until it is ready, otherwise the first auction could miss the Adapter. Today nothing in the module system awaits a module's readiness before auctions.
- Either way, instantiation is small next to auction timeouts (typically 1000–3000 ms). The real costs are the *download* (bytes) and the risk of the async gate.

## 7. How Prebid.js's build would ship it

How the build works today, relevant to both options:

- **Precompile** (`gulp.precompilation.js`): Babel (`babelConfig.js`: `preset-typescript` + `preset-env` + custom plugins `pbjsGlobals`, `callerContext`, `gvlPurposes`, `transform-runtime`) turns `src/`, `modules/` and `libraries/` `.js`/`.ts` into `dist/src`. Declarations come from `tsc` (`tsconfig.json`, `emitDeclarationOnly`), with a per-file disk cache.
- **Webpack** (`webpack.conf.js`): one entry per module with `dependOn: 'prebid-core'`, and `splitChunks` groups per `libraries/*` dir. It throws `Un-precompiled module` for any repo file outside `dist/src`. `node_modules` is allowed and is *not* run through Babel, except in `--ES5` mode.
- **Bundle** (`gulp bundle`): **concatenates JS chunk files**. There is no asset pipeline for non-JS files.
- **New (Oct 2026, [#15329](https://github.com/prebid/Prebid.js/pull/15329)):** a CDN-based, "Cross Origin Storage ready" distribution (`web-bundler/`, `prebid.web.js`, `manifest.json`, checksums) that loads chunks from a CDN.

### TypeScript Prebid Core (Forms B/C)

This works with no build change.

- **In repo.** Put it under `libraries/prebidCore/*.ts`. It automatically becomes its own shared chunk via the per-`libraries/*` cacheGroup, exactly like `ortbConverter`. Shared Adapters are ordinary `modules/xBidAdapter.ts` files that import it.
- **As an npm package** shared with the server Hosts (e.g. `@prebid/core`). It works today, with three caveats:
  1. It is not Babel-processed, so the package must already ship syntax compatible with the browserslist. The custom Babel plugins (`pbjsGlobals` feature flags, `gvlPurposes`) would not apply.
  2. Without a cacheGroup, a package imported by several adapter entries may get **duplicated into each adapter chunk**: `default: false` / `defaultVendors: false`, and only core-js has a node_modules cacheGroup. Adding one cacheGroup fixes that.
  3. Upstream maintainers may resist an external runtime dependency (`c4c72d48e`, "Build system: clean up runtime dependencies", suggests they keep these lean). A thin vendored copy under `libraries/` avoids this.

### WASM Prebid Core (Form A)

This needs new plumbing.

- Rust is not in the Prebid.js toolchain, and making every contributor install `cargo` is a big ask. A **prebuilt npm package** (wasm plus JS glue) or a vendored prebuilt blob is more realistic. Either way, the package has to be wrapped in a `libraries/<name>/` JS shim so it gets its own chunk.
- The concatenated `prebid.js` single-file bundle has no place for a `.wasm` file. Bytes must be **inlined into a JS chunk** (webpack `asset/inline` or a generated `Uint8Array`/base64 module, +~30% gz), or fetched at runtime from a URL the publisher must host or allow-list. Self-hosting publishers, who are most of them, then have to ship two files and keep them in sync.
- Per-module selection, a key Prebid.js property, clashes with Rust compilation units. Either every Adapter is its own `.wasm`, paying the ~19.5 KB floor each, or a single `.wasm` holds a fixed set of Adapters. The latter breaks `--modules=` unless the build compiles Rust per publisher configuration.

## 8. Is Prebid.js moving to TypeScript?

Yes, steadily, and with no end date announced.

- **Prebid 10.0** ([#13253](https://github.com/prebid/Prebid.js/pull/13253), 2025-07-01; [notes](https://docs.prebid.org/dev-docs/pb10-notes.html)): "TypeScript support has landed… TypeScript files are now accepted in the code base." That commit added 43 `.ts` files. Prebid 10 also made NPM consumption Babel-free.
- **Current state** (`git ls-files` at `43a96fbe`):
  - `src/`: 75 `.ts` vs 26 `.js`. Core modules such as `adapterManager`, `auction`, `config`, `targeting`, `prebid` and `ajax` are TS. `adapter.js`, `utils.js` and `adServerManager.js` are still JS.
  - `libraries/`: 36 `.ts` vs 148 `.js`. **`ortbConverter/converter.ts` is TS.**
  - `modules/`: 172 `.ts` vs 702 `.js`. 50 of 526 Bid Adapters are `.ts`.
  - `modules/*.ts` files added: 8 in 2025, 121 so far in 2026.
- **The OpenX Adapter is still JS** (`modules/openxBidAdapter.js`), with a hand-written `openxBidAdapter.d.ts` for params.
- `AGENTS.md`: "Whenever possible, new modules should provide Typescript types for their public interface." Recent PRs include full adapter rewrites into TS (e.g. Goldbach, [#15579](https://github.com/prebid/Prebid.js/pull/15579)) and ongoing work on TS types for NPM consumers (#15395, `gulp ts-strict`).
- No WASM-related issue or PR exists in prebid/Prebid.js (GitHub search for "webassembly OR wasm").

## Implications for the map

- **Form A (Rust→WASM in Prebid.js) fails go criterion (2) as measured:** about 19.5 KB gz fixed and about 10 KB gz per adapter, against budgets of ~3 KB and ~1.3 KB. It also adds a CSP requirement, breaks the `--ES5` output and needs a new asset pipeline. It survives only if a radically leaner Rust/WASM design is shown.
- **TypeScript Shared Adapters for Prebid.js (Forms B and C) pass criterion (2) trivially** if the Adapter is written in ortbConverter style. They cost the same as today's Hand-written Adapter and slot straight into a codebase that is already migrating to TS.

## Sources

- Prebid.js source at `43a96fbe`: `package.json`, `browsers.json`, `browsers-es5.json`, `babelConfig.js`, `webpack.conf.js`, `webpack.common.js`, `gulpfile.js`, `gulp.precompilation.js`, `tsconfig.json`, `AGENTS.md`, `README.md`, `modules/openxBidAdapter.js`, `libraries/ortbConverter/converter.ts`, git history.
- Local measurements: build output of `npx gulp build` / `gulp bundle`. The toy Rust Adapter, scripts and raw data are in [`prebidjs-bundle-budget/`](prebidjs-bundle-budget/). `bench.mjs` expects the scratch layout (`$S/wasm-adapter`, `$S/qjs/node_modules`); adjust the paths to rerun.
- [Prebid 10 release notes](https://docs.prebid.org/dev-docs/pb10-notes.html)
- [MDN CSP `script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src) and mdn/browser-compat-data
- caniuse-lite (via Prebid.js `node_modules`)
- [Chromium: raise sync wasm compile limit](https://chromium.googlesource.com/chromium/src/+/d1a1a8fdd9b28feaf5d3accc0578092444a1083e)
- [web.dev: Loading WebAssembly modules efficiently](https://web.dev/articles/loading-wasm)
- npm `@jitl/quickjs-wasmfile-release-sync@0.32.0`, `quickjs-emscripten-core@0.32.0`, `binaryen@132.0.0`, `wasm-bindgen-cli 0.2.129`
