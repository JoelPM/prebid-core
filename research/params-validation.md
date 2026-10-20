# Does every Host validate bidder params against the schema before an Adapter runs?

Research for [#19](https://github.com/JoelPM/prebid-core/issues/19) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). Vocabulary is from [`CONTEXT.md`](../CONTEXT.md).

## Answer

**No.** Only the two PBS Hosts validate params against a JSON schema. They don't use the same validator, schema copies or failure behavior, and in both of them some params reach the Adapter unvalidated.

| Host | Schema check? | Validator / draft | When | Invalid params → | Params that reach the Adapter unvalidated |
|---|---|---|---|---|---|
| **PBS-Go** | yes | `xeipuuv/gojsonschema` v1.2.0, draft-04 (one file is 2020-12 and runs in hybrid mode); formats **enforced** | once per imp at request validation, after stored-request merge, legacy `imp.ext.<b>` promotion and `bidderparams` merge, before hooks and `MakeRequests` | **whole request rejected, HTTP 400**: `Invalid request: request.imp[N].ext.prebid.bidder.<b> failed validation.\n<details>` | the raw `ext.prebid.bidderparams.<b>` copy in `request.ext` (PubMatic reads it, and it takes precedence over the imp's values); AMP never merges `bidderparams` into imps; hooks after validation can rewrite anything |
| **PBS-Java** | yes | `networknt/json-schema-validator` 1.5.6, forced to V4; formats **enforced** (with different rules from Go's) | once per imp at request validation, after stored request, profiles, legacy promotion and `bidderparams` merge | **that bidder dropped from that imp**, with a warning: `WARNING: request.imp[N].ext.prebid.bidder.<b> was dropped with a reason: request.imp[N].ext.prebid.bidder.<b> failed validation.\n<details>`; the auction continues | the raw `ext.prebid.bidderparams.<b>` copy (PubMatic reads it, and Jackson coerces it); hooks after validation; deprecated bidder names skip validation |
| **Prebid.js** | **no schema** | per-Adapter `isBidRequestValid` (hand-written truthiness and `isStr` checks) plus compile-time-only `.d.ts` param types | per bid, before `buildRequests` | bid dropped, `logWarn("Invalid bid sent to bidder …")` | everything the Adapter doesn't check: types are never checked at runtime; s2s bidders skip `isBidRequestValid` and send params verbatim to PBS |
| **Trusted Server** | **no** | none; params are `serde_json::Value` | n/a; it forwards to a remote PBS, which validates | the remote PBS's behavior (400 on Go, drop on Java) | all of them, if it ran Shared Adapters locally |

What this means for Restricted TypeScript and the typed back end ([#17](https://github.com/JoelPM/prebid-core/issues/17)):

- **Prebid Core must validate params itself**, against the Shared Adapter's own schema, before the imp Phase, the same way in every Host (see [Implications](#implications)).
- **A type plus `required`/`anyOf` is not enough.** One schema can generate the type, but it must also generate a validator. 135 of PBS-Go's 279 schemas use `minLength`, 39 use `oneOf`, 25 `pattern`, 24 `minimum`, 22 type unions and 5 `format`. None of these fit in a TS type. The prototype's `isValid` only checks `!= null`, so it accepts `unit: "abc"` and `unit: true`.

## 1. PBS-Go

Source: `prebid/prebid-server` at `a916b19ef` (2026-10-16). Paths are relative to the repo root.

### Validator

- `openrtb_ext/bidders.go:797-850` `NewBidderParamsValidator` loads every `static/bidder-params/*.json` with `gojsonschema.NewReferenceLoader` (`:782`). An alias gets its parent's schema (`:832-838`).
- `Validate` (`:852-866`) runs `gojsonschema` and joins every `result.Errors()` into one error string.
- The library is `github.com/xeipuuv/gojsonschema v1.2.0` (`go.mod:41`). It picks the draft from `$schema`: 278 files declare draft-04. `ogury.json` declares 2020-12, which gojsonschema doesn't know, so it falls back to its hybrid mode (`gojsonschema@v1.2.0/draft.go:90-122`).
- **Formats are enforced.** gojsonschema's default `FormatCheckers` include `uuid`, `hostname`, `uri`, `email`, `date-time` and others (`format_checkers.go`), and `validation.go:751` applies them to every string. Its `uuid` regex accepts only lower case: `^[a-f0-9]{8}-…$`.
- `additionalProperties` defaults to open. Only 4 Go schemas set it to `false`, so unknown keys normally pass.

### When validation runs

`/openrtb2/auction`, in `endpoints/openrtb2/auction.go` `parseRequest`:

1. Entrypoint and raw-auction hooks run (`:465`, `:513`).
2. `processStoredRequests` merges the stored request and stored imps into the HTTP JSON (`:535`).
3. Unmarshal, then `ConvertUpTo26` (`:545`).
4. `mergeBidderParams(req)` (`:550`) copies `ext.prebid.bidderparams.<b>` into `imp.ext.<b>` and `imp.ext.prebid.bidder.<b>`. It does this only for imps that already list bidder `<b>`, only for top-level keys the imp lacks (`:680-772`), and "no validation of bidder parameters … is performed" (`:632-635`).
5. `validateRequest` (`:580`) calls `ValidateImp` for every imp (`:931`).
6. `ortb/request_validator.go` `validateImpExt`:
   - It promotes legacy `imp.ext.<bidder>` to `imp.ext.prebid.bidder.<bidder>` when `prebid.bidder` is absent (`:101-113`).
   - It resolves request aliases to their core bidder (`:126-129`).
   - It validates every bidder's params (`:131-136`).

So the stored request, stored imps, legacy `imp.ext.<b>`, aliases and the merged `bidderparams` are all validated on this endpoint. **AMP** (`amp_auction.go:237`) and **video** (`video_auction.go:321`) call the same `validateRequest`. AMP never calls `mergeBidderParams`; the only call site is `auction.go:550`.

After validation:

- **Processed-auction hooks** (`exchange/exchange.go:240`) and **bidder-request hooks** (`exchange/bidder.go:181`) get a mutable `RequestWrapper`. No bundled module rewrites params; the rules engine only removes bidders (`modules/prebid/rulesengine/result_functions.go:98-119`). But the hook contract allows it.
- `splitImps` (`exchange/utils.go:654-712`) copies the validated `prebid.bidder.<b>` into the per-bidder `imp.ext.bidder` (`:704`). Bidder-specific imp first-party data (`imp.ext.prebid.imp.<b>`) is merged into the imp and re-validated with `SkipBidderParams: true` (`:694`). It can't change params, because `ext` is rebuilt from the original afterwards.
- `buildRequestExtForBidder` (`exchange/utils.go:175`, `:510`) gives each Adapter the **raw, never-validated** `ext.prebid.bidderparams.<b>` as `request.ext.prebid.bidderparams`.

### Failure

`validateImpExt` returns a fatal error on the first failing bidder (`request_validator.go:134`). `Auction` then calls `writeError` (`auction.go:194`, `:1917-1940`), which answers **HTTP 400** with one line per error: `Invalid request: request.imp[0].ext.prebid.bidder.pubmatic failed validation.\nwrapper.profile: Invalid type. Expected: integer, given: string`. One bad param for one bidder fails the whole auction, for every bidder.

### Unvalidated path, confirmed empirically

PubMatic's Hand-written Adapter reads `request.ext.prebid.bidderparams.wrapper` and `.acat` (`adapters/pubmatic/pubmatic.go:360-415`). A request-level wrapper with both `profile` and `version` overrides the imp's (`:102-109`).

In `TestZZResearchBidderParams` (a throwaway test in `endpoints/openrtb2`, not committed upstream), the request carries `ext.prebid.bidderparams.pubmatic.wrapper = {"profile":"5"}`:

| imp params | after merge | validation | Adapter |
|---|---|---|---|
| `{"publisherId":"156209"}` | `wrapper:{"profile":"5"}` merged in | ❌ `wrapper.profile: Invalid type. Expected: integer, given: string` → 400 | not reached |
| `{"publisherId":"156209","wrapper":{"profile":1}}` | unchanged (the imp wins) | ✅ passes | `MakeRequests` reads the raw `{"profile":"5"}` → 0 requests, error `cannot unmarshal pubmatic.pubmaticWrapperExt.ProfileID` |

## 2. PBS-Java

Source: `prebid/prebid-server-java` at `a1f9ddb2f` (2026-10-07). Paths are relative to `src/main/java/org/prebid/server/`.

### Validator

- `validation/BidderParamValidator.java` uses `JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V4)` (`:29`) from `com.networknt:json-schema-validator` 1.5.6 (`extra/pom.xml:45`).
- It loads `static/bidder-params/<bidder>.json` from the classpath (`spring/config/ServiceConfiguration.java:1170`). An alias with no file of its own falls back to `aliasOf` (`:122-136`).
- The schemas are Java's own copies under `src/main/resources/static/bidder-params/`, not PBS-Go's files. See [§5](#5-schema-features-and-drift) for the drift.

### When validation runs

`auction/requestfactory/AuctionRequestFactory.java:235-245` runs, in order:

1. `storedRequestProcessor.processAuctionRequest`
2. `updateBidRequest`: profiles, ORTB up-conversion, then `paramsResolver.resolve`
3. `limitImpressions`
4. `validateRequest`

All of this comes after the raw-auction hooks (`:139`) and before the processed-auction hooks (`:153`). AMP (`AmpRequestFactory.java:418-431`) and video (`VideoRequestFactory.java:126`, `:316`) follow the same order.

`Ortb2ImplicitParametersResolver` prepares the imp ext:

- `moveBidderParamsToPrebid` (`:1098-1126`) promotes legacy `imp.ext.<b>` when `prebid.bidder` is empty.
- `mergeGlobalBidderParamsToImpExt` (`:1071`, `:1134-1161`) merges `ext.prebid.bidderparams` into **every** imp. It uses an RFC 7386 merge patch (`jsonMerger.merge(impParams, requestParams)`, `:1159`), so the imp wins and nested objects merge deeply. When an imp lacks the bidder, it **adds the bidder to that imp** (`:1157-1161`). PBS-Go only merges into imps that already list the bidder.

`validation/ImpValidator.java` then:

- validates each `imp.ext.prebid.bidder.<b>` (`:76`, `:429-458`), resolving aliases (`:447`);
- calls `bidderParamValidator.validate` (`:540`).

Deprecated bidder names skip validation (`:545`).

After validation:

- Processed-auction hooks and bidder-request hooks (`auction/ExchangeService.java:1184`) can mutate the request.
- `ImpAdjuster` merges `imp.ext.prebid.imp.<b>`. It first strips `ext.prebid.bidder` from the patch (`auction/ImpAdjuster.java:49`), so first-party data can't rewrite params.
- `prepareImpExt` copies the validated `prebid.bidder.<b>` to `imp.ext.bidder` (`ExchangeService.java:923`).
- `prepareBidderParameters` gives the Adapter the raw `bidderparams.<b>` (`ExchangeService.java:1075`, `:1091-1095`).

### Failure

Failure is **per bidder, per imp, and not fatal**. `validateImpExtPrebidBidder` catches the `ValidationException`, removes that bidder from that imp's `prebid.bidder`, and adds a warning (`ImpValidator.java:445-452`). If no bidder is left on the imp, it only adds another warning (`:455-457`). The request is never rejected for bad params.

### Coercion on the unvalidated path

PBS-Java's `ObjectMapper` keeps Jackson's default scalar coercion and turns on `ACCEPT_SINGLE_VALUE_AS_ARRAY` (`json/ObjectMapperProvider.java:20-21`). `PubmaticBidder.extractWrapper` reads the raw request-level wrapper with `convertValue` (`bidder/pubmatic/PubmaticBidder.java:185-191`). Run empirically with the same libraries:

| raw `bidderparams.pubmatic.wrapper` | PBS-Go Adapter | PBS-Java Adapter |
|---|---|---|
| `{"profile":"5"}` | error, no request | **coerced to `5`** |
| `{"profile":5.5}` | error | **truncated to `5`** |
| `{"profile":"x"}` | error | error (`IllegalArgumentException` → bad input) |

The Hand-written Adapters' own decoders also differ: Go's OpenX struct has `Unit json.Number` (`openrtb_ext/imp_openx.go`), Java's has `String unit` and `BigDecimal customFloor` (`proto/openrtb/ext/request/openx/ExtImpOpenx.java:19,28`).

## 3. The two validators disagree, on the same params

These were run through each Host's real validator, configured as that Host configures it, against each Host's own schema file. Test sources: `zz_research_params_test.go` (`openrtb_ext`, PBS-Go) and `T.java` (networknt 1.5.6, Jackson 2.18.6, PBS-Java).

| params | PBS-Go | PBS-Java | why |
|---|---|---|---|
| openx `{"unit":-1,…}` | ❌ `Must be greater than or equal to 0` | ✅ | Java's `openx.json` has no `minimum` on `unit` (drift) |
| openx `{"unit":1.5,…}` | ✅ | ✅ | `pattern` applies only to strings, `minimum` only to numbers; nothing says integer |
| openx `{"unit":"abc",…}` | ❌ pattern | ❌ pattern | |
| openx `{"unit":true,…}` | ❌ type | ❌ type | |
| openx `{"unit":"1","delDomain":"openx"}` | ❌ pattern `\.[a-zA-Z]{2,3}$` | ❌ | |
| openx `platform: "not-a-uuid"` | ❌ format uuid | ❌ format uuid | |
| openx `platform: "8DB4A3B2-3D24-4F71-9C34-6A5B6C3D2E10"` (upper-case UUID) | ❌ format uuid | ✅ | gojsonschema's UUID regex is lower-case only |
| openx `{"unit":"1"}` | ❌ anyOf | ❌ required delDomain / platform | |
| openx unknown key `extra` | ✅ | ✅ | open `additionalProperties` |
| pubmatic `wrapper.profile: 5.0` | ✅ then the Go Adapter fails: `can not decode float as int` | ❌ `number found, integer expected` | draft-04 "integer" read two ways |
| pubmatic `wrapper.profile: "5"` | ❌ | ❌ | |
| pubmatic `publisherId: 156209` | ❌ | ❌ | |

## 4. Prebid.js and Trusted Server

### Prebid.js

Source: `prebid/Prebid.js` at `43a96fbee` (2026-10-16).

- **There is no JSON schema.** No `ajv`, `jsonschema` or schema file exists in `src/`, `libraries/` or `package.json`.
- `src/adapters/bidderFactory.ts:330-331` filters each bidder's bids through `filterAndWarn`, which calls `spec.isBidRequestValid(bid)` and drops failures with `logWarn("Invalid bid sent to bidder <code>: <bid JSON>")` (`:405-411`).
- **OpenX** `isBidRequestValid` (`modules/openxBidAdapter.js:139-150`) checks truthiness only: `delDomain || platform`, plus `unit` or banner sizes. It doesn't check types, so `unit: true` passes. For banner, `unit` isn't required at all, unlike the PBS schema, where `required: ["unit"]`. `customFloor` is copied to `imp.bidfloor` as is (`:52-53`).
- **PubMatic** checks `isStr(publisherId)` and some video rules (`modules/pubmaticBidAdapter.js:752-785`). Other params are type-checked lazily: `_parseSlotParam` ignores a non-string `kadfloor`/`pmzoneid` with a warning, then `parseFloat`s it (`:636-650`). The wrapper profile is `parseInt(profId)` (`:523`).
- **The types exist only at compile time.** `src/adUnits.ts:39,73` types `params` through the `BidderParams` interface. `modules/openxBidAdapter.d.ts` and `modules/pubmaticBidAdapter.d.ts` (bot-written) declare the param types, and they drift from the PBS schemas: OpenX `unit?: string` and `customFloor?: number`, where the schema says `number|string` for both. Publishers configure in plain JS, so nothing is enforced at runtime.
- **s2s bidders** never meet `isBidRequestValid`. The PBS adapter (`modules/prebidServerBidAdapter/ortbConverter.js:131-136`) calls `setImpBidParams` (`libraries/pbsExtensions/processors/params.js`), which copies `bidRequest.params` verbatim into `imp.ext.prebid.bidder.<bidder>`. PBS validates them there. `transformBidParams` was removed in Prebid 10 (`ee60c1955`, `c4c923e87`).
- **So a Shared Adapter in Prebid.js receives whatever the publisher wrote**: numbers where strings are expected, `true`, arrays, `null`. Only Prebid Core can stop that.

### Trusted Server

Source: `IABTechLab/trusted-server` at `5bc388625` (2026-10-16).

- Params come from two places, both opaque `serde_json::Value`:
  - the browser's tsjs ad units (`crates/trusted-server-core/src/auction/formats.rs:68-79`, collected at `:200-205`, documented "passed verbatim to the corresponding PBS bidder adapter");
  - publisher config (`creative_opportunities.rs:1051-1061`, `PrebidSlotParams.bidders`, "forwarded verbatim").
- Config override rules shallow-merge into them (`integrations/prebid.rs:1658-1672` `merge_bidder_param_object`, `apply_routed` `:1839`).
- The only check is "is a non-empty object" (`is_unusable_bidder_params`, `:1614`).
- No JSON-schema crate is in the workspace. The params go to `imp.ext.prebid.bidder.<b>` on the remote PBS, which validates them.
- **If Trusted Server ran Shared Adapters locally**, nothing would validate params unless Prebid Core does. A typed Rust decode would turn a violation into absent or an error, while the same params through a remote PBS-Go fail the whole auction with a 400.

## 5. Schema features and drift

The catalogue sweep (`sweep.py`) counts files using each keyword anywhere in the schema. 279 PBS-Go files, 271 PBS-Java files.

| feature | Go | Java | captured by a generated TS type + `required`/`anyOf`? |
|---|---|---|---|
| top-level `required` | 225 | 216 | ✅ |
| nested `required` (incl. inside `anyOf`/`oneOf` branches; e.g. PubMatic `wrapper.profile`, `keywords[].key`) | 53 | 50 | ✅ as non-optional nested fields; the prototype's flat `required` list misses them |
| `type: integer` | 50 | 47 | ⚠️ TS has only `number`, and validators disagree on `5.0` (§3) |
| type unions (`["integer","string"]` ×16, `["number","string"]` ×1 (OpenX), `["null",…]`) | 22 | 22 | ✅ as `number \| string`, but the Phase must narrow it, and Rust needs an enum |
| `enum` | 13 | 11 | ✅ as literal unions |
| arrays / `items` / `minItems` / `maxItems` | 21 / 8 / 3 | 18 / 7 / 3 | ✅ for `items` type; ❌ for counts |
| `minLength` / `maxLength` | 135 / 3 | 120 / 2 | ❌ (half the catalogue; mostly `minLength: 1`, "non-empty string") |
| `pattern` | 25 | 17 | ❌, and the regex dialect differs: JS vs Rust `regex` vs Go RE2 vs Java |
| `minimum` / `maximum` | 24 / 2 | 24 / 3 | ❌ |
| `format` (`uuid` ×4, `hostname` ×2) | 5 | 5 | ❌, and enforced differently (§3) |
| `oneOf` | 39 | 37 | ❌ (exclusive-or of required groups or types) |
| `anyOf` | 13 | 12 | ✅ when it's `anyOf` of `required` groups (OpenX); ❌ otherwise |
| `not` / `allOf` / `if` / `dependencies` | 2 / 1 / 1 / 2 | 1 / 0 / 0 / 2 | ❌ |
| `additionalProperties: false` / schema | 4 / 3 | 2 / 2 | ❌ for `false` (TS types are open); the schema form is `Record<string, T>` |

Almost every `oneOf`/`anyOf` branch is just `{required:[…]}` (38 of 39 Go `oneOf` files, 11 of 13 `anyOf`). But `oneOf` means "exactly one", which the prototype's `anyOf` check doesn't enforce.

If each file is put in the highest tier it needs (`tier.py`):

| tier | Go | Java |
|---|---|---|
| A: types, top-level `required`, required-only `anyOf` | 94 | 105 |
| B: A plus required-only `oneOf` | 11 | 11 |
| C: B plus `enum` / nested `required` | 5 | 5 |
| D: value constraints (`minLength`, `pattern`, `format`, min/max, item counts, `additionalProperties: false`) | 161 | 145 |
| E: other combinators (`not`, `if`, `dependencies`, type-level unions) | 8 | 5 |

A generated type plus lists covers at most tiers A–C: about 110 of 279 Go files. OpenX and PubMatic are both in tier D. Java's `pangle.json` is malformed: `appid` and `placementid` sit at the schema root, outside `properties`, so they go unchecked, while its `dependencies` still apply.

**OpenX** uses `["number","string"]` unions with `pattern` and `minimum` per branch, `format: hostname` and `uuid`, and a top-level `anyOf` of `required`. **PubMatic** uses a nested object with nested `required` and `type: integer`, plus arrays of objects with `minItems`. Neither fits in "type + `required`/`anyOf`" without losing checks.

**Go and Java drift.**

- 24 files exist only in Go, 16 only in Java, and 255 in both.
- Of those 255, 36 differ once `description`, `title` and `$schema` are ignored. 18 of those differ in properties, types, `required` or combinators. Examples:
  - OpenX `unit.minimum` (Go only)
  - adtarget `aid`: `integer|string` in Go, `integer` in Java
  - between: `required` is `[host, publisher_id]` in Go, `[publisher_id]` in Java
  - consumable: `required` and `oneOf` differ
  - rtbhouse: `bidfloor`/`channel`/`region` are Go only
  - roulax: `PId` in Go, `Pid` in Java
- The map's earlier count (47 drifted, 36 one-sided) used a different comparison: it diffed descriptions too.

## Implications

### Must Prebid Core validate params itself?

**Yes, in every Host, against the Shared Adapter's own schema, before the imp Phase.** No Host guarantees a Shared Adapter schema-valid params:

- Prebid.js and Trusted Server don't validate at all.
- PBS-Go and PBS-Java validate with different libraries, formats and schema copies.
- Both PBS Hosts hand Adapters the raw `bidderparams` copy unvalidated, and AMP in PBS-Go never merges it.
- Post-validation hooks can rewrite params in both.

If Prebid Core's driver runs one generated validator first, TS and Rust only ever see a value that matches the type. Then "Rust decodes a violation as absent, TS coerces or throws" can't happen for params.

A Host's own check stays in front, so PBS-Go keeps answering 400 and PBS-Java keeps dropping the bidder. When the Host's check and Prebid Core's disagree (§3), the result is a Host-gap Known Difference, not a TS/Rust divergence.

The failure behavior Prebid Core reports should be the same everywhere. The natural choice is "imp rejected for this Adapter, with an error", which the imp Phase can already express as a reject.

### Can types and `required`/`anyOf` come from one schema?

**Yes, but generate the validator from it too, and restrict the schema language.**

From each Adapter Definition's params schema (draft-04 style), the Definition Compiler should emit:

- the TS params type;
- the Rust struct;
- a validator in TS and in Rust.

The validator, not the type, carries `minLength`, `pattern`, `minimum`, `format`, `oneOf` and integer-ness. Prebid Core should define a supported keyword subset and reject the rest, the same way Restricted TypeScript does:

- **Keep:** `type` including unions, `required` (nested too), `enum`, `items`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, `anyOf`/`oneOf` of `required` groups, `additionalProperties`.
- **Define exactly:** "integer" means a JSON number with zero fraction, so `5.0` is accepted, and both back ends must decode it. `uuid` and `hostname` need fixed rules, including case.
- **Restrict:** `pattern` to a regex subset that means the same in JS and Rust `regex`. A pattern that doesn't fit the subset is rejected.
- **Reject:** `if`/`then`/`else`, `dependencies`, `not` and `patternProperties`, until an Adapter needs one.

The schema becomes part of the Adapter Definition. The Go and Java copies would become generated output. That settles "who reconciles the drift" for Shared Adapters.

### Not covered

- PBS hook modules outside the two repos (host-company modules can mutate params after validation; none of the bundled ones do).
- Stored responses (they bypass Adapters).
- Whether AMP query-string overrides (`amp_auction.go:610` `overrideWithParams`) can reach bidder params.
- Prebid Mobile SDKs.
- How each catalogue Adapter decodes its params after validation, beyond OpenX and PubMatic.
- Timing was not measured: validation cost per imp, and what a generated validator would cost in wasm.

## Reproduce

The sources are in [`params-validation/`](params-validation/). They are throwaway tests: copy each into the Host's tree, run it, then delete it.

- **PBS-Go validator matrix:** `zz_research_params_test.go` in `openrtb_ext/`, run with `go test ./openrtb_ext -run TestZZResearchParams -v`. It calls `NewBidderParamsValidator("../static/bidder-params")` and `Validate` on each case.
- **PBS-Go `bidderparams` bypass:** `zz_research_bidderparams_test.go` in `endpoints/openrtb2/`. It runs `mergeBidderParams`, then `ortb.NewRequestValidator(…).ValidateImp`, then `pubmatic.Builder(…).MakeRequests` with `request.ext.prebid.bidderparams = {"wrapper":{"profile":"5"}}`.
- **PBS-Java validator and Jackson:** `T.java`, run as `java -cp <networknt 1.5.6, jackson 2.18.6, slf4j, itu> T.java`. It uses `JsonSchemaFactory.getInstance(V4).getSchema(<Java openx.json / pubmatic.json>)` and `ObjectMapper.convertValue` into an `Integer` record field.
- **Catalogue sweep:** `python3 -I sweep.py`. It walks both `bidder-params` trees, counting keywords per file, and diffs Go and Java with `description`, `title` and `$schema` removed.
