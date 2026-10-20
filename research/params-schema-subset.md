# Which params-schema features mean the same in every validator?

Research for [#22](https://github.com/JoelPM/prebid-core/issues/22) (map: [#1](https://github.com/JoelPM/prebid-core/issues/1)). It builds on [#19](https://github.com/JoelPM/prebid-core/issues/19) and its findings ([`research/params-validation.md`](https://github.com/JoelPM/prebid-core/blob/research/params-validation/research/params-validation.md)). Vocabulary is from [`CONTEXT.md`](../CONTEXT.md). Numbers follow [ADR 0001](../docs/adr/0001-shared-adapter-output-is-json-equal.md): they compare by exact decimal value.

## Answer

**A small draft-04 subset means the same everywhere, but only if the Definition Compiler fixes four meanings itself and doesn't rely on any engine's defaults.** The four are: the regex dialect, `integer`, numeric bounds, and string length. On their defaults the four validators disagree on the catalogue's own schemas:

- Java's `$` matches before a trailing newline. On OpenX, PBS-Java accepts `unit: "123\n"` and PBS-Go rejects it.
- Rust's `\d` matches Arabic-Indic digits, so `^\d+$` accepts `"١٢٣"`.
- `.` handles `\r` and U+2028 one way in Go and Rust and another way in JS and Java.
- Go rejects an upper-case UUID and Java accepts it.
- Java reads `integer` by its spelling (it rejects `5.0`). Go reads it by value (it accepts `5.0`).
- Go compares numbers exactly. Java compares them as f64, so on OpenX's real schema `customFloor: -1e-400` fails in Go and passes in Java.

Every catalogue schema but two Go files fits the subset: 277/279 Go files and 268/271 Java files (the 3 Java misses are 1 nested-quantifier pattern and 2 malformed files). **OpenX and PubMatic are both inside.** Defining pattern meaning as ECMA-262 with the `u` flag, as JSON Schema specifies, and translating each pattern per engine removes every regex disagreement: 36 in-subset patterns × 3,087 strings, **0 disagreements** across V8, Rust `regex`, Go RE2 (through gojsonschema) and `java.util.regex` (through networknt).

### The params-schema subset

| feature | verdict | rule / reason | catalogue use (Go files) |
|---|---|---|---|
| `$schema` | allowed with rule | exactly `http://json-schema.org/draft-04/schema#` (or absent). Under it both PBS validators ignore later-draft keywords (§5) | 278 draft-04; `ogury` is 2020-12; Java `eplanning` spells it `https://` |
| `title`, `description` | allowed | annotations | all |
| `type`, single or union | allowed | the 7 JSON types; a union is "any of" | 279; 22 use unions |
| `integer` | allowed with rule | **an exact decimal value with zero fraction, within ±(2^53−1)**, so `5.0`, `5e0` and `-0` are integers. TS: `Number.isSafeInteger(v)`. Rust: on the decimal text, never via f64 | 50 |
| `properties`, `required` (nested too) | allowed with rule | a key is present if it exists, even with value `null`. A JS `undefined` value counts as absent (it has no JSON form). Don't generate `!= null` | 270 top-level, 53 nested |
| `additionalProperties` (bool or schema) | allowed | Go and Java agree; TS must test own keys only (so `__proto__` is just a key) | 8 |
| `items` (one schema), `minItems`, `maxItems` | allowed | | 21 / 8 / 3 |
| `minLength`, `maxLength` | allowed with rule | **count Unicode code points**: `[...s].length` in TS, never `.length`; `chars().count()` in Rust. Go (`RuneCount`) and Java (`codePointCount`) already do | 135 / 3 |
| `minimum`, `maximum` | allowed with rule | compare exact decimal value. **Bounds have at most 15 significant digits.** Then TS's plain f64 `<=` gives the same verdict as the exact comparison of the JS value's shortest decimal (checked: 0 of 400k cases differ at ≤15 digits, 929 of 100k at 16) | 24 / 2 |
| `enum` | allowed with rule | strings, booleans and `null` only. Numbers are rejected: Go compares them as float64, so `enum:[9007199254740993]` accepts `9007199254740992` | 13 (all strings) |
| `pattern` | allowed with rule | ECMA-262 meaning with `u`, unanchored, in the regex subset below; the compiler translates per engine | 25 |
| `format: uuid` | allowed with rule | 8-4-4-4-12 hex digits, **case-insensitive**, no braces or `urn:`; the nil UUID and any version/variant are OK. Emitted as a `pattern` in generated Host copies | 4 |
| `format: hostname` | allowed with rule | RFC 1123: labels of 1–63 `[A-Za-z0-9-]`, no leading/trailing `-`, dot-separated, **at most 253 characters**, no trailing dot, ASCII only (IDNs as `xn--` A-labels, not checked further), case-insensitive, all-numeric allowed | 2 (OpenX `delDomain`, limelightDigital) |
| `anyOf`, `allOf` | allowed | Go and Java agree | 13 / 1 |
| `oneOf` | allowed with rule | **exactly one** branch valid. Go and Java agree; the generator must count, not short-circuit like `anyOf` | 39 |
| `not` | allowed | agree (#19 proposed rejecting it; the evidence shows no difference) | 2 |
| `dependencies` (array and schema forms) | allowed | agree | 2 |
| other `format`s (`email`, `uri`, `date-time`, …) | rejected | unused; per-library rules | 0 |
| `const` | rejected | draft-06; both PBS validators ignore it under draft-04, so a generated check would be stricter than the Hosts. Use a one-value `enum` | 0 |
| `exclusiveMinimum` / `exclusiveMaximum` | rejected | draft-04's boolean form vs draft-06's number form. The number form is a schema-load error in gojsonschema and silently ignored by networknt | 0 |
| `multipleOf` | rejected | a decimal divisor is inexact in f64 (TS) | 0 |
| `if` / `then` / `else` | rejected | draft-07; ignored under draft-04. Write it as `anyOf`/`not` | 1 (`ogury`, 2020-12) |
| `$ref`, `definitions`, `id` | rejected | unused; reference resolution differs | 0 |
| `default` | rejected | no validator applies it; defaults belong in the imp Phase | 0 |
| tuple `items`, `additionalItems`, `uniqueItems`, `patternProperties`, `min/maxProperties`, `contains`, `propertyNames` | rejected | unused; add one only when an Adapter needs it, with a differential test | 0 |
| unknown keywords | rejected | validators ignore them silently (Java `pangle` has two property schemas sitting at the root) | Java 1 |

### The regex subset (`pattern`)

**Meaning:** ECMA-262 with the `u` flag, unanchored. Draft-04 says patterns "SHOULD be valid according to the ECMA 262 regular expression dialect" and are "not implicitly anchored" (draft-04 Validation §3.3, §5.2.3). The TS validator runs `new RegExp(p, "u").test(s)` on the pattern as written. The Definition Compiler parses the pattern (prototype: [`subset.mjs`](params-schema-subset/subset.mjs)) and emits its exact equivalent for each other engine:

| construct | allowed? | emitted for Rust / Go / Java |
|---|---|---|
| printable ASCII literals; `\` + one of ``^$\.*+?()[]{}\|/-`` | ✅ | same |
| `[…]`, `[^…]` with ASCII members, ranges, escapes | ✅ | same; `[` inside a class, `&&` / `--` / `~~` (Rust and Java set operations) and a leading `]` are rejected |
| `( … )`, `(?: … )`, `\|` | ✅ | groups become `(?:…)` |
| `* + ? {n} {n,} {n,m}`, n, m ≤ 1000 | ✅ | same (1000 is Go RE2's limit) |
| `^`, `$` | ✅ | Java: `\A`, `\z` (Java's `$` also matches before a final `\n`, `\r\n`, `\r`, U+0085, U+2028 and U+2029) |
| `\d` `\w` / `\D` `\W` | ✅ with rule | `[0-9]`, `[0-9A-Za-z_]` and their negations. Rust's are Unicode by default |
| `\s` `\S` | ✅ with rule | ECMA's exact list (`\t\n\v\f\r`, space, U+00A0, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). All four engines differ by default |
| `.` | ✅ with rule | `[^\n\r  ]`. By default Go and Rust exclude only `\n`, and Java also excludes U+0085 |
| `\t \n \v \f \r` | ✅ with rule | code-point escapes (Java's `\v` is a class of vertical whitespace) |
| a quantified group containing a quantifier (`(a+)+`, feedad's `^(([a-z0-9])+[-_]?)+$`) | ❌ | exponential in V8: 445 ms at 26 chars, ×4 every 2 chars, on the Prebid.js main thread. Rewrite with fixed-length alternatives: `^([a-z0-9]\|[a-z0-9][-_])+$` accepts the same language (checked exhaustively to length 7) in 0.5 ms at 100k chars |
| lazy / possessive quantifiers, lookaround, backreferences, named groups, inline flags `(?i)`, `\b`, `\p{…}`, `\x`, `\u`, `\c`, `\A \z \Z`, `\Q…\E`, POSIX `[[:digit:]]`, non-ASCII literals | ❌ | each is missing from or means something else in at least one engine (§1) |

### Catalogue schemas outside the subset

From [`check-catalogue.mjs`](params-schema-subset/check-catalogue.mjs):

- **PBS-Go (2 of 279):**
  - `feedad`: nested-quantifier pattern.
  - `ogury`: 2020-12 `$schema` with `allOf` of `if`/`then`.
- **PBS-Java (3 of 271):**
  - `feedad`: same pattern.
  - `pangle`: `appid` and `placementid` sit at the schema root.
  - `eplanning`: `https://` draft-04 `$schema`, a spelling issue only.
- **OpenX: inside, in both copies.**
  - Rules it relies on: `hostname`, `uuid`, unions with `pattern` + `minimum`, top-level `anyOf` of `required`.
  - Its own patterns need no translation, except `$` for Java.
- **PubMatic: inside, in both copies.**
  - Rules it relies on: `integer`, nested `required`, `minItems` on arrays of objects.
- Inside only with a translation rule (`\d`, `.`, `\S`): adf, admixer, dianomi, limelightDigital, pangle, rubicon/magnite, targetVideo, theadx, visx, yandex.

Some patterns are in the subset but look wrong, and they mean the same everywhere anyway:

- `gross|net` (adf, dianomi) and `[0-9]+` (pangle) are unanchored, so they accept `"grossnet"` and `"x1"`.
- bluesea's `[0-9|a-z|A-Z]{16}` treats `|` as a literal.
- yandex's `(\S+-)?` changes nothing, because the pattern is unanchored.

## 1. `pattern`

### How each validator runs a pattern

| validator | call | source |
|---|---|---|
| PBS-Go, gojsonschema v1.2.0 | `regexp.Compile(p)` at schema load, `MatchString(s)` (search, unanchored) | `schema.go:655`, `validation.go:738` |
| PBS-Java, networknt 1.5.6 | default `JDKRegularExpressionFactory`: `Pattern.compile(p).matcher(s).find()`, no flags | `SchemaValidatorsConfig.java:153`, `regex/JDKRegularExpression.java:20` |
| generated TS (proposed) | `new RegExp(p, "u").test(s)` | — |
| generated Rust (proposed) | `regex::Regex::new(p)?.is_match(s)` (regex 1.11.1, Unicode on by default) | — |

PBS-Java ships on Corretto 25 (`Dockerfile:1`). These tests ran on JDK 27, but the `java.util.regex` behaviors used here (`$`, `.`, `\s`, `\v`, `(?i)`) have been documented in `Pattern` since Java 8.

### Raw differential: catalogue and probe patterns

[`gen-cases.mjs`](params-schema-subset/gen-cases.mjs) builds the input set:

- the catalogue's 23 distinct patterns (Go and Java);
- 45 feature probes;
- 87 hand-picked adversarial strings (trailing `\n`/`\r`, Unicode digits and spaces, U+2028, U+0085, emoji, Kelvin sign, long-s, …);
- 3,000 seeded random strings over a hostile alphabet.

Each engine runs as its validator calls it ([`js.mjs`](params-schema-subset/js.mjs), [`rust/src/main.rs`](params-schema-subset/rust/src/main.rs), [`go/main.go`](params-schema-subset/go/main.go), [`Java.java`](params-schema-subset/Java.java)). Go and Java go through the real validator, with `{"type":"string","pattern":p}` and the string passed as JSON text.

**Catalogue patterns, as written:** 18 of the 23 disagree somewhere.

- 15 of them disagree only because of Java's `$`. Example: `^[0-9]+$` accepts `"123\n"`, `"123\r"` and `"123\r\n"` in Java only.
- Four differ between JS and Rust:
  - `^\d+$`: Rust accepts `"١٢٣"` and `"１２３"`.
  - `^.+\..+$` (limelightDigital `host`): JS and Java reject `"a\r.b"` and `"a .b"`, Go and Rust accept them; Java alone rejects `"a\u0085.b"`.
  - `.+` (pangle `token`): `"\r"` passes in Go and Rust, fails in JS and Java.
  - yandex's `(\S+-)?\d+-\d+`: Rust's Unicode `\d`.
- JS and Go differ on the two `.` patterns.

**Feature probes** (same harness):

| probe | divergence |
|---|---|
| `^\s$` | U+00A0, U+2003: JS ✅ Rust ✅ Go ❌ Java ❌. U+000B: Go ❌ only. U+FEFF: JS ✅ only |
| `^\w+$` | `é`, `Ä`, `ſ`, `K` (Kelvin): Rust ✅ only |
| `\bfoo\b` | `"éfoo"`: Rust ❌ (Unicode word boundary), others ✅ |
| `(?i)^k$` | JS: syntax error. Kelvin sign: Go and Rust ✅ (Unicode folding), Java ❌ (ASCII-only without `UNICODE_CASE`) |
| `^[[:digit:]]+$` | JS: syntax error. Go/Rust: POSIX class. Java: a literal set of `[:digt]`, so it rejects `"123"` |
| `[a-z&&[^b]]` | JS: syntax error. Java and Rust: intersection. Go: literal `&`, `[`, `^`, `b` |
| `^\v$` | Java: `\v` is vertical whitespace, so it also matches `\n`, `\r`, `\f` |
| `^$` | Java matches `"\n"` and `"\r"` |
| `a(?=b)`, `(?<!a)b`, `(a)\1` | Go and Rust: syntax error |
| `^a*+$` (possessive) | JS and Go: syntax error. Java: possessive. Rust: `(a*)+`, which accepts `"\n"` differently from Java |
| `\A`, `\z` / `\Z`, `\h`, `\X`, `\R`, `\Q…\E`, `\cJ`, `A`, `\x{41}`, `(?P<n>)`, `a{,3}` | each is a syntax error in one to three engines |

[`out/js-u-vs-plain.txt`](params-schema-subset/compare.mjs) shows why the `u` flag is required. Without it:

- `^.$` doesn't match an emoji, and `^.{2}$` does;
- `\p{L}` is a literal `p{L}`;
- `\_`, `\A` and `\z` are silent identity escapes that match the letters `_`, `A` and `z`.

### Proposed subset, checked

[`subset.mjs`](params-schema-subset/subset.mjs) classifies each pattern:

| verdict | count | patterns |
|---|---|---|
| safe | 17 catalogue patterns | |
| inside with a rule | 5 catalogue patterns | `^\d+$`, `\d` in a class (admixer), `.` ×2, `\S`+`\d` (yandex) |
| rejected | 1 catalogue pattern | feedad |
| rejected | 31 of the 45 probes | |

For each pattern it emits a Rust, Go and Java translation. [`compare-translated.mjs`](params-schema-subset/compare-translated.mjs) runs every engine on its own translation of all 36 in-subset patterns (catalogue and probes) over all 3,087 strings. **0 disagreements** with ECMA-262. The same translation also brings the PBS copies into agreement once they're generated, including Java's `$`.

### ReDoS

[`redos.mjs`](params-schema-subset/redos.mjs) times feedad's `^(([a-z0-9])+[-_]?)+$` on `"a"×n + "!"`:

| n | 16 | 20 | 22 | 24 | 26 |
|---|---|---|---|---|---|
| V8 (Prebid.js) | 6 ms | 7 ms | 29 ms | 119 ms | 465 ms |
| java.util.regex ([`Redos.java`](params-schema-subset/Redos.java)) | ≤ 0.2 ms | | | | |

- At 30 characters V8 would take seconds. That's a publisher-supplied param freezing the page.
- Java's engine avoids the blow-up on this pattern.
- Go RE2 and Rust `regex` guarantee linear time.
- Rejecting a quantified group that contains a quantifier is a simple syntactic rule. In the catalogue it rejects only feedad.

## 2. `format`

Source:

- gojsonschema: `format_checkers.go:133` (hostname), `:138` (uuid), `:316-334`.
- networknt: `Formats.java:57` (hostname), `:63` (uuid); `format/PatternFormat.java:71` (`matches()`, whole string).

Both enforce formats by default; see #19 for the PBS-Go and PBS-Java wiring. Reproduced in [`out/values.md`](params-schema-subset/values-print.mjs) by [`go/values`](params-schema-subset/go/values/main.go) and [`JavaValues.java`](params-schema-subset/JavaValues.java):

| input | PBS-Go | PBS-Java | proposed |
|---|---|---|---|
| `8db4a3b2-3d24-4f71-9c34-6a5b6c3d2e10` | ✅ | ✅ | ✅ |
| same, **upper-case** | ❌ (`^[a-f0-9]{8}-…$`) | ✅ (`\p{XDigit}`) | ✅ (RFC 9562 §4: hex digits are case-insensitive on input) |
| mixed case `…-3D24-…` | ❌ | ✅ | ✅ |
| braces `{…}`, `urn:uuid:…`, no hyphens, trailing `\n`, 37 chars, `g`, full-width digit | ❌ | ❌ | ❌ |
| nil UUID; version 0, variant 1 (`…-0f71-1c34-…`) | ✅ | ✅ | ✅ (no version/variant check) |
| hostname `A.OPENX.NET`, `localhost`, `123`, `1.2.3.4`, `xn--bcher-kva.com`, label of 63 | ✅ | ✅ | ✅ |
| trailing dot `a.openx.net.`, `-a.com`, `a-.com`, `a_b.com`, `a..b`, `""`, `bücher.com`, label of 64, trailing `\n` | ❌ | ❌ | ❌ |
| hostname of 254 or 255 chars | ✅ (`len < 256`) | ✅ | ❌ (253: RFC 1035's 255-octet wire limit as text) |
| hostname of 256 or 300 chars | ❌ | ✅ (no length limit) | ❌ |

Neither format checker trips on Java's `$` quirk, because `PatternFormat` uses `matches()`. But OpenX's `delDomain` pairs `format: hostname` with `pattern: \.[a-zA-Z]{2,3}$`, and that pattern does accept a trailing newline in Java. `uuid` isn't a draft-04 format at all (it was added in 2019-09), so its meaning is whatever each library chose.

## 3. `integer` and numbers

How the validators decide (sources):

- **gojsonschema** decodes with `UseNumber` (`jsonLoader.go:377`). Its integer test is `big.Rat.SetString(n).IsInt()` (`utils.go:117-125`), and `minimum`/`maximum`/`multipleOf` use `big.Rat` (`validation.go:777-839`). It is exact, by value. `enum` and `uniqueItems` re-marshal through float64 (`utils.go:84-100`, `validation.go:427-431`).
- **networknt** asks Jackson. A literal with `.` or an exponent becomes a `DoubleNode`, which counts as `number`, not `integer`. Its `5.0`-is-an-integer path is gated on draft-06+ (`TypeFactory.java:92-100`, `utils/JsonNodeUtil.java:82`). Bounds compare `new BigDecimal(node.asText())` (`MinimumValidator.java:106`), where `node` is a double, because PBS-Java's mapper doesn't enable `USE_BIG_DECIMAL_FOR_FLOATS` (`json/ObjectMapperProvider.java`).
- Draft-04 itself defines `integer` as "a JSON number without a fraction or exponent part" (Core §3.5). Draft-06 changed that to "zero fractional part". So **Java follows draft-04 to the letter and Go follows draft-06**. A Prebid.js validator only ever sees a JS number, so it can't tell `5.0` from `5`.

Through the real validators:

| schema | input | PBS-Go | PBS-Java | JS sees | serde_json (default) sees |
|---|---|---|---|---|---|
| `integer` | `5.0`, `5e0`, `5E+0`, `50e-1`, `-0.0` | ✅ | ❌ | `5` / `-0`, `isInteger` true | f64, `as_i64` None |
| `integer` | `-0` | ✅ | ✅ | `-0` | f64 `-0.0`, `as_i64` None |
| `integer` | `1e400` | ✅ | ❌ (`Infinity`) | `Infinity` | **parse error** |
| `integer` | `9007199254740993` | ✅ | ✅ | `9007199254740992` | i64 exact |
| `integer` | `18446744073709551616` (2^64) | ✅ | ✅ | rounded | f64 rounded |
| `integer` | `1e-400` | ❌ | ❌ | `0`, an integer | f64 `0.0` |
| `number, minimum 0` | `-1e-400` | ❌ | ✅ (−0.0) | `-0` | f64 `-0.0` |
| `number, maximum 0.3` | `0.30000000000000001`, `0.3000000000000000000001` | ❌ | ✅ (rounds to 0.3) | `0.3` | `0.3` |
| `maximum 1, exclusiveMaximum true` | `0.99999999999999999999` | ✅ | ❌ (rounds to 1.0) | `1` | `1.0` |
| `enum [1]` | `1.0`, `1e0`, `1.0000000000000001` | ✅ | ✅ | `1` | `1.0` |
| `enum [9007199254740993]` | `9007199254740992` | **✅** (float64) | ❌ | — | — |
| `multipleOf 0.01` | `1e400` | ✅ | exception `Infinite or NaN` | `Infinity` | parse error |
| **OpenX** (each Host's own file) | `customFloor: -1e-400` | ❌ | ✅ | | |
| **PubMatic** (each Host's own file) | `wrapper.profile: 5.0` / `5e0` | ✅ | ❌ | | |

**Proposed rule, matching ADR 0001:**

- **Value is the exact decimal.** `integer` means zero fraction and |v| ≤ 2^53−1.
  - The bound makes TS and Rust agree. A JS number at or above 2^53 has already lost precision, and `Number.isSafeInteger` rejects it. Rust rejects the same decimal text.
  - It is stricter than both PBS Hosts, which take any size. Those inputs make a Host-gap Known Difference, and nothing in the catalogue needs them.
- **Bounds have at most 15 significant digits.** Then TS's `v <= b` equals the exact comparison of b with v's shortest decimal, which is what a server Host would hand Rust. [`bounds.mjs`](params-schema-subset/bounds.mjs) found 0 disagreements in 400k checks at 1–15 digits, 929 at 16 and 8,305 at 17.
- **Rust compares decimal text exactly.** It must not decode params through serde_json's default f64. `1e400` fails the whole parse there, and `0.30000000000000001` becomes 0.3.
- Where a server Host's text has more precision than any f64, the TS-vs-Rust harness feeds Rust the shortest decimal of the f64 that TS sees, as ADR 0001 already requires for outputs.

## 4. `minLength` / `maxLength`

Draft-04 counts characters as RFC 4627 does (Validation §5.2.1), so code points.

- gojsonschema counts `utf8.RuneCount` (`validation.go:716`, `:726`).
- networknt counts `String.codePointCount` (`MinLengthValidator.java:51`, `MaxLengthValidator.java:51`).
- They agree on every case tried:

| string | code points | PBS-Go and PBS-Java | JS `.length` | Rust `chars().count()` |
|---|---|---|---|---|
| 😀 | 1 | `minLength 2` ❌, `maxLength 1` ✅ | **2** | 1 |
| `e` + U+0301 | 2 | `minLength 2` ✅, `maxLength 1` ❌ | 2 | 2 |
| `é` (U+00E9) | 1 | `minLength 2` ❌ | 1 | 1 |
| lone `\ud800` | 1 | `minLength 2` ❌ (Go decodes it to U+FFFD, Java keeps the surrogate) | 1 | **serde_json refuses the JSON** |

So the generated TS must count `[...s].length`, not `.length`. Lone surrogates are a JSON-decoding question, not a schema one (see Open questions). Grapheme clusters are never counted by anyone.

## 5. Composition and structure

Through the real validators ([`out/values.md`](params-schema-subset/values-print.mjs)), Go and Java agree on all of these:

- `oneOf`: exactly one branch valid, so `{a,b}` against `oneOf[{required:[a]},{required:[b]}]` is ❌ in both.
- `anyOf`, nested `required`.
- `required` with a `null` value counts as present.
- `additionalProperties: false`, including `__proto__` as a key.
- `type` unions, apart from the `5.0` integer reading.
- `not`, `dependencies` (array form), `items` + `minItems`.
- Duplicate keys: the last one wins in Go, Jackson, `JSON.parse` and `serde_json::Value`.
- `default`, which neither applies.

The draft-version traps:

| keyword under draft-04 `$schema` | PBS-Go | PBS-Java |
|---|---|---|
| `const: "x"` on `"y"` | ✅ ignored | ✅ ignored |
| `exclusiveMinimum: 5` (number form) | **schema load error** (it wants a boolean; `schema.go:477-507`) | ignored |
| `if`/`then` | ignored | ignored |
| `ogury.json`'s shape under its 2020-12 `$schema` | enforced (hybrid mode) | enforced (networknt reads `$schema` despite the V4 default); PBS-Java has no `ogury.json` |

Catalogue counts, from [`catalogue.py`](params-schema-subset/catalogue.py), Go / Java:

| keyword | Go | Java |
|---|---|---|
| `required` | 270 | 258 |
| `minLength` | 135 | 120 |
| `type: integer` | 50 | 47 |
| `oneOf` (81 branches, all `required`-only except 4 nested `oneOf` and 2 type branches) | 39 | 37 |
| `pattern` | 25 | 17 |
| `minimum` | 24 | 24 |
| type unions | 22 | 22 |
| `items` (all single-schema) | 21 | 18 |
| `anyOf` | 13 | 12 |
| `enum` (strings only) | 13 | 11 |
| `additionalProperties` | 8 | 4 |
| `minItems` | 8 | 7 |
| `format` | 5 | 5 |
| `maxItems` | 3 | 3 |
| `maxLength` | 3 | 2 |
| `maximum` | 2 | 3 |
| `not` | 2 | 1 |
| `dependencies` | 2 | 2 |
| `allOf` / `if` / `then` (all in `ogury`) | 1 | 0 |

These are used nowhere: `$ref`, `definitions`, `default`, `const`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`, `patternProperties`, `uniqueItems`, `minProperties`/`maxProperties`, tuple `items`.

## Implications

### For the Definition Compiler's generated validators

- **The compiler owns the meaning; engines don't.**
  - It parses each params schema against the subset and rejects anything outside it, the same way Restricted TypeScript rejects code.
  - It translates `pattern` per engine, generates `uuid`/`hostname` as code (or as an equivalent `pattern`), and emits integer, bound and length checks with the rules above.
  - Plain `RegExp`, `.length`, `Number.isInteger` and serde_json f64 each produce a divergence reproduced here.
- **The TS validator is cheap.**
  - Everything in the subset is a short inline check plus `new RegExp(p, "u")`.
  - Nothing needs a validator library, which matters for the Prebid.js budget.
  - V8 backtracking is why nested quantifiers are rejected at compile time.
- **The Rust validator works on the JSON text's numbers.** For params it must use exact decimal (span or `arbitrary_precision`), not f64.
- **Generated PBS copies can stop the drift.** The compiler already becomes the source of the Go and Java schema copies (#19). Its translations would make the two Hosts' own checks agree with Prebid Core:
  - `$` → `\z` for Java;
  - explicit classes for `\d` and `.`;
  - `format` → `pattern` + `maxLength`.

  What remains is `integer` (`5.0`, Java) and f64 bounds (Java). Both are networknt behaviors that a schema can't change.

### For Parity and Known Differences

- While a Host's own check stays in front, each disagreement above is a **Host-gap Known Difference**, pinned by a fixture:
  - PBS-Go rejects upper-case UUIDs, hostnames over 255 characters, `9007199254740992` against a numeric enum, and `-1e-400` against `minimum 0`;
  - PBS-Java accepts trailing newlines through `$`, rejects `5.0`, accepts `-1e-400`, and has no hostname length limit.
- For OpenX, the reproducible ones are:
  - `unit: "123\n"` and `customFloor: "1.5\n"`: Java ✅, Go ❌;
  - upper-case `platform`: Java ✅, Go ❌;
  - `customFloor: -1e-400`: Java ✅, Go ❌;
  - a 254-character `delDomain`: both ✅, proposed ❌.
- For PubMatic: `wrapper.profile: 5.0`, Go ✅, Java ❌.
- Prebid.js can't hold precision beyond f64 (ADR 0001). The only new Known Difference this rule adds is integers beyond ±(2^53−1).
- The TS-vs-Rust fuzz should draw params from these adversarial sets: line terminators, Unicode digits and spaces, astral characters, `5.0`/`-0`/`1e-400`, and 16–17-digit decimals. It should also run the regex differential (`run.sh`) as a conformance test of the compiler's translations.

### Open questions

- **Lone surrogates.** Go's `encoding/json` turns `"\ud800"` into U+FFFD, Jackson and JS keep it, and serde_json refuses the whole document. If PBS-Java or Trusted Server hands Prebid Core JSON with a lone surrogate, does the Rust side fail the whole request?
- **The `integer` range.** Is ±(2^53−1) acceptable to bidders? PubMatic's Java Adapter decodes `profile` into `Integer` (32-bit), so Hand-written Adapters are already narrower. Should a Shared Adapter be able to declare a narrower integer width, for the Rust struct, as `minimum`/`maximum`?
- **Ogury and feedad** are the only Go schemas outside the subset. Each can be rewritten (ogury as `anyOf`/`not` pairs, feedad as the fixed-length-alternative pattern above). Is rejecting them acceptable while they stay Hand-written?

### Not covered

- `email`, `uri`, `date-time` and the other formats (unused in the catalogue).
- The `v` RegExp flag.
- Case-insensitive matching (JSON Schema has no flags, and inline flags are rejected).
- Regex compile or match cost in wasm.
- Prebid.js's s2s path, where params go verbatim to PBS (#19).
- How `oneOf` error messages differ (only verdicts were compared).
- The TS and Rust validators themselves: the "JS sees" and "serde_json sees" columns show what each would be handed, not a generated validator. Generating them is Definition Compiler work.

## Reproduce

Everything is in [`params-schema-subset/`](params-schema-subset/). `./run.sh` regenerates all inputs and results into `out/` (git-ignored). It needs:

- `node`, `go`, `cargo`, `java` and `python3`;
- `prebid-server` at `a916b19ef` and `prebid-server-java` at `a1f9ddb2f` checked out beside this repo;
- networknt 1.5.6, Jackson 2.18.6, slf4j and itu in `~/.m2`.

| file | what |
|---|---|
| `catalogue.py` | every keyword, pattern and format in both `bidder-params` trees |
| `gen-cases.mjs`, `gen-values.mjs` | the pattern and value matrices (`cases.json`, `values.json`) |
| `js.mjs`, `rust/`, `go/`, `Java.java` | the four regex engines as their validators call them |
| `compare.mjs` | per-pattern disagreements (`out/patterns.txt`) |
| `subset.mjs`, `compare-translated.mjs` | the subset parser/translator and its check (`out/subset.txt`, `out/translated.txt`) |
| `go/values`, `JavaValues.java`, `values-js.mjs`, `rust/src/bin/values.rs`, `values-print.mjs` | formats, numbers, lengths and combinators through the real PBS validators (`out/values.md`) |
| `redos.mjs`, `Redos.java` | backtracking cost |
| `bounds.mjs` | the 15-significant-digit bound rule |
| `check-catalogue.mjs` | the catalogue against the whole subset (`out/outside.txt`) |
