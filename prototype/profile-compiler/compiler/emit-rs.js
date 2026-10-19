// PROTOTYPE. Rust back end: one module per Shared Adapter per side, calling runtime/rs (prebid_core_rt).
// Every runtime call takes `&mut Doc`, so expressions are emitted as nested blocks that bind each
// operand to a local first. Short-circuit operators become `if`s, so evaluation order matches JS.
const q = JSON.stringify;
const escContent = (s) => q(s).slice(1, -1); // JSON-escaped string content, as a Rust literal body
const rsStr = (s) => q(escContent(s)); // that content as a Rust string literal

const FN = { str: 'str_', num: 'num_', type: 'type_', fromEntries: 'from_entries' };
const BOOL_FN = ['contains'];

let tmp = 0;
const t = () => `t${tmp++}`;

function ex(e, sc) {
  const x = (e) => ex(e, sc);
  switch (e.k) {
    case 'lit':
      if (e.v === null) return 'rt::NULL';
      if (typeof e.v === 'boolean') return e.v ? 'rt::TRUE' : 'rt::FALSE';
      if (typeof e.v === 'number') return `d.num(${Number.isInteger(e.v) ? e.v + '.0' : e.v})`;
      return `d.lit(${rsStr(e.v)})`;
    case 'absent': return 'rt::ABSENT';
    case 'keep': throw new Error('keep is only valid as the value (or a branch) of a set rule');
    case 'var': {
      const v = sc.vars[e.name];
      if (!v) throw new Error(`unknown name ${e.name}`);
      return v;
    }
    case 'get': { const a = t(); return `{ let ${a} = ${x(e.e)}; d.get(${a}, ${q(e.key)}) }`; }
    case 'at': { const a = t(); return `{ let ${a} = ${x(e.e)}; d.at(${a}, ${e.i}) }`; }
    case 'index': {
      if (e.e.k !== 'obj' || !e.e.entries.every(([, v]) => v.k === 'lit' && typeof v.v === 'string')) throw new Error('index: only lookup tables of string literals are supported');
      const a = t();
      return `{ let ${a} = ${x(e.i)}; d.lookup(${a}, &[${e.e.entries.map(([k, v]) => `(${rsStr(k)}, ${rsStr(v.v)})`).join(', ')}]) }`;
    }
    case 'not': return `{ let b = !${truthy(e.e, sc)}; d.bool(b) }`;
    case 'cond': return `if ${truthy(e.c, sc)} { ${x(e.a)} } else { ${x(e.b)} }`;
    case 'bin': {
      const [a, b] = [t(), t()];
      switch (e.op) {
        case '??': return `{ let ${a} = ${x(e.l)}; if d.nullish(${a}) { ${x(e.r)} } else { ${a} } }`;
        case '||': return `{ let ${a} = ${x(e.l)}; if d.truthy(${a}) { ${a} } else { ${x(e.r)} } }`;
        case '&&': return `{ let ${a} = ${x(e.l)}; if !d.truthy(${a}) { ${a} } else { ${x(e.r)} } }`;
      }
      return `{ let r = ${boolEx(e, sc)}; d.bool(r) }`;
    }
    case 'call': {
      const args = e.args.map(() => t());
      const binds = e.args.map((a, i) => `let ${args[i]} = ${x(a)};`).join(' ');
      if (e.fn === 'without') return `{ ${binds} d.without(${args[0]}, &[${e.args.slice(1).map((a) => q(a.v)).join(', ')}]) }`;
      if (e.fn === 'merge') return `{ ${binds} d.merge(&[${args.join(', ')}]) }`;
      return `{ ${binds} d.${FN[e.fn] || e.fn}(${args.join(', ')}) }`;
    }
    case 'macro': {
      const [src, out, it] = [t(), t(), `x_${e.v}`];
      const isc = { vars: { ...sc.vars, [e.v]: it } };
      // walk the list's links: no Vec per iteration (only pushes to a different, new array)
      const loop = (body) => `let mut ${it} = d.first_item(${src}); while ${it} != 0 { ${body} ${it} = d.next_item(${it}); }`;
      if (e.name === 'map') return `{ let ${src} = ${x(e.recv)}; let ${out} = d.arr(); ${loop(`{ let r = ${ex(e.body, isc)}; d.push(${out}, r); }`)} ${out} }`;
      if (e.name === 'filter') return `{ let ${src} = ${x(e.recv)}; let ${out} = d.arr(); ${loop(`if ${truthy(e.body, isc)} { d.push(${out}, ${it}); }`)} ${out} }`;
      return `{ let ${src} = ${x(e.recv)}; let mut r = false; ${loop(`if ${truthy(e.body, isc)} { r = true; break; }`)} d.bool(r) }`;
    }
    case 'obj': {
      const o = t();
      return `{ let ${o} = d.obj(); ${e.entries.map(([k, v]) => `{ let v = ${x(v)}; d.set(${o}, ${q(k)}, v); }`).join(' ')} ${o} }`;
    }
    case 'arr': {
      const a = t();
      return `{ let ${a} = d.arr(); ${e.items.map((i) => `{ let v = ${x(i.e)}; d.${i.spread ? 'extend' : 'push'}(${a}, v); }`).join(' ')} ${a} }`;
    }
    case 'tmpl': {
      const s = t();
      return `{ let mut ${s} = String::new(); ${e.parts.map((p) => (typeof p === 'string' ? (p ? `${s}.push_str(${q(p)});` : '') : `{ let v = ${x(p)}; d.tmpl(&mut ${s}, v); }`)).join(' ')} d.new_str(&${s}) }`;
    }
  }
  throw new Error('unhandled ' + e.k);
}

