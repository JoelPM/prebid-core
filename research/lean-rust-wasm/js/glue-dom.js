// Generic Prebid Core glue for "dom" (bytes in / bytes out) Shared Adapters, browser side.
// Server Hosts skip this entirely: they already hold the request as JSON bytes.
const te = new TextEncoder(), td = new TextDecoder();
export function instantiate(bytes) {
  const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  const run = (f, objs, extra) => {
    const bs = objs.map((o) => te.encode(JSON.stringify(o)));
    let p = x.alloc_in(bs.reduce((s, b) => s + b.length, 0));
    for (const b of bs) { new Uint8Array(x.memory.buffer, p, b.length).set(b); p += b.length; }
    const n = x[f](...bs.map((b) => b.length), ...extra);
    return f === 'is_valid' ? !!n : JSON.parse(td.decode(new Uint8Array(x.memory.buffer, x.out_ptr(), n)));
  };
  return {
    makeRequests: (req, client) => run('make_requests', [req], [client ? 1 : 0]),
    makeBids: (req, resp) => run('make_bids', [req, resp], []),
    isValid: (bid) => run('is_valid', [bid], []),
    roundtrip: (o) => run('roundtrip', [o], []),
  };
}

// Prebid.js: wasm inlined as base64 in the adapter chunk, compiled synchronously on first use
// (bidderFactory hooks are sync; Chromium allows sync compile of modules this small).
export const wasmAdapter = (b64) => () => instantiate(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
