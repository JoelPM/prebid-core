# PROTOTYPE: Can a projected-input, edits-out ABI get generated Shared Adapters within ~+10 µs per call?

Throwaway prototype for [#24](https://github.com/JoelPM/prebid-core/issues/24) (map [#1](https://github.com/JoelPM/prebid-core/issues/1)). It builds on [`prototype/typed-backend`](https://github.com/JoelPM/prebid-core/blob/prototype/typed-backend/prototype/typed-backend/README.md) (#17): the same Definitions and the Level 1 typed back end, here with its per-call bump allocator. Only the Host↔guest ABI changes. Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md). Nothing here is meant to be merged.

## TL;DR

**Partly.**

- **Projection in pays when the Host projects its own structs.** Generated OpenX, the Proof of Concept's Adapter, drops to about half its overhead, well inside the gate.
- **Edits out does not pay with a JSON patcher.** MakeRequests should stay body-out.
- **PubMatic stays over the gate.** A static projection can't express its data-dependent `adm` read, and its Phase code is the costliest.

Overhead per call against the Hand-written PBS-Go Adapter (wazero, macOS arm64), with the same guest at every stage. The guest has to match the Hand-written Adapter's output before each payload is timed.

| ABI | OpenX `lt` | OpenX `heavy` | PubMatic `lt` | PubMatic `heavy` |
|---|---:|---:|---:|---:|
| stage 0: variant D (today's ABI) | +9.3 µs | +14.2 | +17.3 | +26.4 |
| **stage 1: bid response projected from the Host's structs** | **+5.3** (CPU +5.0 to +6.2 at 1–8 goroutines) | **+6.2** | +17.9 | +26.4 |
| stage 1, projected from the raw bytes instead | +9.9 | +18.2 | +21.8 | +37.8 |
| stage 2: + request projected, MakeRequests returns edits | +13.7 | +22.6 | +29.9 | +43.1 |
| *gate* | *~+10* | | | |

Raw output: [`results/bench-abi.txt`](results/bench-abi.txt) (full run, CPU at 1–8 goroutines) and [`results/bench-abi-rewrite-1goroutine.txt`](results/bench-abi-rewrite-1goroutine.txt). The full run measured the first, naive Go-side raw projector and edit patcher. The raw and stage 2 rows above are after their one-pass rewrites, single goroutine.

Correctness at every stage, both projection sources:

- **Parity:** 33/33 fixtures, with the same 3 pinned Known Differences, identical to the TS as written.
- **Differential fuzz through the real PBS-Go Host binding:** 77k fuzz cases (5,362 rejected by Go's own model) run at stage 0 and at stage N on the same guest. 0 differences for stage 1, stage 2, and stage 2 with raw projection. Stage 0 is itself fuzz-verified against the TS. A planted bug in the Go patcher shows up on 16,394 of 16,673 OpenX MakeRequests calls.

## What was built

```
transpiler/typed1.mjs   + SHAPES: per input document, the terminal paths the Phases read (the projection
                        contract); + make_requests_edits; whole-value marking (below); presence checks
runtime/rt2             + emit_edit (Phase output as edits), Out::IdxList / Out::Fill; Mem.kc (below)
guest-typed1/           + <bidder>_shapes and <bidder>_mre exports
hostgo/host/project.go  Projector: shapes compiled once per Adapter; Append (from the Host's structs,
                        by json tags, omitempty honoured) and AppendRaw (from the input bytes, one pass)
hostgo/host/edits.go    the edit language and a one-pass streaming patcher (with Extension fills)
hostgo/host/shared.go   ABI_STAGE=0|1|2, ABI_PROJ=raw
hostgo/cmd/abifuzz      differential fuzz of stage N against stage 0 through the Host binding
hostgo/cmd/projsize     projection sizes; cmd/abiprof: CPU profile of the Host side of a stage
```

### Projection in (stage 1)

- **The guest declares what its Phases read.** The Definition Compiler already derives each Phase's input paths (its shapes, #17). The guest exports them as a list of terminal paths per document (`*` any element, `%` any member).
- **The Host projects to those paths.** It compiles the list once per Adapter and, per call, writes only those fields as JSON. The guest's decoders are unchanged, since a projection is a document of the same shape with less in it.

| bid response | full | projected | |
|---|---:|---:|---|
| OpenX `lt` / `heavy` | 5,995 / 11,294 B | 461 / 471 B | 8% / 4% |
| PubMatic `lt` / `heavy` | 5,995 / 11,294 B | 4,517 / 6,871 B | 75% / 61% |

PubMatic keeps most of the response because its bid Phase reads `bid.adm` (native bids only, to re-serialize the markup). A static projection can't know which bids are native, so every `adm` goes in.

**Rules the compiler had to add for projection to stay correct:**

1. **Whole values.** Wherever generated code uses a view's *value* rather than reading fields of it, the node is marked whole and projected entirely. Examples are Level 0 fallbacks, `JSON.stringify`, and a plan materialized as a value. Without this, a fallback would silently see the projected subset.
2. **Presence checks use the projection.** `if (imp.banner)` and `x == null` are answered by the projected value, since a projected object is present exactly when the input's is. So truthiness doesn't force whole values.
3. **Empty objects.** A copied object whose projection is empty (`site` with only `publisher` read, in a request without one) must still count as recorded. Treating "no members" as "not recorded" made a nested plan fall back to a value and lose `site.id` (`pubmatic/supplemental/multiplemedia.json`). Hence `Mem.kc`.

**Projecting from the Host's structs vs. its bytes.** The struct projection sees the Host's model of the response, as a Hand-written Adapter on that Host does. `omitempty` zero values vanish (`"mtype": 0` becomes absent), and raw-JSON fields (`bid.ext`) go whole. Other Hosts' models will differ in such details, which weakens "the same bidder response yields the same bids in every Host". Projecting the raw bytes is exact and means the same thing on every Host. But on the bench payloads it costs about +4.6 µs (OpenX `lt`) over the struct projection, roughly what it saves the guest: scanning 6 KB in Go costs about what scanning it in wasm did.

### Edits out (stage 2)

The guest's MakeRequests takes the projected request and returns its plans as edits. The Host applies them to the body it marshals anyway, in one streaming pass. Extension patches go to the Host as add-only fills, because a fill must see members the projection doesn't carry (e.g. `regs.gdpr` beside the `regs.coppa` it adds).

```
["v", value]  replace      ["d"]  delete      ["p", {k: edit}, nonempty]  patch the object here
["l", [[i, edit], ...]]  the input's imps i, edited      ["f", value]  fill      ["s", [e1, e2]]  e1 then e2
```

It is correct (0 fuzz differences) but slower than stage 0. The Host still marshals the whole request, then must scan all of it to apply the edits. That costs more than the guest's span copy of untouched members saved. The first version, using the standard-library JSON decoder for edits, was far worse (+26.9 µs); half of that was parsing edits. **Edits would only pay if the Host applied them to its own structs**, which means per-Host, per-field code, the option rejected when this ticket was charted. So MakeRequests should stay body-out.

### String slots (stage 3, not built)

Escaped-JSON string slots (errors, bid type, seat, currency, kv strings) would let lone surrogates through the ABI. On PBS-Go that buys nothing: the Host's own JSON layer turns them into U+FFFD anyway. It is a contract decision for Hosts whose strings can hold them (PBS-Java, Prebid.js).

## What this leaves

- **The ABI to keep:** projection in, from the Host's structs, for MakeBids; body out for MakeRequests. Generated OpenX then sits at +5 µs per call, about half the gate.
- **A projection contract.** For "the same response yields the same bids in every Host", each Host's projector must keep the same things: zero values, absent vs. null, raw `ext` fields. Exact raw projection is the costlier alternative.
- **Data-dependent reads.** PubMatic's native-only `adm` needs either on-demand reads (the guest asks the Host for a field) or a cheaper guest. The host-call cost under wazero isn't measured.
- **PubMatic's guest itself.** Its Phase code is still Level 0 value code on top of the views; that is #25's typed-primitive work.

## Caveats

- One machine (macOS arm64, Go 1.27.2, wazero 1.12.0). Not rerun on x86-64 Linux.
- PBS-Go only. PBS-Java's and Trusted Server's projector costs are argued, not measured.
- Same payloads as #14, #16 and #17. They have no `app`, `imp.ext.data` or native bids, so the struct projector's handling of those is covered by fixtures and the fuzz, not timed.
- The Go projector uses reflection with cached per-type plans. A generated projector would be faster still; it wasn't needed for OpenX.
