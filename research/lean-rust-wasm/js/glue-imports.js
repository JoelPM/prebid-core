// Generic Prebid Core glue for "imports" (field-by-field) Shared Adapters. Shared by all
// Adapters: it knows nothing about OpenX. wasm sees JS values only as handle indices.
const td = new TextDecoder();
export function instantiate(bytes) {
  let H, x;
  const kc = new Map();
  const S = (p, l) => {
    const c = p * 65536 + l;
    let s = kc.get(c);
    if (s === undefined) kc.set(c, (s = td.decode(new Uint8Array(x.memory.buffer, p, l))));
    return s;
  };
  const add = (v) => (v === undefined ? 0 : H.push(v) - 1);
  const isO = (v) => v !== null && typeof v === 'object';
  const isM = (v) => isO(v) && !Array.isArray(v);
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? +v : NaN);
  const h = {
    k: (i) => { const v = H[i]; return v === undefined ? 0 : v === null ? 1 : v === true ? 2 : v === false ? 3 : typeof v === 'number' ? 4 : typeof v === 'string' ? 5 : Array.isArray(v) ? 6 : isO(v) ? 7 : 0; },
    g: (o, p, l) => (isM(H[o]) ? add(H[o][S(p, l)]) : 0),
    n: (i) => (isO(H[i]) ? Object.keys(H[i]).length : 0),
    a: (i, j) => (isO(H[i]) ? add(Object.values(H[i])[j]) : 0),
    ka: (i, j) => (isM(H[i]) ? add(Object.keys(H[i])[j]) : 0),
    eq: (i, p, l) => { const v = H[i]; return (typeof v === 'string' || typeof v === 'number') && String(v) === S(p, l); },
    se: (a, b) => typeof H[a] === 'string' && H[a] === H[b],
    t: (i) => !!H[i],
    pn: (i) => num(H[i]) > 0,
    tn: (i) => { const n = num(H[i]); return n === n ? add(n) : 0; },
    ts: (i) => { const v = H[i]; return typeof v === 'string' ? i : typeof v === 'number' ? add(String(v)) : 0; },
    o: () => add({}),
    r: () => add([]),
    l: (p, l) => add(S(p, l)),
    i: (n) => add(n),
    s: (o, p, l, v) => { if (v && isM(H[o])) H[o][S(p, l)] = H[v]; },
    sd: (o, k, v) => { if (v && isM(H[o])) H[o][H[k]] = H[v]; },
    d: (o, p, l) => { if (isM(H[o])) delete H[o][S(p, l)]; },
    p: (a, v) => { if (v && Array.isArray(H[a])) H[a].push(H[v]); },
    c: (o) => add(isM(H[o]) ? { ...H[o] } : {}),
  };
  x = new WebAssembly.Instance(new WebAssembly.Module(bytes), { h }).exports;
  const run = (f, a, b) => { H = [undefined]; const r = x[f](add(a), typeof b === 'number' ? b : add(b)); return H[r]; };
  return {
    // NB: mutates `req` in place (Prebid.js hands over a freshly built ortbConverter request)
    makeRequests: (req, client) => run('make_requests', req, client ? 1 : 0),
    makeBids: (req, resp) => run('make_bids', req, resp),
    isValid: (bid) => { H = [undefined]; return !!x.is_valid(add(bid)); },
  };
}

// Prebid.js: wasm inlined as base64 in the adapter chunk, compiled synchronously on first use
// (bidderFactory hooks are sync; Chromium allows sync compile of modules this small).
export const wasmAdapter = (b64) => () => instantiate(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
