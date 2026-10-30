# Prebid Core

**Can Prebid bidder Adapters be written once and run in every Prebid Host?**

Today each bidder's Adapter is written by hand several times: in JavaScript for Prebid.js, in Go for Prebid Server (PBS-Go), and again in Java for PBS-Java. The copies drift apart, and the newer Trusted Server has no Adapters of its own. This repo explores whether a bidder could instead write one **Shared Adapter**, test and review it in one place, and have all four Hosts run it: Prebid.js, PBS-Go, PBS-Java and Trusted Server.

This is a personal exploration, not a Prebid.org project. The end product is a proposal for Prebid.org.

## Where the work lives

The effort is run as a map of open questions on this repo's issue tracker:

- **[The map: Can Prebid adapters be written once for all four Hosts?](https://github.com/JoelPM/prebid-core/issues/1)** gives the destination, the go/no-go criteria, a one-line summary of every decision so far, and what's still unclear.
- Each question is a child issue of the map. A closed issue's resolution comment holds the answer and links to its evidence.
- [Open questions](https://github.com/JoelPM/prebid-core/issues?q=is%3Aissue+is%3Aopen+-label%3Awayfinder%3Amap) are the ones still being worked.

**Destination:** a go/no-go decision on write-once Adapters, with the rationale. If the answer is go, it also includes a spec for a Proof of Concept: Prebid Core plus a Shared OpenX Adapter, running in all four Hosts alongside their Hand-written Adapters.

## The current approach, in brief

The decisions on the map led to this approach (the map has the reasoning and alternatives ruled out):

- A Shared Adapter is written in **Restricted TypeScript**: a subset of TypeScript whose meaning is pinned so it behaves the same everywhere it runs. It is written as a few small **Phase** functions: build each imp, build the request, read the response, and turn each bid into a Host bid.
- **Prebid.js** runs that TypeScript directly, with a small shared runtime.
- For the **server Hosts**, the **Definition Compiler** transpiles it to Rust. PBS-Go and PBS-Java load the Rust as WebAssembly, and Trusted Server compiles it in as a crate.
- Parity is checked against each Host's existing Adapter test fixtures, and the TypeScript and Rust are fuzzed against each other.

So far the approach has been tried on OpenX, PubMatic and Smaato, and it reached parity on all three. The open work is mostly about server CPU overhead and a few interface questions.

## What's in this repo

`main` holds only the durable parts:

- [`CONTEXT.md`](CONTEXT.md): the glossary. Issues, prototypes and this README use its terms (Host, Shared Adapter, Phase, Parity, Known Difference…).
- [`docs/adr/`](docs/adr/): architecture decision records.

Everything else is throwaway and lives on unmerged branches, each linked from the issue it answers:

- `prototype/<name>`: runnable prototypes, each with a README at `prototype/<name>/README.md`. The latest is [`prototype/smaato`](https://github.com/JoelPM/prebid-core/blob/prototype/smaato/prototype/smaato/README.md), which also builds the Prebid Core driver, the Definition Compiler, the parity harness and the fuzz.
- `research/<name>`: write-ups of research findings.
