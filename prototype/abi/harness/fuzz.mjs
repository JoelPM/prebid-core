// PROTOTYPE differential fuzz: the Shared Adapters' TS (run as-is) vs the transpiled Rust (native,
// guest/src/bin/fuzz.rs) on mutated fixture inputs. Typed fields get values of their declared type
// (params are schema-validated and ORTB is typed: the types are the contract); open `Json` fields
// (ext.data, bidderparams, customParams, bid.ext ids, PAAPI configs, ...) get arbitrary JSON.
// Usage: node harness/fuzz.mjs <prebid-server checkout> [iterations per bidder] [seed]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from '../core/index.ts';
import { diff } from './parity.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const pbs = process.argv[2];
const N = +(process.argv[3] ?? 3000);
let seed = +(process.argv[4] ?? 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

// ---------- value pools ----------
// lone surrogates, a broken pair and emoji (#23: strings are UTF-16 code units, kept as they are)
const STRS = ['\ud800', 'a\udc00b', '\ud83d', '😀x', '', ' ', 'a', ' a ', 'A@1x2', ' x﻿', '\u0085y', 'é', '😀', 'gam', '*', 'pubmatic', 'appnexus', 'pmZoneID', '123', ' 12 ', '1.5', '-3', '1e3', 'x\ty', '\\/', '"q"', 'null', '0'];
const SLOTS = ['', ' ', 'slot', ' slot ', 'slot@300x250', 'slot@300X250:1', 'slot@300x250 ', '@300x250', 'slot@', 'slot@300', 'slot@x250', 'slot@ax250', 'slot@300x250x1', 'a@b@c', 'slot@ 300 x 250 ', 'slot@300x250:abc', 'é@1x2'];
const NUMS = [0, -0, 1, 2, 3, 4, 5, 1.5, -1, 100, 0.1, 1e21, 123456789, 2 ** 31];
const json = (depth = 0) => {
  const r = rnd();
  if (r < 0.25) return pick(STRS);
  if (r < 0.45) return pick(NUMS);
  if (r < 0.52) return pick([true, false]);
  if (r < 0.58) return null;
  if (depth > 2) return pick(STRS);
  if (r < 0.8) return Array.from({ length: Math.floor(rnd() * 4) }, () => (chance(0.6) ? pick(STRS) : json(depth + 1)));
  return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick([...STRS, 'k', '1', '0', '10', 'pbadslot', 'adserver', 'name', 'adslot']), json(depth + 1)]));
};
const opt = (f, p = 0.3) => (chance(p) ? undefined : f());
const str = () => pick(STRS);
const strArr = () => Array.from({ length: Math.floor(rnd() * 4) }, str);

