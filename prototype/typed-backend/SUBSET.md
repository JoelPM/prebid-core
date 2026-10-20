# PROTOTYPE: Restricted TypeScript, as prototyped

What an **Adapter Definition** may contain, as enforced by `transpiler/transpile.mjs`. The rule behind it: allow only what means the same in TypeScript and in the generated Rust, and reject anything else rather than approximate it. Every rejection below has a case in `transpiler/rejects.test.mjs`.

## Shape

```ts
import { defineAdapter, reject, str, num, int, obj, nonempty, without, parseJson } from '<prebid core>';
const TABLE: Record<number, MediaType> = { 1: 'banner' };     // module level: lookup tables of string literals
const helper = (x: Json | undefined) => { ... };             // module level: helper functions
export default defineAdapter<Params, BidExt>({
  bidder, endpoint, required: { all, anyOf },
  core:   { imp(imp, p, req), request(req, params), bid(bid, imp, resp), response(resp) },   // the four Phases
  server: { endpoint?, imp?, request?, bid? },                // Server Extension: returns patches
  client: { endpoint?, imp?, request?, bid? },                // Client Extension: returns patches
});
```

- The **imp** Phase returns the outgoing imp or `reject(message)`. **request** gets `req.imp` already replaced by the outgoing imps, plus their params. **bid** returns `{ bid?, type, seat?, dealPriority?, video?, meta?, warning? }` or `reject(message)`. **response** returns `{ currency?, paapi? }`.
- An Extension Phase returns a patch. Prebid Core applies it add-only: it fills fields core left absent and recurses into objects both have, so it can never overwrite core's output. Extensions can't reject.
- Types are the contract. Inputs are typed: OpenRTB and Prebid `ext` fields, params generated from the params schema, and the bidder's own `bid.ext`. Open-ended data is `Json`, narrowed with `typeof`, `Array.isArray` or `obj()`. `any` is rejected. Checked with `strict` and `noUncheckedIndexedAccess`.

## Allowed

- `const` / `let`, `if`/`else`, `return`, and `for (const x of list)`.
- Writes only to objects the function itself created, and only one level deep (`out.x = ...`), and only before that object is used as a value. Reassigning `let` locals.
- Object and array literals, spreads in literals, shorthand properties.
- `?.`, `??`, `||`, `&&`, `!`, `?:` with JavaScript truthiness.
- `===` / `!==` (including against `undefined`), and `== null` / `!= null`.
- `<` `>` `<=` `>=` and `+ - * / %` on numbers only.
- Templates whose interpolations are strings, numbers, booleans, null or undefined.
- Strings: `.trim()`, `.toLowerCase()`, `.split('<non-empty literal>')`, `.includes(s)`, `.length`.
- Arrays: `.map` / `.filter` / `.find` / `.some` / `.every` with an expression-bodied, one-parameter arrow (array destructuring allowed), `.join('<literal>')`, `.length`, and `[i]`.
- `Object.entries` / `keys` / `fromEntries`, `JSON.stringify(x)`, `Math.max(a, b)`, `Array.isArray(x)`, `typeof x === '<literal>'`.
- Prebid Core: `str` / `num` / `int` (the only coercions), `obj`, `nonempty`, `without(o, ...literal keys)`, `parseJson` (never throws), `reject`.

## Rejected, and why

| Rejected | Why |
|---|---|
| Writes to inputs or parameters | Rust borrows the input, so in-place edits have no equivalent. |
| Nested writes `out.a.b = x` | After a spread, JS would mutate the *input's* `a`. Write `out.a = { ...out.a, b: x }`. |
| Writes after the object was used as a value | JS objects are shared references, Rust values aren't. The same program would diverge. |
| `Object.keys/entries` of an object the function built | A member set to `undefined` is deleted in Rust (identical JSON) but still listed by JS. |
| `==` / `!=` except against `null`, `String()` / `Number()` / `parseInt` / unary `+`, string `+` | JS coercion rules. Use Core `str` / `num` / `int`, whose semantics are pinned. |
| Ordering comparisons on non-numbers | String comparison is UTF-16 order in JS. Not needed yet. |
| `split` on an empty or non-literal separator | `''` splits UTF-16 units in JS, which no fixture needs. |
| Templates interpolating objects or arrays | `[object Object]` and the implicit `join` are never what's meant. |
| `any`, methods on values not statically strings or arrays | No type, no defined semantics. |
| Loops other than `for..of`, `for..in`, recursion-capable local closures, exceptions, `delete`, `++`, `new`, regex, classes, `this`, module-level `let` | Not needed by the two Adapters. Each adds semantics to pin (and loops add cost). Add on demand. |
| Array `.includes`, block-bodied callbacks, callback index parameter | Not needed yet (SameValueZero, closures). |
| Imports other than Prebid Core and type-only imports | An Adapter Definition is self-contained. |

## Semantics the Rust runtime pins to JavaScript

Inherited from the Definition prototype (#14): last-wins duplicate keys, integer-like keys first, assignment keeps a key's position, JS `trim` whitespace, f64 maths with `String(n)` printing, canonical `JSON.stringify`, strict `JSON.parse`.

New in `runtime/rs/src/js.rs`:

8. `undefined` array elements are kept, as a real node of kind Absent. So `=== undefined`, `typeof`, `join` (`''`) and `JSON.stringify` (`null`) all match JS. The D runtime silently dropped them.
9. `join` prints null and undefined as `''`, nested arrays with `,`, and objects as `[object Object]`.
10. Templates print `undefined` and `null` as JS does.
11. `split` / `includes` / `trim` / `toLowerCase` on a missing value return undefined, which matches the `?.` chains the types force. String `.length` counts UTF-16 units.
12. `Object.entries` yields `[k, v]` pairs and `fromEntries` reads them. Keys use JS order.

Known residual differences: integers beyond 2^53 lose precision in TypeScript (Prebid.js has the same limit today). A member that is deleted and then reassigned moves to the end of its object in Rust, so the JSON is equal but not byte-equal.
