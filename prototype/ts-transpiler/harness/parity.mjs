// PROTOTYPE parity harness for the Shared Adapters' TS, run as-is (server side), on PBS-Go's adapterstest fixtures.
// For every fixture it checks
//   (1) fixture: the fixture's own expectations, compared the way adapterstest compares them;
//   (2) native:  the Hand-written PBS-Go Adapter's full output (harness/golden, from hostgo/cmd/golden),
//                including meta and deal priority, which adapterstest ignores.
// Every difference must be a Known Difference (defs/known-differences.yaml) whose pinned value matches.
//
// Usage: node harness/parity.mjs [prebid-server checkout] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const pbs = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(root, '../../../prebid-server');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const ENDPOINT = { openx: 'http://rtb.openx.net/prebid', pubmatic: 'https://hbopenbid.pubmatic.com/translator?source=prebid-server' };
const KD = YAML.parse(fs.readFileSync(path.join(root, 'defs/known-differences.yaml'), 'utf8'));

// ---- JSON semantics: key order irrelevant, absent == undefined, numbers by value ----
export function diff(a, b, p = '', out = []) {
  if (a === undefined && b === undefined) return out;
  if (typeof a !== typeof b || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    if (a !== b) out.push(p || '.');
    return out;
  }
  if (typeof a !== 'object') {
    if (a !== b) out.push(p || '.');
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(p + '.length');
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${p}.${k}`, out);
  return out;
}
const clean = (x) => JSON.parse(JSON.stringify(x ?? null));
export function at(o, p) {
  for (const m of ('.' + p.replace(/^\./, '')).matchAll(/\.([^.[]+)|\[(\d+)\]/g)) o = o?.[m[1] ?? +m[2]];
  return o;
}

// ---- the PBS-Go Host shim: what hostgo/host/shared.go does around the guest ----
const STATUS_ERR = (s) => `Unexpected status code: ${s}. Run with request.debug = 1 for more info`;
export function runTs(mod, bidder, hostRequest, spec) {
  const res = { requests: [], requestErrs: [], responses: [] };
  const mr = mod.makeRequests(hostRequest);
  res.requestErrs = mr.errs;
  if (mr.body) res.requests.push({ method: 'POST', uri: ENDPOINT[bidder], body: clean(mr.body), impIDs: mr.impIDs });
  for (const call of spec.httpCalls || []) {
    const { status, body } = call.mockResponse;
    const out = { currency: '', bids: [], paapi: null, errs: [] };
    res.responses.push(out);
    if (status === 204) continue;
    if (status !== 200) { out.errs.push(STATUS_ERR(status)); continue; }
    const mb = mod.makeBids(call.expectedRequest.body, body);
    out.currency = mb.currency || 'USD';
    out.errs = mb.errs;
    for (const b of mb.bids) {
      out.bids.push(clean({
        bid: b.bid, type: b.type, seat: b.seat || undefined, dealPriority: b.dealPriority || undefined,
        video: b.video && { duration: b.video.duration ?? 0, primary_category: b.video.primary_category ?? '' },
        meta: b.meta,
      }));
    }
    if (mb.paapi?.length) out.paapi = mb.paapi.map((c) => ({ impid: c.impid, bidder, config: c.config }));
  }
  return res;
}

// ---- (1) adapterstest-style expectations ----
function errMatch(actual, exp) {
  const c = exp.comparison || 'literal';
  return c === 'literal' ? actual === exp.value : c === 'startswith' ? actual?.startsWith(exp.value) : new RegExp(exp.value).test(actual);
}
export function checkFixture(spec, res) {
  const d = [];
  const errs = (actual, exp, where) => {
    if (actual.length !== exp.length) d.push(`${where}.length`);
    else exp.forEach((e, i) => !errMatch(actual[i], e) && d.push(`${where}[${i}]`));
  };
  errs(res.requestErrs, spec.expectedMakeRequestsErrors || [], 'requestErrs');
  const calls = spec.httpCalls || [];
  if (res.requests.length !== calls.length) d.push('requests.length');
  calls.forEach((c, i) => {
    const r = res.requests[i];
    if (!r) return;
    if (r.uri !== c.expectedRequest.uri) d.push(`requests[${i}].uri`);
    if (c.expectedRequest.impIDs && diff(r.impIDs, c.expectedRequest.impIDs).length) d.push(`requests[${i}].impIDs`);
    d.push(...diff(r.body, c.expectedRequest.body, `requests[${i}].body`));
  });
  errs(res.responses.flatMap((r) => r.errs), spec.expectedMakeBidsErrors || [], 'responses[*].errs');
  (spec.expectedBidResponses || []).forEach((e, i) => {
    const r = res.responses[i];
    if (!r) return d.push(`responses[${i}]`);
    if (e.currency && e.currency !== r.currency) d.push(`responses[${i}].currency`);
    if (r.bids.length !== e.bids.length) return d.push(`responses[${i}].bids.length`);
    e.bids.forEach((eb, j) => {
      const ab = r.bids[j];
      if ((eb.seat || '') !== (ab.seat || '')) d.push(`responses[${i}].bids[${j}].seat`);
      if (eb.type !== ab.type) d.push(`responses[${i}].bids[${j}].type`);
      d.push(...diff(ab.bid, eb.bid, `responses[${i}].bids[${j}].bid`));
      if (eb.video) d.push(...diff(ab.video, eb.video, `responses[${i}].bids[${j}].video`));
    });
    if (e.fledgeauctionconfigs) d.push(...diff(r.paapi, e.fledgeauctionconfigs, `responses[${i}].paapi`));
    else if (r.paapi) d.push(`responses[${i}].paapi`);
  });
  return d;
}

// A difference is explained when a Known Difference for this fixture covers its path and the
// Shared Adapter's value there equals the pinned one.
export function explain(bidder, file, against, diffs, res) {
  diffs = diffs.map((d) => d.replace(/^\./, ''));
  const kds = (KD[bidder] || []).filter((k) => k.fixture === file && (k.against || ['fixture', 'native']).includes(against));
  const unexplained = diffs.filter((p) => !kds.some((k) => p.startsWith(k.path)));
  const badPins = kds.filter((k) => diffs.some((p) => p.startsWith(k.path)) && k.shared != null && diff(clean(at(res, k.path)), k.shared).length).map((k) => k.path);
  return { unexplained, badPins, used: kds.filter((k) => diffs.some((p) => p.startsWith(k.path))) };
}

export async function main(runner, label) {
  const summary = [];
  let failed = 0;
  for (const bidder of ['openx', 'pubmatic']) {
    const dir = path.join(root, 'harness/golden', bidder);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const golden = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const spec = JSON.parse(fs.readFileSync(path.join(pbs, 'adapters', bidder, `${bidder}test`, file), 'utf8'));
      const res = await runner(bidder, golden.hostRequest, spec, file);
      const vsFixture = explain(bidder, file, 'fixture', checkFixture(spec, res), res);
      const vsNative = explain(bidder, file, 'native', diff(res, clean(golden.native)), res);
      const ok = !vsFixture.unexplained.length && !vsNative.unexplained.length && !vsFixture.badPins.length && !vsNative.badPins.length;
      if (!ok) failed++;
      const kd = [...new Set([...vsFixture.used, ...vsNative.used].map((k) => k.path))];
      summary.push({ bidder, file, ok, kd, fixture: vsFixture, native: vsNative });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${bidder}/${file}${kd.length ? `  (Known Difference: ${kd.join(', ')})` : ''}`);
      if (!ok) {
        for (const [w, v] of [['fixture', vsFixture], ['native', vsNative]]) {
          for (const p of v.unexplained) console.log(`   vs ${w}: ${p}\n      shared: ${JSON.stringify(at(res, p))?.slice(0, 300)}\n      ${w}: ${JSON.stringify(at(w === 'native' ? golden.native : null, p))?.slice(0, 300)}`);
          for (const p of v.badPins) console.log(`   vs ${w}: pinned value mismatch at ${p}: ${JSON.stringify(at(res, p))}`);
        }
      }
    }
  }
  console.log(`\n${label}: ${summary.length - failed}/${summary.length} fixtures at parity (${summary.filter((s) => s.kd.length).length} via Known Differences)`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 1));
  return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mods = {};
  const { build } = await import(path.join(root, 'core/index.ts'));
  for (const b of ['openx', 'pubmatic']) mods[b] = build((await import(path.join(root, `adapters/${b}.ts`))).default, 'server');
  const ts = (bidder, req, spec) => runTs(mods[bidder], bidder, req, spec);
  if (process.argv.includes('--rs')) {
    // Rust results come from hostgo/cmd/sharedout (wasm under wazero, through the PBS-Go Host binding)
    const dir = process.argv[process.argv.indexOf('--rs') + 1];
    let tsVsRs = 0;
    const rs = (bidder, req, spec, file) => {
      const r = JSON.parse(fs.readFileSync(path.join(dir, bidder, file), 'utf8'));
      const d = diff(clean(r), clean(ts(bidder, req, spec)));
      if (d.length) { tsVsRs++; console.log(`  TS != Rust on ${bidder}/${file}: ${d.join(', ')}`); }
      return r;
    };
    process.exitCode = (await main(rs, 'rust')) || tsVsRs ? 1 : 0;
    console.log(`TS vs Rust: ${tsVsRs ? tsVsRs + ' fixtures differ' : 'identical output on every fixture'}`);
  } else {
    process.exitCode = (await main(ts, 'ts')) ? 1 : 0;
  }
}