function set(o, p, v) {
  const ks = p.split('.');
  let c = o;
  for (const k of ks.slice(0, -1)) c = c[k] = c[k] && typeof c[k] === 'object' ? c[k] : {};
  if (v === undefined) delete c[ks.at(-1)];
  else c[ks.at(-1)] = v;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- mutators, by declared type ----------
const MUT = {
  openx: {
    imp: (imp) => {
      const b = imp.ext.bidder;
      if (chance(0.5)) b.unit = pick([str(), pick(NUMS)]);
      if (chance(0.4)) set(imp, 'ext.bidder.customFloor', opt(() => pick([str(), pick(NUMS)])));
      if (chance(0.4)) set(imp, 'ext.bidder.customParams', opt(() => json(1)));
      if (chance(0.3)) set(imp, 'ext.bidder.delDomain', opt(str));
      if (chance(0.3)) set(imp, 'ext.bidder.platform', opt(str));
      if (chance(0.3)) set(imp, 'bidfloor', opt(() => pick(NUMS)));
      if (chance(0.3)) set(imp, 'rwdd', opt(() => pick(NUMS)));
      if (chance(0.2)) set(imp, 'video', opt(() => ({ w: 1, ext: json(1) })));
      if (chance(0.2)) set(imp, 'banner', opt(() => ({ format: [{ w: 300, h: 250 }] })));
      if (chance(0.2)) set(imp, 'native', opt(() => ({ request: '{}' })));
      if (chance(0.3)) set(imp, `ext.${pick(['foo', 'prebid', 'gpid', 'data'])}`, opt(() => json(1)));
    },
    bid: (bid) => {
      for (const k of ['dsp_id', 'buyer_id', 'brand_id']) if (chance(0.4)) set(bid, `ext.${k}`, opt(() => json(2)));
      if (chance(0.3)) set(bid, 'mtype', opt(() => pick(NUMS)));
      if (chance(0.3)) set(bid, 'cat', opt(strArr));
      if (chance(0.3)) set(bid, 'dur', opt(() => pick(NUMS)));
    },
    resp: (r) => {
      if (chance(0.3)) set(r, 'cur', opt(str));
      if (chance(0.3)) set(r, 'ext.fledge_auction_configs', opt(() => Object.fromEntries([[str(), json(1)], [pick(['1', '0', 'imp']), json(1)]])));
    },
  },
  pubmatic: {
    imp: (imp, req) => {
      const b = imp.ext.bidder;
      if (chance(0.6)) set(imp, 'ext.bidder.adSlot', opt(() => pick(SLOTS)));
      if (chance(0.4)) set(imp, 'ext.bidder.kadfloor', opt(() => pick([...STRS, ' 1.5 ', '0.25'])));
      if (chance(0.3)) set(imp, 'ext.bidder.pmzoneid', opt(str));
      if (chance(0.3)) set(imp, 'ext.bidder.dctr', opt(str));
      if (chance(0.4)) set(imp, 'ext.bidder.keywords', opt(() => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ key: pick([...STRS, 'pmZoneID', 'key_val', 'dctr']), value: strArr() }))));
      if (chance(0.3)) set(imp, 'ext.bidder.wrapper', opt(() => ({ profile: pick(NUMS), version: opt(() => pick(NUMS)) })));
      if (chance(0.3)) b.publisherId = pick(STRS);
      if (chance(0.5)) set(imp, 'ext.data', opt(() => Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [pick([...STRS, 'pbadslot', 'adserver', ' k ']), json(1)]))));
      if (chance(0.3)) set(imp, 'ext.data.adserver', opt(() => ({ name: pick(['gam', 'x', '']), adslot: json(2) })));
      if (chance(0.2)) set(imp, 'ext.ae', opt(() => pick(NUMS)));
      if (chance(0.2)) set(imp, 'ext.gpid', opt(str));
      if (chance(0.2)) set(imp, 'ext.skadn', opt(() => json(1)));
      if (chance(0.3)) set(imp, 'banner', opt(() => ({ w: opt(() => pick(NUMS)), h: opt(() => pick(NUMS)), format: opt(() => [{ w: pick(NUMS), h: pick(NUMS) }]) })));
      if (chance(0.2)) set(imp, 'video', opt(() => ({ w: 640 })));
      if (chance(0.2)) set(imp, 'audio', opt(() => ({ mimes: ['a'] })));
      if (chance(0.2)) set(imp, 'displaymanager', opt(str));
      if (chance(0.2)) set(imp, 'bidfloor', opt(() => pick(NUMS)));
    },
    req: (req) => {
      if (chance(0.3)) set(req, 'ext.prebid.bidderparams', opt(() => ({ wrapper: json(1), acat: chance(0.5) ? strArr() : json(1) })));
      if (chance(0.3)) set(req, 'ext.prebid.alternatebiddercodes', opt(() => ({ enabled: pick([true, false]), bidders: { pubmatic: { enabled: pick([true, false]), allowedbiddercodes: opt(() => pick([['*'], strArr(), ['*', 'a']])) } } })));
      if (chance(0.2)) set(req, 'ext.prebid.aliases', opt(() => Object.fromEntries(strArr().map((s) => [s || 'x', 'pubmatic']))));
      if (chance(0.15)) set(req, 'ext', undefined);
      if (chance(0.3)) set(req, pick(['site', 'app']), opt(() => (chance(0.5) ? { publisher: { id: str(), name: 'n' } } : { page: 'p' })));
      if (chance(0.2)) set(req, 'app.ext', opt(() => ({ source: opt(str), version: opt(str), prebid: opt(() => ({ source: opt(str), version: opt(str) })) })));
    },
    bid: (bid) => {
      if (chance(0.4)) set(bid, 'mtype', opt(() => pick(NUMS)));
      if (chance(0.3)) set(bid, 'adm', opt(() => pick(['{"native":{"a":1,"b":"\\/x"}}', '{"native":null}', '{"x":1}', 'not json', '5', '"s"', '{"native":{"img":{"url":"\\u00e9"}}}', '', '{"native":{"x":1e21,"y":-0}}'])));
      if (chance(0.3)) set(bid, 'ext.prebiddealpriority', opt(() => pick(NUMS)));
      if (chance(0.3)) set(bid, 'ext.marketplace', opt(str));
      if (chance(0.3)) set(bid, 'ext.ibv', opt(() => pick([true, false])));
      if (chance(0.3)) set(bid, 'ext.video.duration', opt(() => pick(NUMS)));
      if (chance(0.3)) set(bid, 'cat', opt(strArr));
      if (chance(0.15)) set(bid, 'ext', undefined);
    },
    resp: (r) => MUT.openx.resp(r),
  },
};

// ---------- normalized comparison ----------
const clean = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
// what a Host-native string slot can carry (lone surrogates become U+FFFD; see the ABI question in the map)
const slot = (s) => (typeof s === 'string' ? s.toWellFormed() : s);
const emptyish = (x) => x == null || x === '' || x === 0 || (typeof x === 'object' && !Object.keys(x).length);
const norm = (x) => (emptyish(clean(x)) ? null : clean(x));
const normSlot = (x) => { const c = norm(x); if (!c || typeof c !== 'object') return c; for (const k of Object.keys(c)) if (typeof c[k] === 'string') c[k] = slot(c[k]); return c; };
function applyOverrides(bid, ov) {
  const b = clean(bid);
  for (const [k, v] of Object.entries(ov ?? {})) v === null ? delete b[k] : (b[k] = v);
  return b;
}

