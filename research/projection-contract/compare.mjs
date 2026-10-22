// Compares what each Host's model would hand a Shared Adapter with the reference: the case's own bytes,
// read exactly, cut to the Adapters' read paths (shapes.json, the union of OpenX's and PubMatic's).
//
// "Exactly" means: UTF-8 decoded with U+FFFD for invalid bytes (#23's boundary rule), strings as UTF-16
// code units with lone surrogates kept, numbers as exact decimals (ADR 0001), duplicate keys last-wins
// at the first key's position (JavaScript's JSON.parse), member order as in the bytes.
//
// Equality is what a Restricted TypeScript Adapter can observe on those paths: absent, null, 0 and ""
// are all different; numbers equal by exact value, but -0 is reported (JS can see it through 1/x);
// member order counts only where the Adapter enumerates members (the `%` paths, via Object.entries),
// and there in JavaScript order (integer-like keys ascending, then insertion).
//
// Usage: node compare.mjs   (reads out-*.jsonl, writes results/matrix.md and results/diffs.txt)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const shapes = JSON.parse(readFileSync(here + 'shapes.json', 'utf8'));

// ---------- exact JSON reading ----------
// node: {t:'obj', keys:[...], m:Map} | {t:'arr', a:[...]} | {t:'num', s} | {t:'str', s} | {t:'lit', s}
const NUM = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
function parseExact(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const val = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const m = new Map(); const keys = [];
      ws(); if (text[i] === '}') { i++; return { t: 'obj', keys, m }; }
      for (;;) {
        ws(); const k = str().s; ws(); if (text[i++] !== ':') throw new Error('colon at ' + i);
        const v = val();
        if (!m.has(k)) keys.push(k);
        m.set(k, v);
        ws(); if (text[i] === ',') { i++; continue; } if (text[i++] !== '}') throw new Error('obj at ' + i); return { t: 'obj', keys, m };
      }
    }
    if (c === '[') {
      i++; const a = [];
      ws(); if (text[i] === ']') { i++; return { t: 'arr', a }; }
      for (;;) { a.push(val()); ws(); if (text[i] === ',') { i++; continue; } if (text[i++] !== ']') throw new Error('arr at ' + i); return { t: 'arr', a }; }
    }
    if (c === '"') return str();
    NUM.lastIndex = i; const m = NUM.exec(text);
    if (m && m[0]) { i += m[0].length; return { t: 'num', s: m[0] }; }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return { t: 'lit', s: lit }; }
    throw new Error('bad token at ' + i + ': ' + text.slice(i, i + 20));
  };
  const str = () => {
    const s = i; i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i > text.length) throw new Error('eof in string'); }
    i++;
    return { t: 'str', s: JSON.parse(text.slice(s, i)) };
  };
  const v = val(); ws();
  if (i !== text.length) throw new Error('trailing at ' + i);
  return v;
}

// A JavaScript value (Prebid.js: JSON.parse) as a node.
function fromJs(v) {
  if (v === null || typeof v === 'boolean') return { t: 'lit', s: String(v) };
  if (typeof v === 'number') return { t: 'num', s: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'string') return { t: 'str', s: v };
  if (Array.isArray(v)) return { t: 'arr', a: v.map(fromJs) };
  const keys = Object.keys(v); const m = new Map(keys.map((k) => [k, fromJs(v[k])]));
  return { t: 'obj', keys, m };
}

// Prebid.js: src/utils/untrustedJson.ts parseUntrustedJSON = JSON.parse + stripGadgetKeys.
function prebidJs(bytes) {
  const v = JSON.parse(new TextDecoder().decode(bytes));
  const pending = [v];
  while (pending.length) {
    const n = pending.pop();
    if (n === null || typeof n !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(n, '__proto__')) delete n['__proto__'];
    if (Object.prototype.hasOwnProperty.call(n, 'constructor') && n.constructor !== null && typeof n.constructor === 'object') delete n.constructor;
    Object.keys(n).forEach((k) => pending.push(n[k]));
  }
  return fromJs(v);
}

// ---------- projection (prototype/abi AppendRaw's rules) ----------
function tree(paths) {
  const root = {};
  for (const p of paths) {
    let n = root;
    for (const seg of p) {
      const k = seg === '*' ? 'el' : seg === '%' ? 'any' : null;
      if (k) n = n[k] ??= {}; else { n.kids ??= {}; n = n.kids[seg] ??= {}; }
    }
    n.leaf = true;
  }
  return root;
}
function project(v, n) {
  const whole = n.leaf && !n.el && !n.any && !n.kids;
  if (whole || (v.t !== 'obj' && v.t !== 'arr') || (v.t === 'obj' && !n.kids && !n.any) || (v.t === 'arr' && !n.el)) return v;
  if (v.t === 'arr') return { t: 'arr', a: v.a.map((x) => project(x, n.el)) };
  const keys = []; const m = new Map();
  for (const k of v.keys) {
    const kid = n.kids?.[k] ?? n.any;
    if (!kid) continue;
    keys.push(k); m.set(k, project(v.m.get(k), kid));
  }
  return { t: 'obj', keys, m, enumerated: !!n.any };
}

