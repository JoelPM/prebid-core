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

**Shared Adapter Core**:
The part of a **Shared Adapter** every **Host** runs: building requests from the OpenRTB request and turning the bidder's response into bids. The same bidder response always yields the same set of bids, in every Host.
_Avoid_: base adapter

**Client Extension**:
Optional additions a **Shared Adapter** applies only in browser **Hosts** (Prebid.js), on top of its **Shared Adapter Core**: extra request fields and params, a different endpoint, extra fields on bids, or dropping bids. It never creates bids, re-reads the raw response or changes the shape of requests. Written by the bidder as part of its Shared Adapter.
_Avoid_: client profile, client module, channel, mode

**Server Extension**:
The server-side counterpart of a **Client Extension**, applied in PBS-Go, PBS-Java and Trusted Server.
_Avoid_: server profile, server module

**Prebid Core**:
Whatever lets a Host run Shared Adapters: a library, an interpreter, generated code, or a mix. Its form is an open question.
_Avoid_: Prebid library (presumes the form)

**Implementation**:
A separately maintained copy of Prebid Core logic in one language. The goal is as few Implementations as possible — ideally one, but e.g. TypeScript for Prebid.js plus WASM for the server Hosts is acceptable. Never default to one per Host.

**Proof of Concept**:
Prebid Core plus one Shared Adapter (OpenX) running in all four Hosts, alongside their Hand-written Adapters.

**Adapter Definition**:
The declarative description of a **Shared Adapter** that a bidder writes: its **Shared Adapter Core** and any **Extensions**, expressed as field mappings and rules, with small expressions only where mappings can't say it.
_Avoid_: profile (collides with the avoided "client/server profile"), spec (Prebid.js's adapter object), manifest (the per-Adapter list of response fields a Host must parse)

**Definition Compiler**:
The part of **Prebid Core** that turns an **Adapter Definition** into the code each **Implementation** runs.

## Relationships

- A **Host** runs many **Adapters**; during migration some are **Hand-written** and some **Shared**, side by side.
- A **Shared Adapter** runs on **Prebid Core**, which has one or more **Implementations**.
- A **Shared Adapter** is one **Shared Adapter Core** plus at most one **Client Extension** and one **Server Extension**.
- A **Shared Adapter** is written as one **Adapter Definition**; the **Definition Compiler** produces what every **Host** runs from it.
- Each **Host** is either client (Prebid.js) or server (PBS-Go, PBS-Java, Trusted Server), fixed for that Host. Trusted Server is server: its call to the bidder is server-to-server.
- A bidder can use a **Shared Adapter** in some Hosts and a **Hand-written Adapter** in others, e.g. Shared on the servers but Hand-written in Prebid.js.

## Flagged ambiguities

- "Adapter" in Prebid.js also covers user syncs, event callbacks (`onBidWon`, `onTimeout`) and page side-effects. For now those are outside the **Adapter** as defined here.
- In Trusted Server, "adapter" means a platform crate (Fastly, Cloudflare, Spin), not a bidder **Adapter**. Say "platform adapter" for those.
- "Extension" here is unrelated to OpenRTB `ext` objects; say **Client Extension** / **Server Extension** in full.
- "Module" means a build unit in Prebid.js (`modules/*BidAdapter.js`) and a hook-based plugin in PBS. Don't use it for Extensions.