const results = {};
for (const bidder of ['openx', 'pubmatic']) {
  const sa = build((await import(path.join(root, `adapters/${bidder}.ts`))).default, 'server');
  const dir = path.join(root, 'harness/golden', bidder);
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.json')).sort();
  const seeds = files.map((f) => {
    const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const spec = JSON.parse(fs.readFileSync(path.join(pbs, 'adapters', bidder, `${bidder}test`, f), 'utf8'));
    const calls = (spec.httpCalls || []).filter((c) => c.mockResponse.status === 200 && c.mockResponse.body);
    return { req: g.hostRequest, calls };
  });
  const cases = [];
  for (let i = 0; i < N; i++) {
    const s = pick(seeds);
    const req = clone(s.req);
    for (const imp of req.imp ?? []) if (imp.ext?.bidder && chance(0.8)) MUT[bidder].imp(imp, req);
    MUT[bidder].req?.(req);
    cases.push({ op: 'mr', req });
    const call = s.calls.length && pick(s.calls);
    if (call) {
      const out = clone(call.expectedRequest.body);
      const resp = clone(call.mockResponse.body);
      for (const sb of resp.seatbid ?? []) for (const bid of sb.bid ?? []) MUT[bidder].bid(bid);
      MUT[bidder].resp(resp);
      cases.push({ op: 'mb', req: out, resp });
    }
  }
  const input = cases.map((c) => [bidder, c.op, JSON.stringify(c.req), ...(c.resp ? [JSON.stringify(c.resp)] : [])].join('\t')).join('\n') + '\n';
  // DUMP_CASES=<file>: also write the cases (one per line) for hostgo/cmd/abifuzz
  if (process.env.DUMP_CASES) fs.appendFileSync(process.env.DUMP_CASES, input);
  const rs = spawnSync(process.env.FUZZ_BIN || path.join(root, 'out/target-native/release/fuzz'), { input, maxBuffer: 1 << 30 });
  if (rs.status !== 0) throw new Error(rs.stderr.toString());
  const rsOut = rs.stdout.toString().trim().split('\n').map((l) => JSON.parse(l));
  const r = (results[bidder] = { cases: cases.length, tsThrew: 0, differ: 0, cover: { body: 0, impRejected: 0, bidsKept: 0, bidsRejected: 0, warnings: 0, paapi: 0, meta: 0 }, examples: [] });
  cases.forEach((c, i) => {
    let ts;
    try {
      ts = c.op === 'mr' ? sa.makeRequests(c.req) : sa.makeBids(c.req, c.resp);
    } catch (e) {
      r.tsThrew++;
      return;
    }
    const x = rsOut[i];
    const cv = r.cover;
    if (c.op === 'mr') { cv.body += !!ts.body; cv.impRejected += ts.errs.length; }
    else { cv.bidsKept += ts.bids.length; cv.bidsRejected += x.bids.filter((b) => !b.keep).length; cv.warnings += ts.errs.length - x.bids.filter((b) => !b.keep).length; cv.paapi += !!ts.paapi?.length; cv.meta += ts.bids.filter((b) => !emptyish(clean(b.meta))).length; }
    let d;
    if (c.op === 'mr') d = diff({ body: clean(ts.body), impIDs: (ts.impIDs ?? []).map(slot), errs: ts.errs.map(slot) }, { body: x.body, impIDs: x.impIDs, errs: x.errs });
    else {
      const bids = c.resp.seatbid?.flatMap((sb) => sb.bid ?? []) ?? [];
      const kept = x.bids.map((b, j) => [b, bids[j]]).filter(([b]) => b.keep);
      d = diff(
        { bids: ts.bids.map((b) => ({ bid: clean(b.bid), type: b.type, seat: slot(b.seat) || null, dp: Math.max(-2147483648, Math.min(2147483647, Math.trunc(b.dealPriority || 0))), video: normSlot(b.video), meta: normSlot(b.meta) })), cur: slot(ts.currency) || null, paapi: norm(ts.paapi), errs: ts.errs.map(slot) },
        { bids: kept.map(([b, orig]) => ({ bid: applyOverrides(orig, b.overrides), type: b.type, seat: b.seat || null, dp: b.dealPriority, video: norm(b.video), meta: norm(b.meta) })), cur: x.currency || null, paapi: norm(x.paapi), errs: x.errs },
      );
    }
    if (d.length) {
      r.differ++;
      if (r.examples.length < 5) r.examples.push({ op: c.op, at: d.slice(0, 5), input: c, ts: c.op === 'mr' ? clean(ts) : clean(ts), rs: x });
    }
  });
  console.log(`${bidder}: ${r.cases} calls, TS vs Rust differ on ${r.differ}, TS threw on ${r.tsThrew}; reached ${JSON.stringify(r.cover)}`);
}
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out/fuzz.json'), JSON.stringify(results, null, 1));
