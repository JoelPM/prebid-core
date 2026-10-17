# Prior art for write-once Adapters

Research for [#5](https://github.com/JoelPM/prebid-core/issues/5) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). Vocabulary follows [`CONTEXT.md`](../CONTEXT.md).

Gathered 2026-10-16 from the local clones of Prebid.js, prebid-server (PBS-Go), prebid-server-java (PBS-Java) and trusted-server, from GitHub issues and PRs (`gh`), from prebid.github.io sources, and from first-party docs for the outside projects. Commit hashes refer to those clones.

## TL;DR

1. **Nobody has proposed Shared Adapters for Prebid before.** I searched the `prebid` org's issues, PRs and Discussions for wasm, webassembly, "shared adapter", "single source", "code generation" and "port automatically". Every wasm/webassembly hit was a Dependabot bump. The nearest things are a **policy** that a bidder's client and server Adapters must take the same params, plus three **partial unifications**: param schemas, `ortbConverter`, and an issue bot that files port tickets.
2. **`static/bidder-params` is a server-side validation feature. It was never meant to unify client and server.** It began in PBS-Go in 2017 so the server could validate `imp.ext.<bidder>` and serve schemas over an endpoint. PBS-Java copied the files in 2018. The two copies now drift (47 of the 257 shared files differ, OpenX's among them). Prebid.js doesn't use them at all.
3. **`ortbConverter` unifies ORTB translation inside Prebid.js only.** The 2022 proposal set out to replace the near-duplicate PBJS↔ORTB code in each adapter and in the PBS adapter with "one canonical implementation". It now underpins 148 of 526 Prebid.js bid adapters (~28%) and `prebidServerBidAdapter`. Nothing on the server side uses it.
4. **PBS-Java has never ported Adapters automatically.** Porting is manual and the official guidance is to "treat this task as a re-implementation". The only automation creates issues: since 2023 a PBS-Go workflow opens a "Port PR from PBS-Go: …" issue in PBS-Java for every merged PR. That has produced about 950 issues, and 111 are still open (oldest Nov 2024). Prebid.org's docs promise demand partners a Java port "within a couple of months".
5. **Outside lesson: one artifact running in many hosts works when the host ABI stays small, frozen and versioned, and a shared conformance suite exists. It breaks down when the ABI keeps growing or when there are N independent implementations.** proxy-wasm went four or more years with Envoy's Wasm filter still "experimental", while the spec "is still iterating". Envoy later added native "dynamic modules", partly for zero-copy performance. CEL shares one conformance suite across Go, Java and C++, yet cel-go still keeps a skip list of failing cases. Shopify Functions caps every module (256 kB binary, 11M instructions) and steers heavy logic to Rust over JS.

## 1. Prebid's own history

### 1.1 Policy: client and server Adapters must take the same params

- Prebid's module rules say: *"If a bidder has adapters for both Prebid.js and Prebid Server, all parameters (including biddercodes and aliases) must be consistent between client- and server-side adapters. This allows publishers to utilize the PBJS s2sTesting module."* ([`dev-docs/module-rules.md`](https://github.com/prebid/prebid.github.io/blob/master/dev-docs/module-rules.md), line 93.)
- Enforcement is tracked in [prebid-server#2654](https://github.com/prebid/prebid-server/issues/2654) "Adapter naming and parameter consistency" (bretg, 2023-03-17, **still open**). It lists bidders whose codes or params differ across Prebid.js, PBS-Go and PBS-Java: `freewheel-ssp`/`freewheelssp`, `interactiveOffers`, `lunamedia` vs `lunamediahb` vs `sa_lunamedia` ("very different params and endpoints"), `33across` vs `thirtythreeacross`, `audienceNetwork` vs `facebook`, and others. It is resolved one bidder at a time, by hand.
- Before that rule, the client side handled divergence with `transformBidParams`, a client-side hook that rewrote Prebid.js params into the server's format. [Prebid.js#6361](https://github.com/prebid/Prebid.js/issues/6361) (bretg, 2021) called it the one bidder-specific hook "really compelling" for server-side bidders. No module in today's Prebid.js tree uses it (`grep` finds none), so the consistency rule appears to have replaced it.
- **Takeaway:** Prebid already treats "same params everywhere" as a requirement, but nothing enforces it mechanically. Shared param schemas would turn that rule into a build check.

### 1.2 `static/bidder-params` JSON schemas

- **Origin:** PBS-Go commit `887581922` "Added adapter param schemas & endpoint (#147)" by dbemiller (AppNexus), 2017-10-17. It added schema files for 6 bidders, an endpoint to serve them (`/bidders/params`), and a test "so that they force all adapters to have uploaded a schema". Today PBS-Go loads them through `openrtb_ext.NewBidderParamsValidator("static/bidder-params")` and validates `imp[].ext.prebid.bidder.<bidder>` on every request.
- **PBS-Java:** copied the schemas in commit `17f34ba2d` "Added bidder params schema endpoint" (2018-01-22) into `src/main/resources/static/bidder-params`.
- **They're copies, not a shared source.** I compared the two trees on 2026-10-16:
  - 210 files are semantically identical.
  - **47 differ.**
  - 22 exist only in Go and 14 only in Java.
  - OpenX differs too: Go has `"minimum": 0` on a field Java leaves unconstrained.
- **Bidder metadata** (`static/bidder-info/*.yaml` in Go, added in `945fa1338` "Adapter metadata endpoints (#367)", 2018) is also split. Java keeps its own `bidder-config/*.yaml` in a different format, and the Java porting guide warns "do not copy and paste directly".
- **Prebid.js doesn't consume the schemas.** Each adapter validates params in its own `isBidRequestValid`. Only comments refer to the schema files (e.g. `modules/ezoicBidAdapter.js:19`). Trusted Server accepts PBS-shaped bidder params and forwards them; its only mention of "bidder-params" is a doc comment (`trusted-server-core/src/integrations/prebid.rs:1606`).
- **What they unify:** the *shape* of server-side params across PBS-Go and PBS-Java, approximately. They don't unify the client and server sides, and they don't unify behaviour.

### 1.3 Prebid.js `ortbConverter`

- **Origin:** [Prebid.js#8562](https://github.com/prebid/Prebid.js/issues/8562) "Proposal: pbjs-ortb conversion library" (dgirardi, 2022-06-14): *"There is an increasing number of adapters that interface with ORTB backends. Currently, each needs to replicate logic to convert PBJS bid objects to ORTB and back again; a dialect of that logic is also implemented in the PBS adapter. We should extract that into one canonical implementation."* It also moved FPD enrichment (e.g. `device.ua`) into core.
- **Landed:** [Prebid.js#8738](https://github.com/prebid/Prebid.js/pull/8738), merged 2022-10-21 (commit `21712ca1f`). It first refactored `prebidServerBidAdapter`, `openxOrtb` and `improvedigital` onto the library. Code is in `libraries/ortbConverter/`, with PBS-specific processors in `libraries/pbsExtensions/`.
- **Design worth borrowing:** the proposal anticipated per-adapter customisation:
  - imp-level and bid-level override hooks;
  - per-feature "processors" that an adapter can override;
  - request splitting (the Rubicon case).
  ORTB features belong to the modules that own them: `imp.bidfloor` only appears when `priceFloors` is loaded, `cur` only with `currency` (README "Module-specific conversions"). In effect it is a small declarative-ish pipeline with escape hatches, i.e. the shape of form **D** limited to one Host.
- **Adoption:** 148 of 526 `modules/*BidAdapter.{js,ts}` import it (~28%), four years on. Migrations are still arriving, e.g. [Prebid.js#15740](https://github.com/prebid/Prebid.js/pull/15740) (Oct 2026).
- **What it unifies:** PBJS-object↔ORTB conversion *within Prebid.js*. Because of it, a Prebid.js adapter built on ORTB looks structurally close to a PBS adapter (it receives an ORTB request and adjusts it). That narrows the gap a Shared Adapter has to bridge. PBS-Go and PBS-Java have nothing equivalent.

### 1.4 Go → Java porting

- Prebid.org's docs: *"Prebid Server has two code bases: Go and Java. The original version … was the Go-Lang version. Rubicon Project ported it to Java because they had more engineers who knew Java than Go … For demand partners, we recommend building new bid adapters in Go - the team will port it to Java for you within a couple of months."* ([`prebid-server/versions/pbs-versions-overview.md`](https://github.com/prebid/prebid.github.io/blob/master/prebid-server/versions/pbs-versions-overview.md).)
- **The automation creates issues; it doesn't port code.** `.github/workflows/cross-repo-issue.yml` in PBS-Go (`6ab6ba2c7`, #2548, 2023-01-27) runs on every merged PR without the `do not port` label. It runs `gh issue create --repo prebid/prebid-server-java --title "Port PR from PBS-Go: …" --label auto`. On 2026-10-16 there were **111 open and 840 closed** `auto` issues in PBS-Go's Java counterpart repo; the oldest open one dates from 2024-11-21.
- **Manual re-implementation is the stated policy.** [`docs/developers/bid-adapter-porting-guide.md`](https://github.com/prebid/prebid-server-java/blob/master/docs/developers/bid-adapter-porting-guide.md) (`dcaeee4d9`, #3768, 2025-03) says:
  - *"the best way to think of it is not as straight port. Instead, we recommend treat this task as a re-implementation."*
  - *"the PBS-Go team is more lenient about what they allow in adapters compared to the PBS-Java team."*
  - *"Go adapters deserialize JSON objects in-place, while Java adapters work with pre-deserialized objects. As a result, many errors thrown in the Go version do not apply in Java."*
  - It also bans blocking code, fully dynamic hostnames and stateful adapters.
  
  Ported PRs follow the title patterns "Port X: New Adapter" and "Port X: <update>".
- **No machine porting and no shared fixtures.** I found nothing in git history, issues or docs about transpiling or generating Java from Go. PBS-Go has about **3,540 JSON fixtures** in a host-neutral format (`adapters/<bidder>/<bidder>test/{exemplary,supplemental}/*.json`: mock ORTB request → expected outgoing HTTP calls → mocked responses → expected bids). PBS-Java doesn't use them; it hand-writes JUnit tests plus its own `it/openrtb2/<bidder>` JSON fixtures.
- **Config-only Adapters already exist on the server.** In PBS-Go, 116 of 395 `bidder-info` entries are `aliasOf:` aliases with no code. The Java guide says: *"If an adapter has no special logic, consider using an alias to `Generic` instead."*

### 1.5 Trusted Server

- No Adapters yet. Commit `dbc10126c` "Add configuration-driven OpenRTB auction providers (#1016)" (2026-09-08) adds a `GenericOpenRtbProvider` with typed **profiles** (`standard`, `prebid-server`, `aps`) compiled from operator config into an `AuctionPlan` (`crates/trusted-server-core/src/auction/README.md`). This is a second Prebid codebase reaching for "generic ORTB + small per-partner config", the same direction as form **D**.
- **Vocabulary clash:** in Trusted Server, "adapter" means a *platform* crate (`trusted-server-adapter-fastly`, `-cloudflare`, `-spin`, `-axum`), not a bidder Adapter.

## 2. External precedents

| Precedent | Model | What it shows |
|---|---|---|
| **proxy-wasm** ([spec](https://github.com/proxy-wasm/spec)) | One Wasm ABI; hosts are Envoy, ATS, NGINX (Kong), MOSN, OpenResty, plus C++/Go/Java host libraries | Cross-host portability is real: the spec calls the APIs proxy-agnostic, and v0.2.1 is "the latest and widely implemented version". The cost is shown by Envoy issue [#36996](https://github.com/envoyproxy/envoy/issues/36996) (Nov 2024). Its Wasm filter, in production with Istio and Higress for about 4 years, is still not stable. The issue notes that "the status of the extension reflects the implementation status not the ABI" because the proxy-wasm spec "is still iterating". It also lists crash bugs, dependency governance and "a difficult ramp-up both for the developers and the operators". Envoy's docs still call the filter "experimental … the configuration structures are likely to change" ([docs](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/wasm_filter)). |
| **Envoy dynamic modules** ([docs](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/advanced/dynamic_modules)) | Native shared libraries behind a pure C ABI; SDKs in C++, Go, Rust | Envoy added a non-Wasm path aiming at "minimal overhead compared to the built-in C++ extensions" and zero-copy body access, "unlike any other extension mechanisms". Its ABI policy is the lesson: "Released ABI is frozen", "grows by addition, not by mutation", `_v2` suffixes, deprecation for ≥4 releases. The price is "stricter compatibility requirements" than Wasm and fully trusted in-process code. |
| **Istio WasmPlugin** ([docs](https://istio.io/latest/docs/ambient/usage/extend-waypoint-wasm/)) | proxy-wasm modules distributed from OCI registries | Istio has already changed its Wasm API once: ambient waypoints moved from `WasmPlugin` (1.22–1.24 docs) to `TrafficExtension`. Distribution (OCI images, fetched by an agent) is a design problem of its own. |
| **Extism** ([repo](https://github.com/extism/extism)) | One plugin ABI, host SDKs in ~16 languages (incl. Go, Java, JS/browser, Rust), PDKs in ~10 | Has the host matrix Prebid would need (Go, Java, browser JS, Rust). It is maintained by one company (Dylibso) and its README positions it as a plug-in framework, not a standard. A Prebid ABI on top of it would add a third-party dependency to every Host. |
| **Shopify Functions** ([limits](https://shopify.dev/docs/api/functions/latest), [languages](https://shopify.dev/docs/apps/build/functions/programming-languages)) | Third-party Wasm run on Shopify's hot checkout path | Closest operational analogue: untrusted partner code, latency-critical, per-call execution. Hard limits: **256 kB binary, 11M instructions** (scaled for >200 lines), 10 MB memory, 128 kB input / 20 kB output. *"Languages that compile directly to WebAssembly, such as Rust, perform better than dynamic languages, such as JavaScript"*; JS hits instruction limits sooner, and Rust is advised for heavy or public apps. Relevant to form **C**. |
| **Javy** ([repo](https://github.com/bytecodealliance/javy)) | JS → Wasm by embedding a JS engine (Bytecode Alliance; the JS toolchain behind Shopify Functions) | Statically linked modules are "at least 869 KB". Dynamic linking gets them down to 1–16 KB, but only if the host supplies the shared engine module. Form **C**'s size and cold-start costs depend on that choice. |
| **StarlingMonkey / Fastly Compute JS** ([repo](https://github.com/bytecodealliance/StarlingMonkey), [Fastly](https://www.fastly.com/documentation/guides/compute/javascript/)) | SpiderMonkey compiled to Wasm (WASI 0.2 components) | JS-in-Wasm runs in production at Fastly and in Fermyon Spin, so form **C** is feasible on a Trusted Server-class host. Fastly reports "~3x faster" JS with `--enable-aot`, which means a plain interpreter in Wasm has a large performance gap. StarlingMonkey also notes that per-app specialised builds start "much faster". |
| **OPA Rego → Wasm** ([docs](https://www.openpolicyagent.org/docs/wasm)) | Policy compiled to Wasm, evaluated by host SDKs | A domain DSL compiled once and run in many hosts. Lessons: (a) builtins that need I/O, e.g. `http.send`, "probably won't be natively supported in Wasm" and must be provided by the host, so Adapters that need I/O would need host imports; (b) the ABI is versioned inside the module (`opa_wasm_abi_version` 1.0→1.3, minor = backwards-compatible); (c) only the JS SDK is first-party, and other hosts rely on "various community SDKs". |
| **CEL** ([cel-spec](https://github.com/google/cel-spec), [cel-go conformance](https://github.com/google/cel-go/tree/master/conformance)) | One spec, separate Implementations (Go, Java, C++) | Shows the cost of N Implementations, the option the map rules out. A shared conformance corpus (`cel_spec//tests/simple:testdata/*.textproto`) runs in every Implementation, yet even Google's cel-go keeps a `_TESTS_TO_SKIP` list of "Failing conformance tests". A Prebid interpreter per Host (form **D**) should expect the same drift and needs a fixture corpus from day one. |
| **OpenTelemetry semconv codegen** ([guide](https://opentelemetry.io/docs/specs/semconv/non-normative/code-generation/)) | One YAML registry; per-language **constants** generated by Weaver with Jinja templates | Generate data, not behaviour: OTel generates attribute and metric names and keeps logic per language. Stability is built in: stable vs preview artifacts, no removal of stable deprecated entries without a major version, and a warning about diamond dependencies. This is the natural model for sharing `bidder-params` and `bidder-info` regardless of which form wins, and the cheap first step for form **E**. |

## 3. Implications for the map

- **Already-shared assets to build on:**
  - PBS-Go's `bidder-params` schemas and `bidder-info` YAML: the likely seed for Shared Adapter metadata, if made the single source and generated into Java (an OTel-style registry).
  - PBS-Go's ~3,540 JSON adapter fixtures: the likely parity-harness corpus, since they are already host-neutral ORTB-in / HTTP-out / bids-out.
  - `ortbConverter`: makes Prebid.js adapters ORTB-shaped, so the Prebid.js-side shim of a Shared Adapter can reuse it rather than re-implement PBJS↔ORTB.
- **Organisational evidence for the case:** about 950 auto-filed port issues, a months-long port lag, a 3-year-old open consistency issue, and 47 drifted schema files. Each one is a cost that Shared Adapters remove.
- **ABI discipline is what decides success elsewhere.** Whatever form wins should specify a small, frozen, additive-only host interface from the start. proxy-wasm's iterating ABI kept Envoy's filter "experimental" for years.
- **Hot-path limits matter.** Shopify's limits and Fastly's AOT numbers suggest form **C** (JS in an embedded engine) carries real CPU and size costs on servers. Go criterion (3) "within noise" may be hard for C but realistic for A/B.
- **Avoid N Implementations even with a conformance suite.** CEL shows drift persists despite one.

## Open questions surfaced

- Should the PBS-Go `bidder-params` + `bidder-info` become the canonical source for Shared Adapter metadata? If so, who resolves the 47 Go/Java schema diffs and the 36 one-sided files?
- Can PBS-Go's exemplary/supplemental JSON fixtures drive Prebid.js and Trusted Server parity tests? That would mean mapping PBJS bid requests ↔ the ORTB `mockBidRequest`.
- How do Shared Adapters relate to PBS's config-only aliases (`aliasOf`, Java `Generic`) and Trusted Server's `GenericOpenRtbProvider` profiles? Could form D start as "generic ORTB + profile", with code only where needed?
- If the core is Wasm, what host imports does an Adapter need? Pure translation suggests none (no I/O), unlike OPA's `http.send`. Confirm against OpenX's Adapter in each Host.
- What is Prebid Core's ABI-versioning and deprecation policy, modelled on Envoy dynamic modules or OPA?
- Terminology: Trusted Server uses "adapter" for platform crates. Add it to CONTEXT.md's flagged ambiguities.

## Search log (negative results)

GitHub issue/PR search across `org:prebid` and the four named repos, plus GraphQL Discussion search, for: `wasm`, `webassembly`, `shared adapter`, `single source`, `write once`, `code generation`, `transpile`, `port adapter automatically`, `goja/graalvm/v8/rhino`, `declarative adapter`. Every wasm/webassembly hit was a Dependabot bump. There were no proposals for running one Adapter in several Hosts.
