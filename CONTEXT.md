# Prebid Core

Exploring whether bidder adapters can be written once and run in every Prebid host, instead of being re-implemented per codebase.

## Language

**Host**:
A codebase that runs auctions and calls bidder adapters. The four in scope: Prebid.js, PBS-Go, PBS-Java, Trusted Server.
_Avoid_: platform, runtime, service

**Adapter**:
The code that translates between a Host's auction and one bidder's API: validating params, building outgoing requests, interpreting bid responses.
_Avoid_: bidder (that's the demand partner itself), integration, connector

**Hand-written Adapter**:
An Adapter implemented natively inside one Host's codebase, as all Adapters are today.

**Shared Adapter**:
An Adapter authored, tested and reviewed in one place and run by every Host without hand-porting.

**Prebid Core**:
Whatever lets a Host run Shared Adapters: a library, an interpreter, generated code, or a mix. Its form is an open question.
_Avoid_: Prebid library (presumes the form)

**Implementation**:
A separately maintained copy of Prebid Core logic in one language. The goal is as few Implementations as possible — ideally one, but e.g. TypeScript for Prebid.js plus WASM for the server Hosts is acceptable. Never default to one per Host.

**Proof of Concept**:
Prebid Core plus one Shared Adapter (OpenX) running in all four Hosts, alongside their Hand-written Adapters.

## Relationships

- A **Host** runs many **Adapters**; during migration some are **Hand-written** and some **Shared**, side by side.
- A **Shared Adapter** runs on **Prebid Core**, which has one or more **Implementations**.

## Flagged ambiguities

- "Adapter" in Prebid.js also covers user syncs, event callbacks (`onBidWon`, `onTimeout`) and page side-effects. For now those are outside the **Adapter** as defined here.
