# A Shared Adapter's output is JSON-equal across Hosts, not byte-equal

Everything a Shared Adapter emits (request bodies, bid overrides, `meta`, `video`, PAAPI configs, errors) is judged by JSON value equality:

- objects compare by member, arrays by order;
- numbers compare by exact decimal value (`1.50` equals `1.5`, but precision loss counts);
- strings are exact once decoded;
- key order, whitespace and escaping don't count.

Each Implementation must be deterministic and must never emit duplicate keys. Order the Adapter Definition can observe (`Object.keys`, spread order) stays JavaScript-exact everywhere, because it changes values. Bidders and Hosts must not depend on the byte form.

We chose this over byte-equality because byte-equality was never true and nothing relies on it. For the same bidder today:

- **Key order:** PBS-Go writes struct field order with sorted map keys. PBS-Java writes declaration order with HashMap-ordered `request.ext` extras. Prebid.js writes insertion order.
- **Escaping:** only Go escapes `& < >`.
- **Number text:** bidfloor `1.50` is `1.50` in Java, `1.5` elsewhere.
- **Body hashes:** the only one (PBS-Go's opt-in ads.cert) is computed by the Host over the bytes it sends.
- **Tests:** every Host's adapter tests compare by JSON meaning.

Requiring bytes would also forbid the Definition Compiler's fastest output strategy: streaming "copy with overrides", which writes rewritten members at the end of their object.

Consequences:

- **Pinned semantics:** #14's "assignment keeps a key's position" now binds only order the Definition can observe, not serialized output.
- **Precision:** loss a Host forces, such as Prebid.js numbers above 2^53, is a Host-gap Known Difference.
- **Re-serializing strings:** rewriting a string's contents, such as a native `adm`, must be a rule in the Adapter Definition.

Decided in [Must a Shared Adapter's request body be byte-equal across Hosts, or only JSON-equal?](https://github.com/JoelPM/prebid-core/issues/18).
