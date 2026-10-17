// Parity harness: run a Shared Adapter build against PBS-Go's openx adapterstest fixtures.
// usage: node parity.mjs <dom|imports> <adapter.wasm> <prebid-server/adapters/openx/openxtest>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const [backend, wasm, dir] = process.argv.slice(2);
const { instantiate } = await import(`./glue-${backend}.js`);
const ad = instantiate(wasm === '-' ? null : readFileSync(wasm));
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const clone = (v) => JSON.parse(JSON.stringify(v));
let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (canon(got) === canon(want)) { pass++; return; }
  fail++; console.log(`FAIL ${name}\n  got  ${canon(got)}\n  want ${canon(want)}`);
};
for (const sub of ['exemplary', 'supplemental']) {
  for (const f of readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(join(dir, sub, f), 'utf8'));
    const name = `${sub}/${f}`;
    const out = ad.makeRequests(clone(fx.mockBidRequest), false);
    const calls = fx.httpCalls || [];
    check(`${name} request`, out.request ?? null, calls[0]?.expectedRequest.body ?? null);
    check(`${name} errors`, (out.errors || []).length, (fx.expectedMakeRequestsErrors || []).length);
    for (const [i, c] of calls.entries()) {
      if (c.mockResponse.status !== 200) continue;
      const got = ad.makeBids(clone(c.expectedRequest.body), clone(c.mockResponse.body));
      const want = fx.expectedBidResponses[i];
      check(`${name} currency`, got.currency, want.currency);
      check(`${name} bids`, got.bids.map((b) => ({ bid: b.bid, type: b.type })), want.bids.map((b) => ({ bid: b.bid, type: b.type })));
      const fl = (l) => (l || []).map(canon).sort();
      check(`${name} fledge`, fl(got.fledgeauctionconfigs), fl(want.fledgeauctionconfigs));
    }
  }
}
// Client (Prebid.js) profile has no PBS-Go fixtures: differential check against the JS port.
const L = await import('./openx-logic.js');
const creq = (bidder, extra = {}) => ({ id: 'r', ext: { pv: '11.0' }, device: { ua: 'x' }, ...extra,
  imp: [{ id: '1', bidfloor: 0, banner: { format: [{ w: 300, h: 250 }] }, video: { mimes: ['video/mp4'], w: 640 }, ext: { gpid: '/1/a', prebid: { adunitcode: 'div-1' }, bidder } },
    { id: '2', native: { request: '{}' }, ext: { bidder: { ...bidder, unit: 7 } } }, { id: '3', audio: {}, ext: { bidder } }] });
const cases = [
  creq({ unit: '1', delDomain: 'd.openx.net' }),
  creq({ unit: 5, platform: 'p', coppa: true, test: true, video: { skip: 1, w: 320 }, response_template_name: 't', customFloor: 1.5, customParams: { a: 1 } }, { regs: { gdpr: 1 } }),
  creq({ unit: '1', delDomain: 'd', customFloor: '0' }),
  { id: 'empty', imp: [{ id: 'x', audio: {} }] },
];
for (const [i, c] of cases.entries()) check(`client case ${i}`, ad.makeRequests(clone(c), true), L.makeRequests(clone(c), true));
for (const [i, b] of [{ params: { unit: '1', delDomain: 'x' } }, { params: { unit: '1' } }, { params: { platform: 'p' }, mediaTypes: { banner: { sizes: [[1, 1]] } } }, { params: { platform: 'p' }, mediaTypes: { banner: { sizes: [] } } }, { params: { unit: 0, delDomain: 'x' } }].entries())
  check(`isValid case ${i}`, ad.isValid(clone(b)), L.isValid(clone(b)));
console.log(`${backend}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
