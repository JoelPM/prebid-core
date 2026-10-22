# What must a Host's projection keep so a Shared Adapter sees the same input on every Host?

Research for [#26](https://github.com/JoelPM/prebid-core/issues/26) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). It follows [#24](https://github.com/JoelPM/prebid-core/issues/24) ([`prototype/abi`](https://github.com/JoelPM/prebid-core/blob/prototype/abi/prototype/abi/README.md), stage 1: the Host projects its own structs for MakeBids), and uses [#23](https://github.com/JoelPM/prebid-core/issues/23) ([`research/lone-surrogates.md`](https://github.com/JoelPM/prebid-core/blob/research/lone-surrogates/research/lone-surrogates.md)) for strings and [ADR 0001](../docs/adr/0001-shared-adapter-output-is-json-equal.md) for numbers. Vocabulary is from [`CONTEXT.md`](../CONTEXT.md).

## Answer

**Keep struct projection. Don't make the Hosts' models exact; make Prebid Core read typed OpenRTB response fields the way every model can hold them, and keep `ext` exact.** Concretely:

- **Typed fields are normalized by Prebid Core, on every Host.** An optional OpenRTB attribute that is `null`, `0`, `""` or `[]` reads as absent. A required attribute (`bid.impid`, `seatbid.bid`, and `id`/`price`) that is absent or `null` reads as its zero. That is exactly what PBS-Go's `openrtb2` json tags hold (`omitempty` = optional). Every other model can produce it with a zero check, and the guest's decoder and Prebid.js's driver apply it themselves, so no Host has to be exact here.
- **Everything under an `ext` is passed as the bidder sent it.** That means absent, `null` and `0` all distinct, numbers by exact value, member order as sent, lone surrogates kept. PBS-Go already does this (`json.RawMessage`). PBS-Java's Host binding needs its own decode model (`response.ext` as `ObjectNode`, not PBS's typed `ExtBidResponse`, which drops `fledge_auction_configs`) and exact numbers in trees. Trusted Server hands Prebid Core the bytes, never a serde model.
- **What is left differs only on input that breaks the OpenRTB types**, plus two gaps already decided. These are Host-gap Known Differences, and the Hand-written Adapter on each Host sees the same thing today:
  - A typed field holding the wrong JSON type: PBS-Go and serde reject the whole response, Jackson coerces it.
  - `null` elements in typed arrays.
  - PBS-Go's case-insensitive member names.
  - Lone surrogates in PBS-Go typed strings (#23).
  - Prebid.js's f64 numbers (ADR 0001) and its `__proto__`/`constructor` stripping.

Raw-byte projection is the only fully exact option. On PBS-Go it costs +5.4 µs Host-side on OpenX `lt` and +12.1 µs on `heavy`, against 0.26 / 0.39 µs for the struct projection, and buys nothing the contract above doesn't, except on input that breaks the types. A third Go option, one decode into a shadow struct with `json.RawMessage` read paths, costs more than raw (+11.4 µs) and still loses `null`.

| Host | model the Shared Adapter would see | keeps | loses (observable) | Hand-written sees the same? | what the Host must do for the contract |
|---|---|---|---|---|---|
| **PBS-Go** | `openrtb2` structs (jsoniter), `ext` as `json.RawMessage` | `ext` subtrees byte-exact (numbers, order, dups, null, lone surrogates); typed non-zero values | typed `0`/`""`/`null` → absent (`omitempty`), absent/`null` → `""`/`0`/`null` for required fields, `null` array elements → zero values, case-insensitive member names, lone surrogates → U+FFFD in typed strings; rejects wrong-typed values, `1e400`, `mtype` > 127 | yes: `adapters/openx/openx.go:191` and `pubmatic.go:472` decode into the same structs | keep the prototype projector; write `[]` (not `null`) for a nil required slice; nothing else |
| **PBS-Java** | Jackson model with PBS's mapper (`ObjectMapperProvider`) | typed `0`/`""`/`[]` (boxed types), member order, lone surrogates | `null` → absent (NON_NULL); `response.ext` dropped entirely (typed `ExtBidResponse`); `ext` doubles > 17 digits → f64, `1e400` → string `"Infinity"`, `-0` → `0`; coerces `"2"`→2, `2.5`→2, `"IAB1"`→`["IAB1"]`, `1`→`"1"`, a lone `seatbid` object → array | yes for coercions (`OpenxBidder.java:170`, same mapper); the Hand-written never reads `response.ext` (PAAPI is already a Java Host gap, #8) | decode with its own model (`ext` as `ObjectNode`) and a copy of the mapper with exact tree numbers; drop zero typed values in the projector |
| **Prebid.js** | `JSON.parse` of the body (`parseUntrustedJSON`) | everything except numbers | numbers → f64 (`> 2^53`, > 17 digits, `1e400` → `Infinity`); `__proto__` keys and object-valued `constructor` keys removed | yes: `bidderFactory.ts:485` applies to every Adapter | run Prebid Core's normalizer before the Phases (294 B gz, measured) |
| **Trusted Server** | none today for bidders; its JSON layer is serde_json 1.0.150 (no `preserve_order`, no `arbitrary_precision`) | — | serde typed model: rejects 28/69 cases (wrong types, `null` arrays, duplicate fields, lone surrogates, invalid UTF-8), sorts `ext` keys (BTreeMap); `Value`: sorts keys, numbers → f64, rejects lone surrogates | no Hand-written bidder Adapters; its own response handling is `serde_json::Value` (`auction/provider.rs:577`) | hand the response bytes to the Prebid Core crate, whose generated decoder reads them directly: exact at no extra cost |

## Method

- **A case corpus** ([`cases.mjs`](projection-contract/cases.mjs)): 69 bid responses and 20 auction requests. Each is a base document with one mutation, aimed at the fields the prototype Adapters read, plus one or more cases per category:
  - absent, `null` and zero values;
  - number spellings and types;
  - arrays;
  - strings, escapes, lone surrogates and invalid UTF-8;
  - numbers in `ext`;
  - member order and duplicates;
  - case variants of member names;
  - structure: `null`, empty and wrong-typed `seatbid` and `bid`.
- **One probe per Host model.** Each decodes every case the way that Host decodes a bidder response and writes back what a struct projection can carry:
  - [`go/`](projection-contract/go/main.go): PBS-Go's `jsonutil.Unmarshal` into `openrtb2`, then prototype/abi's own projector, copied unchanged, for both the struct and the raw source.
  - [`java/`](projection-contract/java/Probe.java): Jackson 2.21.2, the version PBS-Java gets from Spring Boot 4.0.6's BOM. It uses PBS's mapper configuration and a mirror of PBS-Java's `com.iab.openrtb` model, generated from its sources by [`gen-model.mjs`](projection-contract/java/gen-model.mjs). The mirror is needed because Lombok won't run on JDK 27.
  - [`rust/`](projection-contract/rust/src/main.rs): Trusted Server's `trusted-server-openrtb` crate and `serde_json::Value`, at Trusted Server's serde_json version and features.
  - Prebid.js: `JSON.parse` plus its gadget-key stripping, run inside the comparator.
- **The reference** is the bytes themselves, read exactly ([`compare.mjs`](projection-contract/compare.mjs)):
  - invalid UTF-8 becomes U+FFFD (#23's boundary rule);
  - strings are UTF-16 code units with lone surrogates kept;
  - numbers keep their exact decimal value;
  - duplicate keys are last-wins at the first key's position, as `JSON.parse` does;
  - everything is cut to the union of OpenX's and PubMatic's declared read paths (`SHAPES` in prototype/abi's generated guests, [`shapes.json`](projection-contract/shapes.json)).
- **Equality is what a Restricted TypeScript Adapter can observe.**
  - Absent, `null`, `0` and `""` all differ.
  - Numbers are equal by exact value; `-0` is reported separately.
  - Member order counts only where the Adapter enumerates members (`%` paths, i.e. `Object.entries`), and then in JS order.
- **Effect on real Adapters** ([`effect.mjs`](projection-contract/effect.mjs)): prototype/abi's OpenX and PubMatic Definitions, run as written via its `core` driver, on the exact reading and on each Host's projection. Outputs are compared as JSON values.
- **Cost** ([`go/proj_bench_test.go`](projection-contract/go/proj_bench_test.go)): the Host side of each projection source on #24's bench payloads.

Results: [`results/matrix.md`](projection-contract/results/matrix.md) (per case × Host), [`results/diffs.txt`](projection-contract/results/diffs.txt) (every difference), [`results/effect.md`](projection-contract/results/effect.md) (Adapter output), [`results/bench-projection.txt`](projection-contract/results/bench-projection.txt). [`run.sh`](projection-contract/run.sh) reproduces all of them.

Sources: prebid-server `a916b19ef` (openrtb v20.3.0, json-iterator 1.1.12), prebid-server-java `a1f9ddb2f`, Prebid.js `43a96fbee`, trusted-server `5bc388625`, prebid-core `prototype/abi` as of #24. Toolchains: Go 1.27.2, JDK 27, Node 26.12.0, rustc 1.99.1. Machine: macOS arm64.

## 1. What each Host's model keeps and loses

Bid response, 69 cases, on the Adapters' read paths:

| Host model | same as the bytes | differs only in null/zero typed values | differs otherwise | rejects the response |
|---|--:|--:|--:|--:|
| PBS-Go struct (prototype stage 1) | 32 | 15 | 8 | 14 |
| PBS-Go raw (prototype `ABI_PROJ=raw`) | 69 | 0 | 0 | 0 |
| PBS-Go shadow decode (below) | 40 | 10 | 5 | 14 |
| PBS-Java, PBS's `BidResponse` model | 0 | 1 | 63 | 5 |
| PBS-Java, `ext` as `ObjectNode` | 43 | 11 | 10 | 5 |
| PBS-Java, `ext` as `ObjectNode`, exact numbers | 45 | 11 | 8 | 5 |
| Prebid.js `JSON.parse` | 64 | 0 | 5 | 0 |
| Trusted Server typed model | 30 | 9 | 2 | 28 |
| Trusted Server `serde_json::Value` | 62 | 0 | 2 | 5 |

By category. Each cell gives what the Adapter sees instead of the bidder's value.

| category | PBS-Go struct | PBS-Java (`ext` as `ObjectNode`) | Prebid.js | Trusted Server typed / `Value` |
|---|---|---|---|---|
| optional typed scalar `0` / `""` (`mtype`, `dur`, `cur`) | absent (`omitempty`, `openrtb2/bid.go:320,334`, `bid_response.go:52`) | kept | kept | kept |
| typed `null` | absent | absent (NON_NULL, `ObjectMapperProvider.java:26`) | kept | absent / kept |
| typed `[]` (`cat`, `seatbid`) | absent | kept | kept | absent (`skip_serializing_if = "Vec::is_empty"`) / kept |
| required attribute absent or `null` (`impid`, `seatbid.bid`) | `""` / `null` (no `omitempty`: `bid.go:48`, `seat_bid.go:18`) | absent | as sent | absent; `null` array rejects |
| `null` element in `seatbid`, `bid`, `cat` | zero struct / `""` | kept | kept | rejects |
| wrong JSON type (`"mtype":"2"`, `2.0`, `2.5`, `"cat":"IAB1"`, `"impid":1`, `"seatbid":{…}`) | **rejects the whole response** (jsoniter); `2e0` too | **coerces**: `"2"`→2, `2.5`→2, scalar→`[scalar]` (`ACCEPT_SINGLE_VALUE_AS_ARRAY`, `:21`), `1`→`"1"`; `2.0` → 2 is the same value | kept | rejects (typed) / kept |
| integer range (`mtype: 300`, `dur: 2^31`) | `mtype` is `int8` (`markup_type.go:7`): 300 rejects; `dur` is `int64` | `Integer`: 2^31 rejects | kept | `i32`: 2^31 rejects |
| member name case (`"MTYPE"`, `"EXT"`) | **matched case-insensitively**: `"MType":2` after `"mtype":1` makes it 2 (jsoniter `CaseSensitive` defaults to false, `config.go:27`, `reflect_struct_decoder.go:36-39`) | exact | exact | exact |
| duplicate member | last wins | last wins | last wins | typed rejects (`duplicate field`) / last wins |
| lone surrogate in a typed string | U+FFFD (#23) | kept | kept | rejects |
| `ext` member order | as sent (raw) | as sent (`LinkedHashMap`) | as sent (JS order) | **sorted** (BTreeMap): `{"b":…,"a":…}` enumerates `a,b` |
| `ext` numbers | exact text (raw) | doubles: `0.1000000000000000055511151231257827` → `0.1`, `1e400` → `"Infinity"` (a string), `-0` → `0`. With `USE_BIG_DECIMAL_FOR_FLOATS` + `withExactBigDecimals`: exact except `-0` | f64: `12345678901234567890` → `…000`, `1e400` → `Infinity` | f64; `1e400` rejects |
| `ext` `null` member, `ext: {}` | kept | kept | kept | kept |
| `response.ext` | raw | **dropped by PBS's model** (`BidResponse.java:63` is `ExtBidResponse`, which has no `fledge_auction_configs`) | kept | kept |
| invalid UTF-8 | U+FFFD | U+FFFD (`BasicHttpClient.java:109`) | U+FFFD | rejects |
| `"__proto__"`, object-valued `"constructor"` keys | kept | kept | **removed** (`src/utils/untrustedJson.ts:128-131`) | kept |
| `ext` value with a number Go can't parse (`1e400`) | **rejects the whole response** even inside a `RawMessage` | see above | see above | rejects |

PBS-Go raw projection matched the reference on all 69 cases. Prebid.js differs only in f64 numbers and gadget keys.

The auction request is a different matter, because no shared bytes exist. Each Host builds the request it hands an Adapter from its own model, after its own processing: stored requests, bidderparams, floors. Today PBS-Go's MakeRequests already hands the guest `jsonutil.Marshal(request)`, and the Hand-written Adapter reads the same structs. The same probes show what each model holds (`results/matrix.md`, "Auction request"):

- PBS-Go drops `bidfloor: 0` and `rwdd: 0`, keeps floors as f64, rejects `"bidfloor":"1.5"` and `rwdd: 1.0`, and turns lone surrogates into U+FFFD.
- PBS-Java keeps zeros and coerces `"1.5"`.
- Trusted Server's model sorts `imp.ext.data` and rejects lone surrogates.
- All of them turn `banner: null` into absent.

## 2. Which losses an Adapter can observe, and whether the Hand-written Adapter already sees them

Restricted TypeScript can observe every loss in the table:

- `=== undefined`, `== null` and `typeof` separate absent, `null` and zero (SUBSET.md, "Allowed").
- Pass-through values go into output, and in JSON `"duration": 0`, `null` and absent are different values (ADR 0001).
- `Object.entries` exposes member order.

Run on the real Definitions (`results/effect.md`), OpenX's output differs from the exact reading on:

- **11 cases with PBS-Go's struct**: `dur` 0/null, `cur` ""/null, `cat` `[null]`, case-variant names, `null` array elements, lone surrogates.
- **7 with Java's**: `null`s and coercions.
- **3 with Trusted Server's typed model and 1 with its `Value`**: the latter is the paapi order, `[a, b]` instead of `[b, a]`.

On every server Host the Hand-written Adapter decodes with the same model, so it sees the same loss: these are today's Host behaviour, not something projection introduces. The exceptions are the binding-specific choices:

- PBS-Java's typed `response.ext` would hide PAAPI from a Shared Adapter. Its Hand-written OpenX doesn't read it at all, which #8 already lists as a Java Host gap.
- Trusted Server has no Hand-written bidder Adapters to compare with.

With the normalization rule below, the outputs agree except on:

| Host model | OpenX cases still different | PubMatic | which |
|---|--:|--:|---|
| PBS-Go struct | 7 | 6 | `null` array elements, case-variant names, lone surrogate (all already in the Hand-written Adapter) |
| PBS-Java `ObjectNode` | 5 | 3 | coercions: `"30"`→30, `2.5`→2, `"IAB1"`→`["IAB1"]`, `1`→`"1"`, `seatbid` object → array |
| Trusted Server `Value` | 1 | 1 | sorted `ext` keys (avoided by handing Prebid Core the bytes) |
| PBS-Go raw | 0 | 0 | — |

Every remaining case is input that breaks the OpenRTB types or the PBS-Go string gap from #23. PBS-Go's own fixtures contain no zero or `null` value on a path OpenX or PubMatic reads, except `mtype: 0` (`pubmatic_test.go:551`), which both models treat as "no mtype".

## 3. Proposed projection contract

**Bid response (MakeBids input).** The bidder's bytes are the common ground: every Host receives the same ones.

1. **Paths.** The projection holds exactly the guest's declared paths (`<bidder>_shapes`). Whole-value nodes are projected whole, as #24's compiler rules already require.
2. **Typed OpenRTB fields** are the members Prebid Core's OpenRTB input types (`core/ortb.ts`) declare as OpenRTB scalars or arrays, i.e. everything not under `ext` or typed `Json`. On them, **Prebid Core reads a normalized value**:
   - An optional attribute that is `null`, `0`, `""` or `[]` is absent.
   - A required attribute (`response.id`, `seatbid.bid`, `bid.id`, `bid.impid`, `bid.price`) that is absent or `null` is its zero.
   - The normalization is done by Prebid Core itself: the generated decoder in the guest and the crate, and the driver in Prebid.js. A Host's projection may therefore drop or add exactly those values and nothing else.
   - Non-zero values keep their value: integers exactly, floats at least as f64, strings per #23.
3. **`ext` subtrees** (anything under an `ext` member, and any field typed `Json`) are **passed as received**:
   - absent, `null`, `0`, `""`, `[]` and `{}` all stay distinct;
   - numbers keep their exact decimal value (their text may be respelled);
   - strings are UTF-16 code units, lone surrogates kept (#23);
   - member order is the bytes' order;
   - duplicate keys resolve last-wins at the first key's position (the guest's rule), so a Host may pass duplicates through or resolve them itself the same way.
4. **Member names match exactly** (case-sensitive).
5. **Structure is the Host's.** The bids the Adapter sees are exactly the Host's parsed bids, in order: one bid Phase call and one annotation per Host bid. A response the Host's own decode rejects reaches no Adapter, as today for the Hand-written one.
6. **No Host-specific coercion is allowed in rules 2–4.** Where the Host's existing decode coerces or rejects ill-typed values, that stays Host behaviour, listed as below.

**Auction request (MakeRequests input): the Host's model, projected faithfully.** The guest sees what the Hand-written Adapter on that Host sees. #24's stage 1 already does this. No normalization: it would change outgoing bodies on Hosts that keep zeros, e.g. Java's `"bidfloor": 0`, against their Hand-written Adapters. Cross-Host request differences stay the map's open Host-side Parity question.

**What each Host must do:**

- **PBS-Go:**
  - Keep the prototype's struct projector.
  - It already omits `omitempty` zeros and passes `json.RawMessage` whole (`hostgo/host/project.go:166,178`).
  - Change one thing: a nil *required* slice must be written as `[]` or omitted, never `null` (`project.go:190`). The guest's normalization makes either equivalent.
- **PBS-Java:**
  - The Host binding decodes the response with its own top-level type, the real `SeatBid`/`Bid` with `ext` as `ObjectNode`, and a `mapper.copy()` with `USE_BIG_DECIMAL_FOR_FLOATS` and `JsonNodeFactory.withExactBigDecimals(true)`. Measured: this keeps every `ext` number exact except `-0`.
  - The projector is a walk of that model like Go's, writing with Jackson's byte writer (#23).
  - It may drop zero typed values or leave them; the guest normalizes.
- **Trusted Server:** hand the bytes. Prebid Core is compiled in as a crate (#3), so its generated decoder reads the response directly. That is raw projection at no extra cost, and exact. Neither of Trusted Server's serde models may stand in between.
- **Prebid.js:** Prebid Core's driver normalizes the parsed response before the Phases. Measured at 294 B gz minified ([`pbjs/normalize.ts`](projection-contract/pbjs/normalize.ts)), inside the ≤ 3 KB runtime budget (current prototype runtime 1.10 KB).

**Host-gap Known Differences** (on top of #23's and ADR 0001's). Each is pinned by a fixture only when a bidder actually sends such input:

| Known Difference | Hosts | Hand-written same? |
|---|---|---|
| A typed field of the wrong JSON type, or out of the model's range, rejects the whole response | PBS-Go (jsoniter), Trusted Server (if it ever decodes typed) | yes |
| The same input is coerced to the field's type (`"2"`→2, `2.5`→2, scalar→array, number→string) | PBS-Java | yes |
| Member names matched case-insensitively | PBS-Go | yes |
| `null` elements in typed arrays become zero values | PBS-Go | yes |
| Numbers are f64 | Prebid.js | yes (ADR 0001) |
| `__proto__` and object-valued `constructor` keys removed | Prebid.js | yes |
| Lone surrogate → U+FFFD in typed strings | PBS-Go | yes (#23) |
| A number PBS-Go can't parse (`1e400`), even inside `ext`, rejects the response | PBS-Go | yes |

## 4. Recommendation

**Struct projection with the written contract and the Known Differences above.** Not raw-byte projection, and no per-path hybrid.

- **Cost.** PBS-Go, Host side, per call (`results/bench-projection.txt`):

  | | OpenX `lt` (5,995 B) | OpenX `heavy` (11,294 B) | PubMatic `lt` | PubMatic `heavy` |
  |---|--:|--:|--:|--:|
  | Host's own `jsonutil.Unmarshal` (the Hand-written Adapter pays this too) | 12.2 µs | 22.1 µs | 12.2 µs | 22.0 µs |
  | struct projection | **0.26** | **0.39** | 2.4 | 3.9 |
  | raw projection | 5.6 | 12.5 | 5.5 | 12.5 |
  | shadow decode (one `jsonutil.Unmarshal` into `openrtb2` with `json.RawMessage` read paths, then fill the real fields) | 23.7 (incl. parse) | 44.5 (incl. parse) | — | — |

  Raw projection adds +5.4 µs Host-side on OpenX `lt`. #24 measured +4.6 µs end to end (stage 1 +5.3 → +9.9 µs), which puts generated OpenX at the gate, and `heavy` at +18.2 µs, over it.
- **What raw would buy.** Exactness on the cases in the Known Difference table. It would also *create* a difference: a Shared Adapter on PBS-Go would see input its Hand-written Adapter doesn't, so Parity with today's Host gets worse, not better.
- **Why not hybrid.**
  - The natural hybrid, "raw for `ext`, struct for typed fields", is what PBS-Go's struct projection already is, because every `ext` is a `json.RawMessage`.
  - A per-path hybrid (raw only for typed paths whose zero matters) costs a full raw scan as soon as one path needs it: the scan, not the number of paths, is the cost.
  - The shadow decode does it in one pass but is slower than raw and still loses `null` (jsoniter leaves a `RawMessage` nil for `null`).
- **Why normalize rather than make models exact.**
  - PBS-Go's model can't hold the distinctions, and making it hold them costs a raw scan.
  - The distinctions are all within "missing or default" for OpenRTB typed attributes, which Adapters and Hosts already treat alike: OpenX `bid.mtype ?? 0`, PBS defaulting a blank `cur` to USD, the Go Host's `ExtBidPrebidVideo.Duration` int.
  - Normalizing makes the PBS-Go model the canonical typed view, at zero cost there and a zero check elsewhere.
  - It also simplifies the typed back end (below).

**Implications for the Host binding and the ABI tickets:**

- **Host binding:**
  - PBS-Go keeps #24's binding.
  - PBS-Java's binding owns its response decode model and mapper copy, so it can't reuse `BidResponse.class` as `OpenxBidder` does.
  - Trusted Server's binding passes bytes.
  - Prebid.js's driver normalizes.
  - The binding contract should state the bid-alignment rule (rule 5). The prototype pairs the guest's annotations with `br.SeatBid[*].Bid[*]` by index (`shared.go:245-250`). Raw projection could misalign under PBS-Go's case-insensitive names (`"SeatBid"`); struct projection can't.
- **[#25](https://github.com/JoelPM/prebid-core/issues/25), typed codegen on stage 1:**
  - Normalization lets generated Rust decode optional typed scalars as zero-as-absent (`Option<NonZero…>`, or a plain value with 0 meaning absent, like Go) and required ones as plain values.
  - Presence checks and `??` then compile to zero tests.
  - `ext` and `Json` nodes keep the current exact views.
- **[#27](https://github.com/JoelPM/prebid-core/issues/27), on-demand reads:**
  - An on-demand read must return what the projection would have held for that path: the Host's struct for typed fields (normalized by the guest) and raw bytes for `ext`.
  - On PBS-Go both come from `openrtb2.Bid` cheaply: typed fields and `Ext` are fields of the struct already parsed.
  - PubMatic's native-only `adm` read is a typed string, so it falls under the typed rule.

## Caveats and not covered

- **Not measured:**
  - The PBS-Java and Trusted Server projectors' costs; the PBS-Java binding's decode with `ObjectNode` `ext` and exact tree numbers (argued to be about today's decode).
  - The guest-side normalization cost: a zero test per typed leaf, argued negligible.
  - x86-64 Linux.
- **The Java probe is a mirror, not PBS-Java itself.** It is a generated record mirror of PBS-Java's model, decoded with PBS's mapper configuration. PBS's typed `ext` classes other than `ExtBidResponse` are approximated as `JsonNode`; no read path here goes through one.
- **Trusted Server:** only its JSON layer and OpenRTB crate are tested. It has no bidder Adapter path to test.
- **Paths:** the paths are OpenX's and PubMatic's. Other Adapters read other typed fields, and each class (optional/required) is covered, but per-field rules beyond the response's `id`/`impid`/`price`/`seatbid.bid` required set aren't checked.
- **`-0`:** `-0` in `ext` reaches Java as `0`. ADR 0001 counts them equal, but Restricted TypeScript can tell them apart through division (`1/x`).

## Open questions

1. **Does normalizing typed zeros lose meaning for any OpenRTB response attribute a future Shared Adapter needs?**
   - `price` is required, so 0 stays 0 (PBS-Go accepts zero-price deal bids: `exchange/bidder_validate_bids.go:132`).
   - Optional attributes where 0 is a value rather than "unset" (`exp`? `w`/`h`?) would need the Definition to read them as `?? 0`.
   - Is a per-field exception list needed, and who owns it (the OpenRTB input types)?
2. **The normalization itself.** Should it be an ADR (it binds Prebid.js's driver, the Rust decoder and every Host binding)? Should Restricted TypeScript's input types say it, e.g. no `0` literal comparisons on optional typed fields?
3. **PBS-Java coercions.** Should PBS-Java's binding decode strictly (disable scalar coercion and `ACCEPT_SINGLE_VALUE_AS_ARRAY`) so it rejects like PBS-Go? That diverges from its Hand-written Adapter instead.
4. **Upstream report candidates:**
   - PBS-Go's case-insensitive member matching lets `"MType"` override `"mtype"` (jsoniter default; also affects Hand-written Adapters).
   - PBS-Go rejects a whole response for an unparseable number inside a `RawMessage` `ext`.
5. **`-0`:** pin `-0` reads as `0` in Restricted TypeScript, or reject division by input values?