// a Rust bool expression
function boolEx(e, sc) {
  const x = (e) => ex(e, sc);
  if (e.k === 'bin' && ['==', '!=', '<', '>', '<=', '>='].includes(e.op)) {
    const [a, b] = [t(), t()];
    const loose = (e.l.k === 'lit' && e.l.v === null) || (e.r.k === 'lit' && e.r.v === null);
    let r;
    if ((e.op === '==' || e.op === '!=') && loose) {
      const other = e.l.k === 'lit' && e.l.v === null ? e.r : e.l;
      r = `{ let ${a} = ${x(other)}; d.nullish(${a}) }`;
    } else {
      const f = { '==': 'eq', '!=': 'eq', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge' }[e.op];
      r = `{ let ${a} = ${x(e.l)}; let ${b} = ${x(e.r)}; d.${f}(${a}, ${b}) }`;
    }
    return e.op === '!=' ? `!${r}` : r;
  }
  return truthy(e, sc);
}
function truthy(e, sc) {
  if (e.k === 'not') return `!${truthy(e.e, sc)}`;
  if (e.k === 'bin' && e.op === '&&') return `(${truthy(e.l, sc)} && ${truthy(e.r, sc)})`;
  if (e.k === 'bin' && e.op === '||') return `(${truthy(e.l, sc)} || ${truthy(e.r, sc)})`;
  if (e.k === 'bin' && ['==', '!=', '<', '>', '<=', '>='].includes(e.op)) return boolEx(e, sc);
  if (e.k === 'call' && BOOL_FN.includes(e.fn)) { const a = t(); return `{ let ${a} = ${ex(e, sc)}; d.truthy(${a}) }`; }
  const a = t();
  return `{ let ${a} = ${ex(e, sc)}; d.truthy(${a}) }`;
}

const hasKeep = (e) => e.k === 'keep' || (e.k === 'cond' && (hasKeep(e.a) || hasKeep(e.b)));

// a set rule against the output `target`; `write(valueExpr)` produces the statement
function setRs(target, path, e, mode, sc, write) {
  const keys = path.map((s) => s.key);
  const guards = [];
  path.forEach((s, i) => s.opt && guards.push(`{ let g = d.get_path(${target}, &[${keys.slice(0, i + 1).map(q).join(', ')}]); !d.nullish(g) }`));
  if (mode === 'add') guards.push(`d.get_path(${target}, &[${keys.map(q).join(', ')}]) == rt::ABSENT`);
  const body = (e) => {
    if (e.k === 'keep') return '';
    if (e.k === 'cond' && hasKeep(e)) return `if ${truthy(e.c, sc)} { ${body(e.a)} } else { ${body(e.b)} }`;
    return write(keys, ex(e, sc));
  };
  const b = body(e);
  return guards.length ? `if ${guards.join(' && ')} { ${b} }\n` : b + '\n';
}

function lets(ls, sc) {
  let s = '';
  for (const [n, e] of ls) {
    const v = `v_${n}`;
    s += `let ${v} = ${ex(e, sc)};\n`;
    sc.vars[n] = v;
  }
  return s;
}

export function emitRs(m) {
  tmp = 0;
  const putOut = (keys, v) => `{ let v = ${v}; d.put_mut(o, &[${keys.map(q).join(', ')}], v); }`;
  let s = `// GENERATED by the PROTOTYPE Definition Compiler from defs/${m.bidder}.yaml - do not edit.\n`;
  s += `#![allow(unused_variables, unused_mut, unused_braces, unused_parens, non_snake_case, clippy::all)]\n`;
  s += `use prebid_core_rt::{self as rt, Doc, V, ReqOut, BidsOut, BidAnnot};\n\n`;
  s += `pub const BIDDER: &str = ${q(m.bidder)};\npub const ENDPOINT: &str = ${q(m.endpoint)};\n\n`;

  // ---- make_requests ----
  s += `pub fn make_requests(d: &mut Doc, req: V) -> ReqOut {\n`;
  s += `let mut errs: Vec<String> = Vec::new(); let imps = d.arr(); let params = d.arr(); let mut ids: Vec<String> = Vec::new();\n`;
  s += `let imp_list = { let a = d.get(req, "imp"); d.items(a) };\nfor imp in imp_list {\n`;
  s += `let p = { let a = d.get(imp, "ext"); d.get(a, "bidder") };\n`;
  const isc = { vars: { req: 'req', imp: 'imp', p: 'p' } };
  s += lets(m.imp.lets, isc);
  for (const [c, msg] of m.imp.checks) s += `if ${truthy(c, isc)} { let e = ${ex(msg, isc)}; errs.push(d.to_string(e)); continue; }\n`;
  for (const dr of m.imp.drops) s += `if ${truthy(dr, isc)} { continue; }\n`;
  s += `let o = d.own(imp);\n`;
  for (const [p, e, mode] of m.imp.sets) s += setRs('o', p, e, mode, isc, putOut);
  s += `let id = d.get(o, "id"); ids.push(d.to_string(id)); d.push(imps, o); d.push(params, p);\n}\n`;
  s += `if ids.is_empty() { return ReqOut { body: None, imp_ids: ids, errs }; }\n`;
  const rsc = { vars: { req: 'req', imps: 'imps', params: 'params' } };
  s += lets(m.request.lets, rsc);
  s += `let o = d.own(req); d.put_mut(o, &["imp"], imps);\n`;
  for (const [p, e, mode] of m.request.sets) s += setRs('o', p, e, mode, rsc, putOut);
  s += `ReqOut { body: Some(d.to_json(o)), imp_ids: ids, errs }\n}\n\n`;

  // ---- make_bids ----
  s += `pub fn make_bids(d: &mut Doc, req: V, resp: V) -> BidsOut {\n`;
  s += `let mut errs: Vec<String> = Vec::new(); let mut bids: Vec<BidAnnot> = Vec::new();\n`;

  s += `let seatbids = { let a = d.get(resp, "seatbid"); d.items(a) };\n`;
  s += `for seatbid in seatbids { let bid_list = { let a = d.get(seatbid, "bid"); d.items(a) }; for bid in bid_list {\n`;
  // the request imp a bid answers is looked up (and the request parsed) only if a rule reads it
  s += `let mut imp_cell: Option<V> = None;\n`;
  const impLazy = `{ if imp_cell.is_none() { let id = d.get(bid, "impid"); let l = { let a = d.get(req, "imp"); d.items(a) }; let mut f = rt::ABSENT; for i in l { let iid = d.get(i, "id"); if d.eq(iid, id) { f = i; break; } } imp_cell = Some(f); } imp_cell.unwrap() }`;
  const bsc = { vars: { req: 'req', resp: 'resp', seatbid: 'seatbid', bid: 'bid', imp: impLazy } };
  s += lets(m.bid.lets, bsc);
  const drop = `bids.push(BidAnnot { keep: false, typ: String::new(), seat: String::new(), deal_priority: 0.0, video: vec![], meta: vec![], overrides: vec![] }); continue;`;
  for (const [c, msg] of m.bid.checks) s += `if ${truthy(c, bsc)} { let e = ${ex(msg, bsc)}; errs.push(d.to_string(e)); ${drop} }\n`;
  for (const [c, msg] of m.bid.warns) s += `if ${truthy(c, bsc)} { let e = ${ex(msg, bsc)}; errs.push(d.to_string(e)); }\n`;
  for (const dr of m.bid.drops) s += `if ${truthy(dr, bsc)} { ${drop} }\n`;
  // bid `set` rules become overrides the Host merges into its own parsed bid
  s += `let ov = d.obj();\n`;
  for (const [p, e, mode] of m.bid.sets) {
    if (p.length !== 1 || p[0].opt) throw new Error('prototype: bid set rules must be top-level fields');
    s += setRs('bid', p, e, mode, bsc, (keys, v) => `{ let v = ${v}; d.set_or_null(ov, ${q(keys[0])}, v); }`);
  }
  const f = m.bidFields;
  const field = (k) => (f[k] ? ex(f[k], bsc) : 'rt::ABSENT');
  s += `let typ = ${field('type')}; let seat = ${field('seat')}; let dp = ${field('dealPriority')}; let video = ${field('video')}; let meta = ${field('meta')};\n`;
  s += `bids.push(BidAnnot { keep: true, typ: d.to_string(typ), seat: d.to_string(seat), deal_priority: d.f64(dp).unwrap_or(0.0), video: d.kv_slot(video), meta: d.kv_slot(meta), overrides: d.slot(ov) });\n}}\n`;
  const psc = { vars: { req: 'req', resp: 'resp' } };
  s += `let cur = ${ex(m.response.currency, psc)}; let paapi = ${ex(m.response.paapi, psc)};\n`;
  s += `BidsOut { bids, currency: d.to_string(cur), paapi: d.slot(paapi), errs }\n}\n`;
  return s;
}
