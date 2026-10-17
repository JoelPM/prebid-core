# How do Adapters actually differ across Hosts?

Research for [#2](https://github.com/JoelPM/prebid-core/issues/2) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). Terms are from [`CONTEXT.md`](../CONTEXT.md).

**Sources.** All primary, read from local clones on 2026-10-16:

| Host | Repo | Commit |
|---|---|---|
| Prebid.js | `prebid/Prebid.js` | `43a96fbee` (2026-10-16) |
| PBS-Go | `prebid/prebid-server` | `a916b19ef` (2026-10-16) |
| PBS-Java | `prebid/prebid-server-java` | `a1f9ddb2f` (2026-10-07) |

Path shorthands used below:

- `PJS/` = `Prebid.js/modules/`
- `GO/` = `prebid-server/adapters/`
- `JAVA/` = `prebid-server-java/src/main/java/org/prebid/server/bidder/`

Line numbers refer to those commits. The catalogue counts come from `ls`/`grep`, so treat them as rough indicators, not audits.

## TL;DR

1. **PBS-Go and PBS-Java Adapters are the same function written twice.**
   - Both take an ORTB 2.6 `BidRequest` with params in `imp.ext.bidder`.
   - Both return HTTP request descriptors, then typed bids.
   - Both use the same endpoint from Host config.
   - In all 9 sampled adapters the logic matches in shape. Every Go/Java difference we found is accidental drift, not a needed Host difference. Examples: missing PAAPI support in Java, version strings that disagree, and outright bugs.
   - On the servers, the Host-specific glue is thin: parsing in the Host's ORTB model, the error types, and a few injected services (currency conversion, PBS version, entry point).
2. **Prebid.js Adapters are a different integration, not just a different Host binding.**
   - In the 9-adapter sample, Prebid.js and the servers share the same wire contract to the bidder only about half the time (4/9).
   - 2 of 9 hit a different ORTB endpoint or profile.
   - 3 of 9 (TripleLift, GumGum, IX) speak a proprietary request or response format client-side.
   - Even when the endpoint matches, the client adapter sends extra client-only fields.
3. **Share of logic.**
   - **Servers:** ~100% of each sampled server Adapter is translation. 3 of 9 have no Host quirks at all and 6 of 9 have minor ones.
   - **Prebid.js:** in the sampled files, translation is roughly 45–70% of the code. The rest is browser glue: user syncs, storage, DOM/window reads, renderers, `onBidWon` feedback loops, and hand-reading consent and `getFloor`.
   - **Prebid.js catalogue-wide:**
     - 63% (331/526) implement `getUserSyncs`
     - 38% (202/526) touch `window`/`document`
     - 32% (166/526) implement `onBidWon`/`onTimeout`
     - 20% (104/526) use storage
     - only 28% (148/526) use `ortbConverter`
4. **Host-supplied context.** On the servers almost everything arrives inside the ORTB request: consent in `regs`/`user`, floors already resolved into `imp.bidfloor`/`bidfloorcur`, and request-level `ext.prebid.*`. Separately, the Adapter needs:
   - the endpoint from Host config (plus macros and extra info)
   - a currency-conversion function: ~13% of server Adapters (Go 36/278, Java 33/263)
   - occasionally the Host name/version and entry point
   - In Prebid.js, `ortbConverter` produces an equivalent ORTB request: consent modules and the floors module write into `ortb2` and `imp`. Hand-built Prebid.js adapters read those values from bespoke objects instead.
5. **Shared artifacts and fixtures.**
   - **Param schemas:** Go and Java each keep their own copy of `static/bidder-params/*.json`. Of 257 bidders in both, 211 copies are identical and 46 have drifted.
   - **Bidder metadata:** Go and Java YAML use different schemas and macro syntax.
   - **Prebid.js:** has no JSON schema, only `isBidRequestValid` and, for 53 adapters, `.d.ts` param types.
   - **Fixtures:** the only reusable, adapter-level, data-driven corpus is PBS-Go's `adapters/*/…test/{exemplary,supplemental}/*.json`: 276 adapters, about 3,578 files. PBS-Java unit tests are code (JUnit builders). Its per-bidder IT JSON runs through the whole auction pipeline. Prebid.js specs are mocha code.

## 1. OpenX in the three Hosts

### 1.1 Interface each Host gives an Adapter

| | Prebid.js | PBS-Go | PBS-Java |
|---|---|---|---|
| Contract | `BidderSpec` (`src/adapters/bidderFactory.ts:130-170`): `isBidRequestValid`, `buildRequests(validBidRequests, bidderRequest)`, `interpretResponse(serverResponse, request)`, plus optional `getUserSyncs`, `onBidWon`, `onTimeout`, … | `adapters.Bidder` (`adapters/bidder.go`): `MakeRequests(*openrtb2.BidRequest, *ExtraRequestInfo) ([]*RequestData, []error)` and `MakeBids(internalReq, externalReq, *ResponseData) (*BidderResponse, []error)` | `Bidder<T>` (`bidder/Bidder.java`): `makeHttpRequests(BidRequest)`, `makeBids(BidderCall, BidRequest)`, plus optional `extractTargeting` and `makeTimeoutNotification` |
| Input | Prebid.js `BidRequest[]` (adUnit-shaped: `params`, `mediaTypes`, `ortb2Imp`, `getFloor()`) and `bidderRequest` (`ortb2`, `gdprConsent`, `refererInfo`, `timeout`). `ortbConverter` turns these into ORTB. | ORTB 2.6 request, already split per bidder, with params in `imp.ext.bidder` and validated against the JSON schema by the Host (`openrtb_ext/bidders.go:852`). `ExtraRequestInfo` carries `CurrencyConversions`, `PbsEntryPoint`, `GlobalPrivacyControlHeader` and `PreferredMediaType`. | Same ORTB request. Services such as `CurrencyConversionService` and `PrebidVersionProvider` are injected through the constructor (Spring `*Configuration`). |
| Output | Request objects `{method,url,data,options}` and Prebid.js bid objects (`cpm`, `currency`, `ttl`, `netRevenue`, `creativeId`, `mediaType`, `meta`, `ad`/`vastXml`…). | `RequestData{Method,Uri,Body,Headers,ImpIDs}`, then `BidderResponse{Currency, Bids[]TypedBid{Bid,BidType,BidVideo,BidMeta,DealPriority,Seat}, FledgeAuctionConfigs}` | `HttpRequest`, then `List<BidderBid{bid,type,bidCurrency,videoInfo,…}>` |
| HTTP status handling | Host (`bidderFactory`/ajax) | **Adapter** (161/278 adapters check 204 themselves; 113 use the `adapters.CheckResponseStatusCodeForErrors` helpers) | Host (`HttpBidderRequester.java:274-310`) |
| Endpoint | Hard-coded in the adapter (OpenX: `REQUEST_URL`, overridable through `config.getConfig('openxOrtbUrl')`) | Host config: `static/bidder-info/openx.yaml` `endpoint`, passed to `Builder` | Host config: `bidder-config/openx.yaml`, passed to the constructor |

### 1.2 OpenX logic, side by side

Files:

- `PJS/openxBidAdapter.js` (211 LOC)
- `GO/openx/openx.go` (315 LOC)
- `JAVA/openx/OpenxBidder.java` (284 LOC)

Rows marked **Common** are the translation logic shared by all three.

| Behaviour | Prebid.js | PBS-Go | PBS-Java |
|---|---|---|---|
| **Common:** `imp.tagid = params.unit` | :44 | :122 | :122 |
| **Common:** `customParams` go to `imp.ext.customParams` | :49-51 | :140-147 | :144-152 |
| **Common:** `customFloor` is used only when there is no `imp.bidfloor` | :52-54 | :123-128 | :138-142 |
| **Common:** `delDomain`/`platform` go to `req.ext`, plus a `bc` config tag | :59-76 (`bc: hb_pb_ortb_2.0`) | :119-120, :17 (`bc: hb_pbs_1.0.0`) | :161-165 (`hb_pbs_1.0.0`) |
| **Common:** bid meta comes from `bid.ext.{dsp_id,buyer_id,brand_id}` | :85-93 | :284-315 | :241-267 (written into `bid.ext.prebid.meta`) |
| **Common:** one request holding all imps | :152-163 | :47-77 | :68-103 |
| Endpoint | `https://rtb.openx.net/openrtbb/prebidjs` (:16) | `http://rtb.openx.net/prebid` (yaml) | same as Go (yaml) |
| Imps that are not banner/video/native | n/a (Prebid.js filters on `supportedMediaTypes`) | silently skipped (:51) | badInput error per imp (:74-77) |
| `delDomain`/`platform` when imps disagree | first bid (:66) | **last** imp wins (loop overwrites, :119) | **first** valid imp (:89-91) |
| Rewarded video | not handled | `video.ext.rewarded=1` when ORTB 2.6 `imp.rwdd==1` (:160-168). Otherwise it **clears** `video.ext` | `video.ext.rewarded=1` when `imp.ext.prebid.is_rewarded_inventory==1` (:126-133). Otherwise it keeps `video.ext` |
| `imp.ext` passthrough | `ext.divid = adUnitCode` (:46). The rest comes from `ortb2Imp` | incoming ext minus `prebid`/`bidder` (:130-158) | same as Go (:144-152) |
| Bid type | `ortbConverter` default (mtype, then the request's mediaType) | mtype, else imp shape, with banner preferred (:241-273) | mtype, else imp shape (:196-233) |
| Video info | via the converter | `BidVideo` always set (:230-239) | only for video bids (:216) |
| PAAPI/fledge | not in the adapter | `resp.ext.fledge_auction_configs` parsed (:202-215) | **not implemented** |
| Response currency | converter (`cur` or the context currency) | `cur`, default USD (:197-200) | `cur`, default USD (:184) |
| Client-only behaviour | `at=1`, `device.dnt=0`, `ext.pv`, the `coppa`/`test`/`response_template_name`/`video` params, USD-only floors through `getFloor` (:107-117), gzip, `getUserSyncs` (:180-211) | none | none |

**OpenX takeaway.**

- The *translation* core is the same in all three: unit to tagid, customParams, customFloor, the delDomain/platform ext, and bid meta.
- Go and Java hit the same endpoint with the same `bc`, but they diverge on four observable edges:
  - which imp's `delDomain` wins
  - where the rewarded signal is read from
  - whether unsupported imps produce an error
  - PAAPI support
- Prebid.js hits a *different* OpenX endpoint and sends extra client-only fields and params. A Shared OpenX Adapter therefore needs at least a client/server mode or profile, not one byte-identical behaviour.

## 2. Sample beyond OpenX

186 bidders exist under the same name in all three Hosts (intersection of `PJS/*BidAdapter.{js,ts}`, `GO/*` and `JAVA/*`). We sampled 8 diverse ones, plus OpenX.

LOC is the main adapter file in each Host, in the order Prebid.js / Go / Java.

| Adapter | LOC (PJS / Go / Java) | Prebid.js build style | Same wire contract client vs server? | Go vs Java drift (examples) | Server-side Host context | Verdict: server | Verdict: Prebid.js |
|---|---|---|---|---|---|---|---|
| openx | 211 / 315 / 284 | ortbConverter | ORTB, **different endpoint** | delDomain first vs last; rewarded source; PAAPI Go-only | none | translation + minor quirks | translation + minor quirks |
| pubmatic | 883 / 719 / 667 | ortbConverter + heavy hooks | same endpoint (`?source=` differs); client sends many extra ext fields | `wrapper.biddercode` Go-only, picked from a random map entry; PAAPI Go-only; Go wipes `publisher.id` to ""; Go can panic on empty `format` | `ext.prebid.bidderparams`, `aliases`, `alternatebiddercodes`, `app.ext.prebid.source` | translation + minor quirks | translation + Host quirks (~⅓ browser glue, `onBidWon` cpm feedback loop) |
| ix | 2028 / 467 / 416 | hand-built | **No**: different endpoint, imp-per-size shape, **price in cents** client-side | Java native-tracker filter bug (swapped enums with OR, `IxBidder.java:406-409`); Go drops unknown `req.ext` keys; PAAPI Go-only | PBS version, `ext.prebid.channel.version` | pure translation | substantially Host-specific (~50%) |
| triplelift | 490 / 224 / 148 | converter for requests, hand-written responses | **No**: `/header/auction` with a proprietary response vs `/s2s/auction` ORTB | Go converts the floor to USD, Java doesn't; Java `break` on null `bid.ext` skips the seat's remaining bids (`TripleliftBidder.java:113-116`) | currency (Go only) | translation + minor quirks | substantially Host-specific (~35% glue, different endpoint) |
| sovrn | 338 / 226 / 213 | hand-built | yes (ORTB, lijit `/rtb/bid`), but the hosts differ | default host `pbs.lijit` vs `ap.lijit`; Java sends an empty-imp request; Java throws uncaught on bad adm encoding | none (`buyeruid` cookie header) | translation + minor quirks | translation + Host quirks (~30%) |
| criteo | 689 / 150 / 99 | ortbConverter + 2.5 downgrade | ORTB, **different endpoint/profile** and response shape | PAAPI Go-only; Java overwrites all of `bid.ext`; the missing-type rule differs | none | pure translation | substantially Host-specific (~55%: syncs, storage, renderer) |
| sharethrough | 390 / 210 / 261 | hand-built (+ Equativ branch) | same host, different `supply_id`; client also has an Equativ backend | Go `bcat`/`badv` leak across per-imp requests (`sharethrough.go:58,84-85`); split order; conversion-failure scope | currency, PBS version | translation + minor quirks | substantially Host-specific |
| gumgum | 851 / 230 / 257 | hand-built | **No**: GET with a proprietary query string vs ORTB POST | tie-break when choosing the largest format; float vs BigInteger IDs; price formatting in adm | none | pure translation | substantially Host-specific (~45–50%) |
| smaato | 392 / 666 / 476 | ortbConverter | yes (same endpoint, same `X-SMT-*` headers) | Go converts floors, Java doesn't; `client` string `prebid_server_1.3` vs `_1.2`; video-pod detection uses entry point vs `ext.prebid.server.endpoint` | currency (Go), entry point | translation + minor quirks | translation + Host quirks (~40%) |

### What the sample says

- **Server tally:** 3 of 9 are pure translation and 6 of 9 are translation plus minor Host quirks. In every case the "quirk" is one of two things:
  - **Injected services:** currency conversion, version string, entry point. These are trivially passable as context.
  - **Accidental drift between two hand-ports of the same logic.** We spot-checked some of these against source:
    - IX tracker filter (`IxBidder.java:406-409`)
    - TripleLift `break` (`TripleliftBidder.java:113-116`)
    - Sharethrough `requestCopy` bcat leak (`sharethrough.go:58,84-85`)
    - Smaato `prebid_server_1.3` vs `1.2` (`smaato.go:21`, `SmaatoBidder.java:68`)
- **No server Adapter needed anything the other server Host could not supply.** PAAPI is the closest case: Java's `BidderBid` model has no fledge configs, so three Java adapters simply omit what Go emits.
- **Prebid.js tally:**
  - 2 of 9 are translation plus minor quirks.
  - 2 of 9 are translation plus moderate quirks.
  - 5 of 9 are substantially Host-specific.
- **Bidders treat client and server as different integrations.** Prebid.js and the servers use the same wire contract in only 4/9 (pubmatic, sovrn, smaato, and sharethrough mostly). The other 5 differ in endpoint, profile, supply ID or format. This is a product choice by the bidder, not something Prebid Core can erase. A Shared Adapter would need per-Host-class (client vs server) branches, or the bidder would have to converge its endpoints.

### Catalogue-wide signals

| Signal | Count |
|---|---|
| Prebid.js adapters (`*BidAdapter.{js,ts}`) | 526 (50 TS) |
| … using `ortbConverter` | 148 (28%) |
| … `getUserSyncs` | 331 (63%) |
| … read `gdprConsent`/`uspConsent`/`gppConsent` by name | 296 (56%) |
| … import shared `libraries/*` | 341 (65%) |
| … `window.`/`document.` | 202 (38%) |
| … `onBidWon`/`onTimeout` | 166 (32%) |
| … `getFloor` | 152 (29%) |
| … `config.getConfig` | 116 (22%) |
| … `getStorageManager` | 104 (20%) |
| PBS-Go adapter packages | 278 (284 dirs). bidder-info has 395 YAML files, 116 of them `aliasOf` |
| … `ConvertCurrency` | 36 (13%) |
| … endpoint templates/macros | ~80 |
| … `PbsEntryPoint` | 7 |
| … `ExtraAdapterInfo` | 11 |
| … `MakeTimeoutNotification` | 1 |
| … `GlobalPrivacyControlHeader` | 0 |
| PBS-Java bidder packages | 263 |
| … `CurrencyConversionService` | 33 (13%) |
| … `PrebidVersionProvider` | 8 |
| … `makeTimeoutNotification` | 3 |
| … `extractTargeting` | 3 |
| … `PriceFloorResolver` | 1 |

**Rough answer to "what share is pure translation?"**

- **Server side:** ≈85–90% of Adapters need no Host context beyond the ORTB request and endpoint config.
  - ~13% need currency conversion.
  - A few percent need version, entry point, timeout notifications or targeting extraction.
  - All of that is translation logic plus injectable context.
- **Prebid.js side:** if we take "uses ortbConverter and has no storage/DOM/event-hook code" as the proxy for close-to-pure translation, the share is probably ~20–30%. This is an estimate from the counts above, not a per-file audit.
  - The large majority carry user syncs, which are out of scope per #1 but live in the same file.
  - A third or more carry DOM, storage or event code.

## 3. Host-supplied context an Adapter needs

The server Hosts already put most context into the request. This is the minimum for a Shared Adapter interface.

**Inside the ORTB request (no extra plumbing on the servers):**

- **Consent:** `regs.gdpr`, `regs.us_privacy`, `regs.gpp`/`gpp_sid`, `regs.coppa`, `user.consent`.
  - Server adapters almost never read these: only ~11 Go and ~9 Java adapters touch `Regs`. The request passes through, already scrubbed by the Host's privacy enforcement.
  - In Prebid.js, the consent modules write the same fields into `ortb2` (`modules/consentManagementTcf.ts:192-194`, `src/fpd/normalize.js:9-13`). An `ortbConverter` adapter gets them for free; 56% of adapters read the legacy objects by name.
- **Floors:** `imp.bidfloor`/`bidfloorcur`, already resolved by the Host floors module.
  - Prebid.js does this through the `priceFloors` ORTB processor (`modules/priceFloors.ts:1086-1097, 1168-1172`).
  - Adapters often add a param-floor fallback (OpenX `customFloor`) and frequently need the floor **in a specific currency**, which leads to the next item.
- **Params:** `imp.ext.bidder`, validated by the Host against the JSON schema on the servers. In Prebid.js that is `bidRequest.params` plus `isBidRequestValid`.
- **Request-level Prebid ext:** `ext.prebid.bidderparams`, `aliases`, `alternatebiddercodes`, `channel.version`, `server.endpoint`, and `imp.ext.prebid.is_rewarded_inventory` (pubmatic, ix, smaato, OpenX-Java).

**Must be passed alongside the request:**

- **Currency conversion function:** `(value, from, to) -> value` (Go `ExtraRequestInfo.ConvertCurrency`, Java `CurrencyConversionService`). ~13% of server Adapters use it, mostly to move floors to USD. Prebid.js reaches the same goal by asking `getFloor({currency:'USD'})`, so the interface could be "floor in currency X" rather than "rates".
- **Adapter config:** endpoint, endpoint macros/templates (~80 Go adapters), `extra_info`, and the compression flag. These live in bidder-info YAML on the servers and are hard-coded or `config`-driven in Prebid.js.
- **Host identity:** Host name/version (`version.Ver`, `PrebidVersionProvider`, `$prebid.version$`) and entry point (video, amp, auction).
- **Errors:** an error taxonomy (BadInput / BadServerResponse / warning) that maps onto each Host's types.
- **Decide whether the Adapter or the Host handles HTTP status codes.** Today Go puts it in the Adapter, while Java and Prebid.js put it in the Host.

**Output a Shared Adapter must be able to express:**

- request list (method, URL, headers, body, impIDs, compression)
- bids with media type, currency, meta, video info (duration, primary category), deal priority, seat
- PAAPI/fledge configs
- for Prebid.js: `ttl`, `netRevenue`, and markup placement (`ad` vs `vastXml`/`vastUrl`/`native`). The servers set these Host-side.

## 4. Existing shared artifacts and fixtures (for the parity harness)

### Bidder param schemas

- `prebid-server/static/bidder-params/*.json` (279) and `prebid-server-java/src/main/resources/static/bidder-params/*.json` (271).
- JSON Schema draft-04, one file per bidder.
- 257 bidders have both copies. **211 are semantically identical** (jq-normalised, `$schema` dropped) and **46 have drifted**. Even OpenX drifted: Go has `"minimum": 0` on `unit` and Java does not.
- Prebid.js has **no** JSON schema. It has `isBidRequestValid` code, plus `.d.ts` param types for 53 adapters (for example `PJS/openxBidAdapter.d.ts`).
- These schemas are the obvious seed for the Shared Adapter's param schema.

### Bidder metadata

- **Go:** `static/bidder-info/<bidder>.yaml`.
  - Fields: `endpoint`, `maintainer`, `gvlVendorID`, `capabilities.{app,site}.mediaTypes`, `userSync` with Go-template macros `{{.GDPR}}`, `openrtb.version`, `endpointCompression`.
  - Aliases are separate files with `aliasOf`.
- **Java:** `src/main/resources/bidder-config/<bidder>.yaml` under `adapters.<bidder>`.
  - Fields: `meta-info.{maintainer-email,app-media-types,site-media-types,vendor-id}`, `usersync` with `{gdpr}`-style macros, `ortb-version`, `endpoint-compression`.
  - Aliases are nested `aliases:` (33 files have them).
- The content is the same in substance but the **schema and macro syntax differ**.
- **Prebid.js** keeps the equivalent inside the spec object (`code`, `gvlid`, `supportedMediaTypes`, `aliases`).

### Test fixtures

**PBS-Go `adapterstest` JSON.** This is the reusable corpus.

- Location: `GO/<bidder>/<bidder>test/{exemplary,supplemental}/*.json`, run by `adapterstest.RunJSONBidderTest`. 276 adapters, ~3,578 files. Schema in `adapters/adapterstest/test_json.go:172-233`:
  - `mockBidRequest`: ORTB request as the Adapter receives it
  - `httpCalls[]`, each with:
    - `expectedRequest{uri, body, headers, impIDs}`
    - `mockResponse{status, body, headers}`
  - `expectedBidResponses[]`, each with `{currency, bids[{bid, type, seat, video}], fledgeauctionconfigs}`
  - `expectedMakeRequestsErrors` and `expectedMakeBidsErrors`, each `[{value, comparison}]`
- Exemplary files must produce no errors; supplemental files cover error paths.
- These are pure Adapter-boundary fixtures that are language-neutral and data-only, which makes them ideal for a parity harness.
- Caveats:
  - Some tests pass Host config into `Builder` (endpoint, `extra_info`, `config.Server`). OpenX passes `config.Adapter{Endpoint:…}` (`openx_test.go:17-19`).
  - Currency tests stub conversions in Go code, not JSON.

**PBS-Java.** Two styles, neither a clean Adapter-boundary data corpus.

- **Unit tests** (`src/test/java/.../bidder/<bidder>/*BidderTest.java`, 270 dirs) are JUnit code with Lombok builders. `OpenxBidderTest.java` is 1,022 lines.
- **Integration tests** (`src/test/java/.../it/<Bidder>Test.java` plus `src/test/resources/org/prebid/server/it/openrtb2/<bidder>/`, 351 dirs, ~1,514 JSON files). Each has four files:
  - `test-auction-<b>-request.json`
  - `test-<b>-bid-request.json`: the outgoing request, matched with WireMock `equalToJson` and json-unit placeholders like `${json-unit.any-string}`
  - `test-<b>-bid-response.json`
  - `test-auction-<b>-response.json`
- The IT files cover the **whole auction pipeline** (Host enrichment, `tmax`, `cur`, `regs`, `source.tid`), so they are not pure Adapter fixtures. The pair (bidder request, bidder response) is reusable as a *loose* parity check.
- There are also Groovy functional tests (`src/test/groovy/.../functional`).

**Prebid.js.** Mocha/chai specs in `test/spec/modules/<name>BidAdapter_spec.js` (521 files; OpenX is 2,135 lines). Inputs and expected outputs are inline JS objects, often asserting on individual fields, so nothing is data-driven or reusable without extraction.

## 5. Implications for the map (not decisions)

- **Go/Java parity is not well-defined today.** Parity criterion (1) in #1 is "match each Host's Hand-written Adapter on its existing fixtures", but the two Hand-written server Adapters disagree with each other. A single Shared Adapter can't match both on every edge. Fixtures mostly don't cover the drifted edges, so it may pass anyway.
- **The real seam is client vs server, not one Host vs another.** A Shared Adapter almost certainly needs a "client profile" and a "server profile", which may hit different endpoints. OpenX itself hits different endpoints with different `bc` values.
- **For Prebid.js, `ortbConverter` already acts as an adapter-to-ORTB façade.** If the Shared Adapter consumes ORTB, Prebid.js can feed it via `ortbConverter.toORTB` and map bids back with `fromORTB`. That covers the 28% already on the converter, and shrinks per-adapter code to the ORTB-to-ORTB translation the servers do.
- **Go's `adapterstest` JSON is the natural parity-harness format.** The harness can run a Shared Adapter on the Go fixtures, and could convert Java IT bidder-request/response pairs into the same format.
