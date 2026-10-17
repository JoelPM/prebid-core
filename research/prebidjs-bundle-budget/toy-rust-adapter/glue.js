// Minimal JS glue for the raw-ABI adapter (no wasm-bindgen).
const te = new TextEncoder(), td = new TextDecoder();
export async function load(src) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(src), {});
  const x = instance.exports;
  const put = (o) => { const b = te.encode(JSON.stringify(o)); const p = x.alloc(b.length); new Uint8Array(x.memory.buffer, p, b.length).set(b); return [p, b.length]; };
  const get = () => JSON.parse(td.decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len())));
  const call = (fn, o) => { const [p, l] = put(o); const r = x[fn](p, l); x.dealloc(p, l); return r; };
  return {
    isBidRequestValid: (bid) => call('is_bid_request_valid', bid) === 1,
    buildRequests: (bidRequests, bidderRequest) => (call('build_requests', { bidRequests, bidderRequest }), get()),
    interpretResponse: (resp) => (call('interpret_response', resp), get()),
  };
}