// ---------- observable comparison ----------
function decimal(s) {
  // exact canonical decimal: sign, digits without leading/trailing zeros, exponent
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return s;
  let digits = m[2] + (m[3] ?? ''); let exp = BigInt(m[4] ?? 0) - BigInt((m[3] ?? '').length);
  digits = digits.replace(/^0+/, '');
  if (!digits) return m[1] + '0';
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exp++; }
  return `${m[1]}${digits}e${exp}`;
}
const jsOrder = (keys) => {
  const int = keys.filter((k) => /^(0|[1-9]\d*)$/.test(k) && Number(k) < 2 ** 32 - 1).sort((a, b) => Number(a) - Number(b));
  return [...int, ...keys.filter((k) => !int.includes(k))];
};
const show = (v) => {
  if (v === undefined) return 'absent';
  if (v.t === 'str') return JSON.stringify(v.s).replace(/[\ud800-\udfff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  if (v.t === 'num' || v.t === 'lit') return v.s;
  if (v.t === 'arr') return '[' + v.a.map(show).join(',') + ']';
  return '{' + v.keys.map((k) => JSON.stringify(k) + ':' + show(v.m.get(k))).join(',') + '}';
};
function diff(a, b, path, out, enumerated) {
  if (a === undefined || b === undefined) { if (a !== b) out.push(`${path}: ${show(a)} -> ${show(b)}`); return; }
  if (a.t !== b.t) { out.push(`${path}: ${show(a)} -> ${show(b)}`); return; }
  if (a.t === 'num') { if (decimal(a.s) !== decimal(b.s)) out.push(`${path}: ${a.s} -> ${b.s}`); return; }
  if (a.t === 'str' || a.t === 'lit') { if (a.s !== b.s) out.push(`${path}: ${show(a)} -> ${show(b)}`); return; }
  if (a.t === 'arr') {
    if (a.a.length !== b.a.length) out.push(`${path}: length ${a.a.length} -> ${b.a.length}`);
    for (let i = 0; i < Math.min(a.a.length, b.a.length); i++) diff(a.a[i], b.a[i], `${path}[${i}]`, out);
    return;
  }
  if (a.enumerated || enumerated) {
    const ka = jsOrder(a.keys).join(','), kb = jsOrder(b.keys).join(',');
    if (ka !== kb) out.push(`${path}: Object.keys ${ka} -> ${kb}`);
  }
  for (const k of new Set([...a.keys, ...b.keys])) diff(a.m.get(k), b.m.get(k), `${path}.${k}`, out);
}

// The proposed contract's typed-field rule, applied by Prebid Core itself. On OpenRTB-typed members
// (anything not under an `ext`): an optional attribute that is null or its type's zero ("", 0, [])
// reads as absent; a required attribute (response: bid.impid, seatbid.bid; also id and price, which
// these Adapters don't read) that is absent or null reads as its zero. That is exactly what PBS-Go's
// openrtb2 json tags hold (omitempty = optional). Members inside `ext` are left exactly as sent.
const REQUIRED = { impid: { t: 'str', s: '' }, bid: { t: 'arr', a: [] } };
const isZero = (c) => (c.t === 'lit' && c.s === 'null') || (c.t === 'num' && decimal(c.s).replace('-', '') === '0') || (c.t === 'str' && c.s === '') || (c.t === 'arr' && !c.a.length);
function normalize(v, inExt = false, at = '') {
  if (!v || v.t === 'str' || v.t === 'num' || v.t === 'lit') return v;
  if (v.t === 'arr') return { ...v, a: v.a.map((x) => normalize(x, inExt, at + '[]')) };
  const keys = []; const m = new Map();
  const req = inExt ? [] : at === '.seatbid[]' ? ['bid'] : at === '.seatbid[].bid[]' ? ['impid'] : [];
  for (const k of v.keys) {
    let c = v.m.get(k);
    if (!inExt && isZero(c)) {
      if (!req.includes(k)) continue;
      if (c.t === 'lit') c = REQUIRED[k];
    }
    keys.push(k); m.set(k, normalize(c, inExt || k === 'ext', at + '.' + k));
  }
  for (const k of req) if (!m.has(k)) { keys.push(k); m.set(k, REQUIRED[k]); }
  return { ...v, keys, m };
}

// ---------- run ----------
const b64 = (s) => Buffer.from(s, 'base64');
const load = (f) => readFileSync(here + f, 'utf8').trim().split('\n').map(JSON.parse);
const byCase = (rows) => new Map(rows.map((r) => [r.kind + '/' + r.case, r]));
const go = byCase(load('out-go.jsonl')), java = byCase(load('out-java.jsonl')), rust = byCase(load('out-rust.jsonl'));
const trees = { resp: tree(shapes.resp), req: tree(shapes.req) };

const HOSTS = {
  resp: [
    ['PBS-Go struct', (k) => go.get(k).err ? { err: go.get(k).err } : { b: b64(go.get(k).struct) }],
    ['PBS-Go raw', (k) => ({ b: b64(go.get(k).raw) })],
    ['PBS-Go shadow', (k) => go.get(k).shadowErr ? { err: go.get(k).shadowErr } : { b: b64(go.get(k).shadow) }],
    ['PBS-Java model', (k) => java.get(k).err ? { err: java.get(k).err } : { b: b64(java.get(k).model) }],
    ['PBS-Java ext as ObjectNode', (k) => java.get(k).objextErr ? { err: java.get(k).objextErr } : { b: b64(java.get(k).objext) }],
    ['PBS-Java ObjectNode, exact numbers', (k) => java.get(k).exactErr ? { err: java.get(k).exactErr } : { b: b64(java.get(k).exact) }],
    ['Prebid.js JSON.parse', null],
    ['Trusted Server typed', (k) => rust.get(k).typedErr ? { err: rust.get(k).typedErr } : { b: b64(rust.get(k).typed) }],
    ['Trusted Server Value', (k) => rust.get(k).valueErr ? { err: rust.get(k).valueErr } : { b: b64(rust.get(k).value) }],
  ],
  req: [
    ['PBS-Go struct', (k) => go.get(k).err ? { err: go.get(k).err } : { b: b64(go.get(k).struct) }],
    ['PBS-Go marshal (today)', (k) => go.get(k).err ? { err: go.get(k).err } : { b: b64(go.get(k).marshal) }],
    ['PBS-Java model', (k) => java.get(k).err ? { err: java.get(k).err } : { b: b64(java.get(k).model) }],
    ['Trusted Server typed', (k) => rust.get(k).typedErr ? { err: rust.get(k).typedErr } : { b: b64(rust.get(k).typed) }],
  ],
};

mkdirSync(here + 'results', { recursive: true });
let md = '# What each Host model hands the Adapter, per case\n\nGenerated by `compare.mjs`. `=` same as the exact reading of the bytes on the read paths; `≈` differs only in null or zero values of typed fields, so the same once Prebid Core normalizes them (`normalize`); `≠n` n observable differences that remain after normalizing (see `diffs.txt`); `✗` the Host rejects the whole document.\n';
let txt = '';
const tally = {};
for (const kind of ['resp', 'req']) {
  const cases = [...go.keys()].filter((k) => k.startsWith(kind + '/')).sort();
  const hosts = HOSTS[kind];
  md += `\n## ${kind === 'resp' ? 'Bid response' : 'Auction request'}\n\n| case | ${hosts.map((h) => h[0]).join(' | ')} |\n|---|${hosts.map(() => ':-:').join('|')}|\n`;
  for (const k of cases) {
    const bytes = readFileSync(`${here}cases/${k}.json`);
    const ref = project(parseExact(bytes), trees[kind]);
    const cells = [];
    for (const [name, get] of hosts) {
      let r;
      try {
        if (!get) r = { v: project(prebidJs(bytes), trees[kind]) };
        else { const g = get(k); r = g.err ? g : { v: project(parseExact(g.b), trees[kind]) }; }
      } catch (e) { r = { err: 'parse: ' + e.message }; }
      tally[kind + '|' + name] ??= { same: 0, norm: 0, diff: 0, rej: 0 };
      if (r.err) { cells.push('✗'); tally[kind + '|' + name].rej++; txt += `${k} | ${name} | rejects: ${r.err.slice(0, 140)}\n`; continue; }
      const d = []; diff(ref, r.v, '', d);
      if (!d.length) { cells.push('='); tally[kind + '|' + name].same++; continue; }
      const dn = []; diff(normalize(ref), normalize(r.v), '', dn);
      if (!dn.length) { cells.push('≈'); tally[kind + '|' + name].norm++; } else { cells.push('≠' + dn.length); tally[kind + '|' + name].diff++; }
      for (const x of dn.length ? dn : d) txt += `${k} | ${name} | ${dn.length ? '' : '(normalized away) '}${x}\n`;
    }
    md += `| ${k.split('/')[1]} | ${cells.join(' | ')} |\n`;
  }
}
md += '\n## Totals\n\n| document | Host model | same | same once normalized | differs | rejects |\n|---|---|--:|--:|--:|--:|\n';
for (const [k, t] of Object.entries(tally)) { const [kind, name] = k.split('|'); md += `| ${kind} | ${name} | ${t.same} | ${t.norm} | ${t.diff} | ${t.rej} |\n`; }
writeFileSync(here + 'results/matrix.md', md);
writeFileSync(here + 'results/diffs.txt', txt);
console.log(md.split('## Totals')[1]);
