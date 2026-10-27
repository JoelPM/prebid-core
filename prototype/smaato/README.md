# PROTOTYPE: Can Restricted TypeScript express Smaato's split requests and header-driven bids?

Throwaway prototype for [#20](https://github.com/JoelPM/prebid-core/issues/20) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It starts from [`prototype/ts-transpiler`](https://github.com/JoelPM/prebid-core/blob/prototype/ts-transpiler/prototype/ts-transpiler/README.md) (#15): the same front end, the generic Rust back end and runtime, the parity harness, the fuzz and the Prebid.js measurement. Server overhead is out of scope here (see #17 and #24). Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

**Yes.** Smaato is written once in Restricted TypeScript ([`adapters/smaato.ts`](adapters/smaato.ts), about 160 lines; its PBS-Go Hand-written Adapter is 615). It reaches parity on all 41 PBS-Go fixtures through the TS as written and through the transpiled Rust/wasm. It needed four additions to the Phase model and four small additions to the subset. OpenX and PubMatic are unchanged and still at parity, and the size and semantics bars from #15 still hold.

| Bar (from #15) | Result |
|---|---|
| `adapterstest` parity, TS as written **and** Rust/wasm, vs fixtures and the Hand-written Adapter's full output | ✅ Smaato 41/41, 2 via Known Differences; with OpenX and PubMatic **74/74** for both, and TS = Rust on every fixture |
| PBS-Go's own `adapterstest` on the wasm guest | 69 pass, exactly the 5 Known Difference fixtures fail (3 PubMatic, 2 Smaato) |
| TS vs Rust, differential fuzz | ✅ 0 differences in 111,475 calls, 34,914 of them Smaato (8,926 outgoing requests, 3,195 rejected responses); a planted `formEncode` bug shows on 12 calls |
| Prebid.js runtime ≤ 3 KB gz (real `gulp build`) | ✅ **1,430 B** (was 1,103: groups, Host context, `http`, `formEncode`) |
| OpenX ≤ Hand-written +25% | ✅ 92%, unchanged |
| Smaato Shared module | 1,494 B gz, 71% of its Prebid.js Hand-written Adapter (not like for like: the browser contract differs) |
| Every TS/Rust difference pinned or rejected | ✅ 38/38 subset cases, including the new rules |

## What changed in the Phase model

These are the decisions taken with the user at the start, each now in `core/index.ts` and in the generated Rust driver.

1. **Several outgoing requests.**
   - The **imp Phase may return an array** of imps; Smaato uses it to split an imp by media type.
   - A new optional **`group(imp, p, host)` Phase** returns a key. Imps with the same key go in one request, in first-seen order. Smaato keys by imp and media type, or on the video endpoint by pod (the id prefix before `_`).
   - The **request Phase runs once per group**, with that group's imps and params, and may now `reject`, which drops that request.
   - Without `group`, everything goes in one request, as before.
2. **Host context.** Phases get a read-only `host`:
   - `entryPoint`: `'auction' | 'video' | 'amp'`;
   - `now()`: milliseconds, by the Host's clock;
   - `convertCurrency(amount, from, to)`: the Host's currency service, undefined without a rate.

   In the wasm guest, `now()` and `convertCurrency` are the **first host imports** (`prebid.now_ms`, `prebid.convert_currency`), answered from per-call state the PBS-Go binding passes in the call's context.
3. **Response metadata.** The bid and response Phases get `http`: `status`, and `header(name)` (case-insensitive). The Host passes the status and first header values.
4. **The response Phase runs first and may `reject`,** which drops every bid with one error. Smaato rejects a response without `X-Smt-Adtype`. On PBS-Go it is the same as a Hand-written MakeBids returning nil (no `BidderResponse`, so no currency).

## What changed in the subset

All are in [`SUBSET.md`](SUBSET.md)'s spirit: precise semantics in both TS and Rust, or rejected.

- **`formEncode(s)`**, a Prebid Core helper. It is form-urlencoding exactly as Go's `url.QueryEscape` does it: every UTF-8 byte except `A-Z a-z 0-9 - _ . ~` becomes `%XX`, and a space becomes `+`. JS's `encodeURIComponent` stays out, since it differs.
- **Calls on `host` and `http`.** Only the listed members; anything else is a type error.
- **A callback index**, as in `map((imp, i) => ...)`, which Smaato's pod sequence numbers need. JS's semantics are pinned in Rust: a counter per loop.
- **Module-level scalar constants** (`const CLIENT = 'prebid_server_1.3'`).

## Writing Smaato surfaced

- **The Host's model of a bid is the bid.** Smaato's mock responses carry a non-OpenRTB `bidderName` member, which PBS-Go's `openrtb2.Bid` drops on parse. Its typed `exp: 0` is dropped by `omitempty`. Both are #26's rules: the bids are the Host's parsed bids, and an optional typed zero reads as absent. The TS harness now models PBS-Go's bid that way.
- **A frame ambiguity in the ABI.** It couldn't tell "no video annotation" from "a video annotation with no defined members". OpenX and PubMatic always return one, Smaato only for video bids. Fixed: an empty object frames as a zero count, absence as an empty slot.
- **Errors that end a whole MakeRequests become per-request rejects.** In Go, a bad `user.ext` or a missing currency rate stops MakeRequests with one error. The Definition rejects each request instead, which matches on every fixture (all single-imp). Multi-imp requests would repeat the error once per request; that's a possible Known Difference, unpinned.
- **Status handling stays in the Host for now.** The Host answers non-200 statuses (the open fog item "who handles HTTP status codes"). Smaato's own message ends in `.`, pinned as a drift Known Difference. Now that Phases get `http.status`, the response Phase is a natural home for it.
- **The zero-imp error can't be expressed,** because no Phase runs without an imp. PBS's exchange never calls a bidder with no imps, so this is pinned as a Host-gap Known Difference.
- **Missing params:** one fixture sends an imp with no `imp.ext.bidder`. The Definition reads `p?.adspaceId` defensively, to match the Hand-written error. Under #19, Prebid Core validates params before the imp Phase, and what it does then is #21's open question.

## What was built

```
adapters/smaato.ts (+ params)   the Definition
core/index.ts, core/ortb.ts      driver: arrays from imp, group, per-group request + reject, host, http,
                                 response first + reject, formEncode; ORTB types for user/dooh/site.keywords
transpiler/transpile.mjs         new Phase positions and rejects, group, host/http calls, callback index,
                                 module scalar consts; driver groups imps into requests
runtime/rs (js.rs)               form_encode, header, convert_currency/host_now (wasm imports; settable natively)
guest/                           ABI: mr(ctx, req) -> requests; mb(ctx, req, resp, http) -> bids + rejected
hostgo/host                      host module "prebid"; ExtraRequestInfo/entry point/clock; several RequestData
hostgo/cmd/golden, sharedout     Smaato with adapterstest's context (rates, entry point) and smaato_test's clock
harness/                         parity: several requests, headers, host; fuzz: Smaato seeds/mutators, host/http
pbjs/                            glue: several ServerRequests, headers, currency module; Smaato installed
```

## Caveats

- PBS-Go fixtures only; Smaato in Prebid.js was built and type-checked, not run. Its browser Adapter has its own contract.
- One machine (macOS arm64).
- `host.convertCurrency` in Prebid.js uses the currency module when installed, and is otherwise undefined.
- The clock and rates in the harness are the fixtures' own. Production behaviour of `now()` under pooling (one value per call) wasn't examined.
