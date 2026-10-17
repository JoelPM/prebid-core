// Per-call cost of the three backends on PBS-Go's multi-imp fixture (Node/V8).
// usage: node bench.mjs <out dir with ox_dom.opt.wasm, ox_imports.opt.wasm> <openxtest dir>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [out, dir] = process.argv.slice(2);
const fx = JSON.parse(readFileSync(join(dir, 'supplemental/multi-imp.json'), 'utf8'));
const resp = fx.httpCalls.find((c) => c.mockResponse.status === 200)?.mockResponse.body;
const clone = (v) => JSON.parse(JSON.stringify(v));
const ns = () => Number(process.hrtime.bigint());
for (const b of ['dom', 'imports', 'js']) {
  const { instantiate } = await import(`./glue-${b}.js`);
  const bytes = b === 'js' ? null : readFileSync(join(out, `ox_${b}.opt.wasm`));
  let t = ns();
  const ad = instantiate(bytes);
  const inst = (ns() - t) / 1e3;
  const reqs = Array.from({ length: 20000 }, () => clone(fx.mockBidRequest));
  const built = ad.makeRequests(clone(fx.mockBidRequest), false).request;
  for (let i = 0; i < 2000; i++) ad.makeRequests(reqs[i], false); // warm
  t = ns();
  for (let i = 2000; i < 20000; i++) ad.makeRequests(reqs[i], false);
  const mr = (ns() - t) / 18000 / 1e3;
  let mb = NaN;
  if (resp) {
    for (let i = 0; i < 2000; i++) ad.makeBids(built, resp);
    t = ns();
    for (let i = 0; i < 18000; i++) ad.makeBids(built, resp);
    mb = (ns() - t) / 18000 / 1e3;
  }
  console.log(`${b.padEnd(8)} compile+instantiate ${inst.toFixed(0)} us | makeRequests ${mr.toFixed(2)} us | makeBids ${mb.toFixed(2)} us`);
}

// dom core alone, bytes in / bytes out (what a server Host pays, minus its wasm runtime's call overhead)
{
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(out, 'ox_dom.opt.wasm'))), {}).exports;
  const reqB = new TextEncoder().encode(JSON.stringify(fx.mockBidRequest));
  const once = () => { const p = x.alloc_in(reqB.length); new Uint8Array(x.memory.buffer, p, reqB.length).set(reqB); return x.make_requests(reqB.length, 0); };
  for (let i = 0; i < 2000; i++) once();
  const t = ns();
  for (let i = 0; i < 20000; i++) once();
  console.log(`dom core bytes->bytes (${reqB.length} B in, ${once()} B out): makeRequests ${((ns() - t) / 20000 / 1e3).toFixed(2)} us`);
}
