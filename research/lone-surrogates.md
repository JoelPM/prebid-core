# What happens to a lone UTF-16 surrogate on its way to a Shared Adapter?

Research for [#23](https://github.com/JoelPM/prebid-core/issues/23) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). It follows [#22](https://github.com/JoelPM/prebid-core/issues/22) ([`research/params-schema-subset.md`](https://github.com/JoelPM/prebid-core/blob/research/params-schema-subset/research/params-schema-subset.md), "Lone surrogates" open question). Vocabulary is from [`CONTEXT.md`](../CONTEXT.md). Equality follows [ADR 0001](../docs/adr/0001-shared-adapter-output-is-json-equal.md): strings are exact once decoded.

## Answer

**No two Hosts agree, and the prototype Rust runtime agrees with none of them. The contract should be JavaScript's: a string is a sequence of UTF-16 code units, and a lone surrogate is preserved like any other code unit.** That is what Prebid.js does today when it runs a Definition as written, at no cost. The other choices break "runs as written": normalizing to U+FFFD would need a replacer on every `JSON.stringify`, including the Definition's own ones (PubMatic's native `adm`). Failing the Adapter call would drop a bidder because one page title was cut through an emoji.

What happens today:

- **PBS-Go** turns a lone surrogate into U+FFFD in typed OpenRTB fields. It passes it through verbatim in every `json.RawMessage`: `imp.ext` (params included), `site.ext`, `user.ext`, and the raw bidder response body. `jsonparser.GetString` returns an error, so the field reads as absent.
- **PBS-Java (Jackson)** keeps it.
- **Prebid.js** keeps it.
- **Trusted Server (serde_json)** rejects the whole `/auction` request with a 400, and drops a bidder response that contains one.
- **The prototype runtime** keeps it on a raw copy and turns it into U+FFFD on every read. So `"\ud800" == "\udc00"` is true, and a string that holds both an escape and an invalid UTF-8 byte reads as `""`.

Where a Host can't carry a lone surrogate, the Host's own behaviour becomes a Host-gap Known Difference.

**For the typed Rust back end ([#17](https://github.com/JoelPM/prebid-core/issues/17)):**

- String values read from input can't be plain `&str`/`Cow<str>`, and serde `String` fields are ruled out because they reject the whole document.
- `&str` stays as the fast path: a string can be borrowed as `&str` whenever its escaped span holds no `\uD800`–`\uDFFF` escape. The decoder can check that inside `unescape`, which already visits every escape.
- Everything else needs a WTF-8 slow path.
- Input needs one UTF-8 validation at the guest boundary: 0.06–0.4 µs per call on the bench payloads.

## Per Host and per Implementation

Every case was run through each JSON layer: [`lone-surrogates/cases.tsv`](lone-surrogates/cases.tsv) (`{"s":"…"}` documents) and [`adm.tsv`](lone-surrogates/adm.tsv). Raw output is in [`lone-surrogates/results.txt`](lone-surrogates/results.txt).

| layer | `"\ud800"` / `"\udc00"` / `"\ud800A"` | valid pair, escaped or literal | invalid UTF-8 (`\xff`, WTF-8 `ED A0 80`, cut `F0 9F 98`) | what reaches a Shared Adapter |
|---|---|---|---|---|
| PBS-Go typed field (jsoniter `jsonutil`, `encoding/json`) | U+FFFD | 😀 | jsoniter keeps the bytes and writes them back as `�`, one per byte. `encoding/json` decodes each byte to U+FFFD. `json.Valid` accepts all of them | U+FFFD, or `�` per bad byte |
| PBS-Go `json.RawMessage` (every `ext`, so params, FPD `ext`) | **escape kept verbatim** | as sent | **bytes kept verbatim** | escape, raw bad bytes |
| PBS-Go bidder response | Hand-written: U+FFFD. Prototype Host: raw body | — | raw | escape, raw bad bytes |
| PBS-Go `jsonparser.GetString` | **error → field treated as absent** | 😀 | bytes kept | — |
| PBS-Java Jackson (body decoded to a `String` first) | **kept** as a lone `char`. `writeValueAsBytes` → `\uD800`. `writeValueAsString`+`getBytes` → `?` | kept; written back as `😀` | Vert.x's UTF-8 decode → U+FFFD. Java's counts: `ED A0 80` → 1, WHATWG → 3 | escape, if the Host binding serializes with Jackson's byte writer |
| Prebid.js (V8 `JSON`, `fetch().text()`) | **kept**. `JSON.stringify` → `\ud800` (ES2019). `encodeURIComponent` throws `URIError` | kept | WHATWG U+FFFD (`ED A0 80` → 3, cut → 1) | kept, natively |
| Trusted Server serde_json 1.0.150 | **`/auction` → 400 for the whole auction; provider response → that provider fails** | 😀 | same as a lone surrogate | never |
| Prototype runtime (`runtime/rs` `Doc`) | raw copy keeps it. `string()`, `trim`, `split`, `includes`, `kv_slot` → U+FFFD. `stringify` keeps it. **`eq("\ud800","\udc00")` is true** | 😀 | raw copy keeps the bytes. Reads give U+FFFD, but **escape + bad byte reads as `""`**, and `stringify` of any bad byte → `""` | — |
| Typed guest (`typed/src/j.rs`) | same as the runtime: shares `unescape` | 😀 | same | — |
| serde typed back end (`String` / `Value`) | **whole document rejected** (`&RawValue` keeps it, and bytes decode to WTF-8) | 😀 | rejected | — |

## 1. Each Host's JSON layer

Sources: prebid-server `a916b19ef`, prebid-server-java `a1f9ddb2f`, Prebid.js `43a96fbee`, trusted-server `5bc388625`. Toolchains: Go 1.27.2 (json-iterator 1.1.12, jsonparser 1.1.2), JDK 27 with Jackson 2.18.6, Node 26.12.0, rustc 1.99.1 with serde_json 1.0.150.

### PBS-Go

- **Request:**
  - The body is read as bytes (`endpoints/openrtb2/auction.go:443`). It is decoded with `jsonutil.UnmarshalValid` (`:539`), which is jsoniter's `ConfigCompatibleWithStandardLibrary` (`util/jsonutil/jsonutil.go:125,148`).
  - jsoniter decodes a surrogate escape that isn't followed by a valid partner to U+FFFD (`json-iterator/go@v1.1.12/iter_str.go:54-86`, `appendRune` at `:200`). `encoding/json` does the same (`encoding/json/decode.go:1270-1279`).
  - **Every `ext` is a `json.RawMessage`.** That covers `imp.ext` and so params, plus `site.ext`, `user.ext`, `app.ext` and `request.ext`. These keep the bytes exactly as sent.
  - When the exchange rebuilds `imp.ext` for each bidder, it works on `map[string]json.RawMessage` (`exchange/utils.go:738`). `jsonutil.Marshal` writes a RawMessage through `json.Compact` (`jsonutil.go:242-250`), which changes neither escapes nor bytes.
  - Measured: a lone escape and raw invalid bytes both survive a RawMessage round trip.
- **Invalid UTF-8:**
  - `json.Valid` accepts it.
  - jsoniter keeps the raw bytes in a Go `string`. On marshal it writes `�` per bad byte (`stream_str.go:276-280`).
- **Bidder response:**
  - Hand-written Adapters decode with `jsonutil.Unmarshal`, for example `adapters/openx/openx.go:191` and `adapters/pubmatic/pubmatic.go:472`. That gives U+FFFD.
  - The prototype's Shared Adapter Host checks the body with `jsonutil.Unmarshal`, then hands the **raw body** to the guest (`prototype/profile-compiler/hostgo/host/shared.go:164-170`).
  - The outgoing request it gives the guest is `jsonutil.Marshal(request)` (`shared.go:125`). In it, typed fields are already U+FFFD, and `ext` content is verbatim.
- **`jsonparser`:**
  - `GetString` fails on any surrogate escape without a valid partner (`buger/jsonparser@v1.1.2/escape.go:62-79`). The misleading error is "Value looks like Number/Boolean/None".
  - PubMatic's Hand-written Adapter reads `imp.ext.data.adserver.adslot` and `app.ext…source/version` this way (`adapters/pubmatic/pubmatic.go:598-599,707-714`). It treats an error as absent, so a lone surrogate in the GAM ad slot silently drops the slot.
- **Native `adm` (PubMatic, `pubmatic.go:549-567`):**
  - The outer `bid.adm` is a typed string, so a lone surrogate in the adm *text* becomes U+FFFD.
  - The inner `native` object is cut out raw with `jsonparser.Get`, so an escape *inside* the native JSON is kept.

### PBS-Java

- **Request:**
  - The body is decoded to a Java `String` first (`AuctionRequestFactory.java:162`, `routingContext.body().asString()`). That decode replaces invalid UTF-8 with U+FFFD.
  - Jackson then reads the `String` (`:184-186`). It keeps a lone surrogate as a lone `char` in typed fields and in `ObjectNode` exts alike.
- **Bidder response:**
  - Bidder responses are decoded the same way (`vertx/httpclient/BasicHttpClient.java:105-109`, `body.toString(UTF_8)`). Then `mapper.decodeValue(String)` (`OpenxBidder.java:170`).
- **Outgoing:**
  - Outgoing requests are written with `writeValueAsBytes` (`util/BidderUtil.java:46`). It writes a lone surrogate as `\uD800`, so the escape is preserved.
  - Measured: a Host binding that used `writeValueAsString(...).getBytes(UTF_8)` would turn it into `?`.
- **Native `adm` (`PubmaticBidder.java:616-631`):** `readTree(adm).get("native").toString()` turns both an outer escape and an inner escape into a raw lone `char` inside the adm text. When written out, that is `{"adm":"{\"t\":\"\uD800\"}"}`.

### Prebid.js

- **Request:** there is no JSON on the way in. Publisher config, `ortb2` FPD and page reads are JS strings, which can hold lone surrogates.
- **Outgoing:**
  - The outgoing body is `JSON.stringify(request.data)` (`src/adapters/bidderFactory.ts:589`). Since ES2019 it writes lone surrogates as `\udXXX` escapes, so they survive `fetch`'s UTF-8 encoding.
  - A raw string sent without `JSON.stringify` would turn into U+FFFD.
  - GET Adapters that use `parseQueryStringParameters` / `formatQS` call `encodeURIComponent` (`src/utils.js:100,111`), which **throws `URIError`** on a lone surrogate.
- **Bidder response:** responses arrive through `fetch().text()` (`src/ajax.ts:240-245`), which is WHATWG UTF-8 decoding with U+FFFD per maximal subpart. Then `parseUntrustedJSON` = `JSON.parse` (`src/utils/untrustedJson.ts:128-130`) keeps lone surrogates.
- **Native `adm`:** `JSON.stringify(JSON.parse(adm).native)` writes the escape *text* `\ud800` for both an outer and an inner escape.

### Trusted Server

- **Auction request:** the browser's `/auction` body is decoded with `serde_json::from_slice::<AdRequest>` (`crates/trusted-server-core/src/auction/endpoints.rs:160-163`). Any lone surrogate escape or invalid UTF-8 → `BadRequest`, **for the whole auction, before any bidder**. Prebid.js writes lone surrogates as escapes, so one cut emoji in the publisher's FPD fails the auction.
- **Bidder responses:**
  - Provider responses: `serde_json::from_slice::<Value>` (`auction/provider.rs:577-588`) → `AuctionResponse::error`, so only that provider is dropped.
  - Prebid Server's response: `integrations/prebid.rs:2214,3162` → `TrustedServerError::Prebid`.
- **Why serde rejects it:**
  - serde_json rejects lone surrogates when it decodes a string (`serde_json-1.0.150/src/read.rs:900-970`, the `validate` branch: "unexpected end of hex escape" / "lone leading surrogate in hex escape").
  - It accepts them in `&RawValue` (left undecoded) and when deserializing bytes, which writes WTF-8 (the `push_wtf8_codepoint` branch).
  - It rejects invalid UTF-8 everywhere except `IgnoredAny`.

## 2. What reaches a Shared Adapter, per path

| path | PBS-Go | PBS-Java | Prebid.js | Trusted Server |
|---|---|---|---|---|
| params (`imp.ext.prebid.bidder` → `imp.ext.bidder`) | escape and bad bytes, verbatim | escape | lone code unit | nothing (400) |
| `imp.ext.data`, `site.ext`, `user.ext` (FPD) | escape and bad bytes, verbatim | escape | lone code unit | nothing (400) |
| typed FPD: `site.page`, `site.keywords`, `site.content.title`, `user.keywords`, `user.data[].segment[].value` | U+FFFD, or `�` per bad byte | escape | lone code unit | nothing (400) |
| bidder response fields | escape and bad bytes, raw body | depends on the binding: Jackson bytes keep the escape, `getBytes` gives `?` | lone code unit (bad bytes → U+FFFD) | nothing if the Host parses with serde first, as today |
| native `adm` text, re-serialized by PubMatic | as above: the guest gets the raw response | as above | lone code unit | as above |

Within today's Restricted TypeScript ([`SUBSET.md`](https://github.com/JoelPM/prebid-core/blob/prototype/ts-transpiler/prototype/ts-transpiler/SUBSET.md) l.31-34), a Definition can't create a lone surrogate from well-formed input, though it can join two lone halves into a pair:

- Its only string operations are `trim`, `toLowerCase`, `split('<literal>')`, `includes`, `.length`, `join`, templates and `JSON.stringify`.
- `slice`, `substring`, string `[i]` and `split('')` would break that, which is one reason to keep them out.
- The compiler must also reject string literals that aren't well-formed, such as `'\uD800'`.

So lone surrogates only ever come from input.

## 3. The prototypes' Rust side

Branches [`prototype/ts-transpiler`](https://github.com/JoelPM/prebid-core/tree/prototype/ts-transpiler) @ `21d1d49` (`prototype/ts-transpiler/runtime/rs/src/`) and [`research/typed-codegen`](https://github.com/JoelPM/prebid-core/tree/research/typed-codegen) @ `85b5156` (`prototype/profile-compiler/typed/src/`). Runs: [`rt/`](lone-surrogates/rt/src/main.rs) and [`typed/`](lone-surrogates/typed/src/main.rs).

- **Parse:**
  - `Doc::parse` (`lib.rs:91`) and the typed cursor `P` (`j.rs:42-50`) are lenient. They neither validate escapes nor check UTF-8.
  - Strings stay escaped spans. **So the Rust side never fails the request, never drops the Adapter, and passes the escape through unchanged on any raw copy.** That covers `emit` (`lib.rs:780`), `W::jstr` (`j.rs:546`) and untouched subtrees. Raw invalid bytes are copied the same way and reach the bidder.
- **Reads are lossy:**
  - `unescape` (`lib.rs:908-916`) is `String::from_utf16_lossy`, so every string a rule reads has U+FFFD in place of a lone surrogate.
  - That covers `string()` (`:339`) and everything built on it: `trim` (`:622`), `lower`, `split` (`:645`) / `split_js` (`js.rs:141`), `contains` / `includes_js` (`js.rs:151`), `str_`, templates, `join`, `json()` (`:748`), `kv_slot` (`:1155`), and the typed guest's `JStr::cow`, `key_is` and `key` (`j.rs:29,224,229`).
  - So one output can hold the same input string both preserved (copied) and replaced (rewritten).
- **Comparison is wrong:**
  - `eq` (`lib.rs:494-499`) falls back to comparing lossy strings. So `eq("\ud800","\udc00")`, `eq("\ud800","�")` and `includes("\ud800A","�")` are all true. JS says false.
  - `.length` comes out right by accident: one U+FFFD per lone unit.
- **Data loss on invalid UTF-8:**
  - `unescape_utf16` starts with `std::str::from_utf8(raw).unwrap_or("")` (`lib.rs:884`). So a string holding both an escape and an invalid byte reads as `""`, for example `"x\ny<ff>z"` → `""`. So does `stringify` of any invalid-UTF-8 string (`emit_canonical`, `:813`).
  - `trim` then leaves the span untrimmed, because `""` has the same length as `""`.
  - PBS-Go can deliver such strings: RawMessage `ext`s and raw response bodies. PubMatic's typed `native_adm` (`pubmatic.rs:838`) also has `from_utf8(..).unwrap_or("")`.
- **`stringify` is right for a lone escape:**
  - `emit_canonical` decodes to UTF-16 and `canonical_string` (`lib.rs:940`) writes lone units as `\udXXX`, exactly like ES2019 `JSON.stringify`.
  - So PubMatic's native `adm` with an *inner* escape matches JS.
  - With an *outer* escape (a lone surrogate in the adm text itself), `json(adm)` first goes through the lossy `string()`. The result is `{"t":"�"}` where JS gives `{"t":"\ud800"}` (escape text).
- **A serde back end:**
  - Typed decoding into `String` fails the **whole** document, so the call fails. That is the opposite of every other Implementation.
  - `&RawValue` keeps lone escapes but rejects invalid UTF-8.
  - `serde_bytes` decodes escapes to WTF-8: `\ud800` → `ED A0 80`. An escaped high surrogate followed by a raw WTF-8 low one gives CESU-style bytes, not one joined code point.

## 4. Do lone surrogates occur in real traffic?

**No direct evidence was found, but Prebid.js itself has a mechanism that produces them.**

- **Searches:**
  - `git log --grep` for surrogate / UTF-8 / U+FFFD / emoji / URIError over all four Hosts' full histories finds nothing about lone surrogates.
  - The same goes for GitHub issue searches on prebid/prebid-server, prebid/prebid-server-java, prebid/Prebid.js and IABTechLab/trusted-server. Terms: "surrogate", "invalid UTF-8", "unexpected end of hex escape", "lone", "emoji", "URIError".
  - Nearby hits are unrelated: Prebid.js#5314 (`decodeURIComponent` on Latin-1 query strings) and prebid-server#2379 (a gzip body read as text).
  - No Host has code that handles lone surrogates: no `isWellFormed`, `toWellFormed` or surrogate checks.
- **The mechanism:** seven Hand-written Prebid.js Adapters truncate page title, description or keywords by UTF-16 code units:
  - `discoveryBidAdapter.js:281-283`
  - `greenbidsBidAdapter.js:61-62`
  - `mediagoBidAdapter.js:300-302`
  - `teadsBidAdapter.js:67-68`
  - `sevioBidAdapter.js:369,372`
  - `superedgeBidAdapter.js:234-236`
  - `pubxBidAdapter.js:76,86,92`

  When an emoji or other astral character straddles the cut, the result is a lone high surrogate, and `JSON.stringify` sends it as `\ud83d`. Measured: `'Big sale 😀😀'.substring(0,10)` → `"Big sale \ud83d"`. Those bidders' endpoints receive lone surrogates whenever a title has an emoji at the cut.
- **Other likely sources (not evidenced):**
  - Publisher JS that truncates FPD the same way.
  - DSPs that truncate native titles to the request's `title.len` in Java or JS, which puts the lone surrogate in a native `adm`.
- **Browser page reads can't produce them:** HTML parsing and `TextDecoder` never produce lone surrogates (`&#xD800;` becomes U+FFFD). Only JS string slicing or a JSON escape can.

## 5. Recommendation

### Contract

Add to ADR 0001 or a sibling ADR:

1. **A Prebid Core string is a sequence of UTF-16 code units, as in JavaScript.** Lone surrogates are ordinary values. Reads, comparisons and every Restricted TypeScript string operation preserve them. Output writes them as `\uXXXX` escapes, as ES2019 `JSON.stringify` does; escape case doesn't matter, by ADR 0001. Equality is code-unit equality, so `"\ud800" ≠ "\udc00" ≠ "�"`.
2. **Prebid Core's input is UTF-8 JSON text.** Invalid UTF-8 is replaced with U+FFFD per maximal subpart (WHATWG / Unicode §3.9 practice, which is what `TextDecoder` and Rust's `from_utf8_lossy` do) before anything reads it.
3. **Never fail the call, and never drop the Adapter, because of string contents.** Where a Host can't carry a lone surrogate, the Host's own replacement or rejection is a **Host-gap Known Difference** pinned by a fixture.

### What each Implementation must do

- **TypeScript (Prebid.js): nothing.** This is what JS does when the Definition runs as written.
- **Rust:**
  - Keep strings escaped as they are now. Decode them to code-unit semantics, not to `str`.
  - Fast path: a span with no `\uD800`–`\uDFFF` escape is valid UTF-8 once the boundary is sanitized, so it can be borrowed or unescaped as `&str` / `Cow<str>`. Detect this inside `unescape`, which already walks the escapes, not in a separate pass.
  - Slow path: WTF-8, as `Cow<[u8]>` behind a newtype. It needs:
    - `eq` as byte equality of canonical WTF-8.
    - `includes` that falls back to UTF-16 when the needle contains a surrogate. In JS, `"😀".includes("\ud83d")` is true, which WTF-8 byte search misses.
    - `trim` and `toLowerCase` that leave surrogates alone.
    - `split` on a well-formed literal, which is safe as a byte search.
    - `.length` in UTF-16 units.
    - `join` and templates that fuse an adjacent high + low into one code point (`'\ud83d' + '\ude00'` is 😀 in JS).
    - `json()` that parses WTF-8 text.
    - `stringify` / `emit` that write lone units as escapes.
  - Fix the three bugs in §3: lossy reads, `eq`/`includes` conflation, and `unwrap_or("")`.
  - Sanitize input once at the guest boundary: `str::from_utf8`, and `from_utf8_lossy` only when that fails. Do it in Rust rather than in the Go binding, because Go's replacement differs from WHATWG on cut sequences (3 vs 1 U+FFFD).
  - Add these cases to the TS-vs-Rust differential fuzz and to the Restricted TypeScript conformance suite.
- **Host bindings:**
  - PBS-Go: pass bytes as now.
  - PBS-Java: serialize what it hands Core with Jackson's byte writer (`writeValueAsBytes`), or pass the original body bytes. **Never `String.getBytes`**, which writes `?`.
  - Trusted Server: hand Core the raw provider response, not a pre-parsed `serde_json::Value`.
  - Every binding: string slots that a Host turns into native strings (seat, currency, errors, `kv_slot` kind 0) get U+FFFD in Go and Rust. JSON slots (request body, `meta`, `video`, overrides) keep the escapes.

### Known Differences this creates

| Host | Known Difference | kind |
|---|---|---|
| PBS-Go | typed OpenRTB string fields reach Core as U+FFFD | Host gap (Go Hand-written Adapters see the same) |
| PBS-Go, Trusted Server | string slots decoded into native strings carry U+FFFD instead of a lone surrogate | Host gap |
| Trusted Server | a lone surrogate or invalid UTF-8 anywhere in `/auction` fails the whole auction before Core | Host gap (worth an upstream report) |
| PBS-Java | invalid UTF-8 is replaced by Java's decoder (`ED A0 80` → 1 U+FFFD, WHATWG → 3) before Core | Host gap |
| PBS-Java PubMatic | native `adm` holds a raw lone `char` where the Definition writes the escape text `\ud800` | drift, settled for the Definition |
| PBS-Go PubMatic | an outer-escaped lone surrogate in native `adm` becomes U+FFFD | Hand-written bug (it decodes `bid.adm` lossily) |
| PBS-Go PubMatic | `imp.ext.data.adserver.adslot` with a lone surrogate is ignored (`jsonparser.GetString` error) | Hand-written bug |

### Costs

- **Prebid.js:** none.
- **Rust:**
  - Strings with no surrogate escape keep the zero-copy `&str` path.
  - Strings that do hold one take the WTF-8 path. The newtype and its operations, about 200 lines, are not yet written, so their cost is unmeasured.
  - Measured with [`cost/`](lone-surrogates/cost/src/lib.rs), boundary UTF-8 validation of the four bench payloads (1.6–11 KB) costs **55–175 ns native, 67–400 ns in wasm under V8**. wazero wasn't measured; #16 found it 2.4–2.8× behind native.
  - A *separate* naive pass that looks for surrogate escapes costs 0.4–3.3 µs, because the payloads are full of `\"`. That is why the check belongs inside `unescape`.
- **The other options would cost more:**
  - Normalizing to U+FFFD would need a Prebid.js `JSON.stringify` replacer, which disables V8's fast path. It would also have to cover the Definition's own `JSON.stringify` and `JSON.parse`.
  - Failing the call would turn a cut emoji into a lost bidder.

## Not covered

- A PBS-Java Host binding (none exists yet), so its choice of byte writer is a requirement, not a measurement.
- The WTF-8 slow path itself and its cost on real fixtures.
- Charsets other than UTF-8 in bidder responses, such as `Content-Type: …; charset=ISO-8859-1`.
- Lone surrogates in object *keys*. By reasoning they follow the same rule; they weren't run separately.
- Go's `encoding/json/v2`, which would change PBS-Go's behaviour if adopted.
- Wasm cost under wazero, Chicory or GraalWasm.
- Real traffic samples. No bid-stream data was available.

## Reproduce

`lone-surrogates/run.sh` runs everything in this document and writes the output in [`results.txt`](lone-surrogates/results.txt). It needs the sibling checkouts (`../prebid-server` and the `prototype/ts-transpiler` and `research/typed-codegen` worktrees) and Jackson 2.18.6 in `~/.m2`.

- `gen_cases.py`: writes the case files.
- `go/`: PBS-Go's `encoding/json`, `jsonutil` and `jsonparser`, against the local prebid-server.
- `java/Surrogates.java`: Jackson, with PBS-Java's String-first decoding.
- `node/surrogates.mjs`: V8 `JSON`, `TextDecoder` and `TextEncoder`.
- `rust/`: serde_json.
- `rt/`: the prototype runtime.
- `typed/`: the typed guest helpers.
- `cost/`: the boundary cost measurement.
