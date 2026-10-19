// PROTOTYPE: how much of each Definition is declarative mapping vs. escape hatch (measure 4 of map #1
// "Which Prebid Core forms go to prototype?"), and how big it is next to the Hand-written Adapters.
// A rule is one let / check / warn / set / bid field / response field. Classification is el.js
// `classify`: paths, literals, ??/||/&&/!, ==/!=, conditionals, object/array literals, lookup tables
// and the casts/structural helpers (str num int nonempty without merge first) are mapping; string
// functions, comparisons, arithmetic, spreads, templates in values, json/stringify, and the
// map/filter/some macros are escape hatch. Error-message templates are not counted.
//
// Usage: node compiler/stats.js defs/openx.yaml defs/pubmatic.yaml [--json]
import fs from 'node:fs';
import { load } from './def.js';
import { classify, size, walk } from './el.js';

function rules(core) {
  const out = [];
  const add = (where, e) => out.push({ where, e });
  for (const ph of ['imp', 'request', 'bid']) {
    for (const [n, e] of core[ph].lets) add(`${ph}.let.${n}`, e);
    for (const [c] of core[ph].checks) add(`${ph}.check`, c);
    for (const [c] of core[ph].warns) add(`${ph}.warn`, c);
    for (const [p, e] of core[ph].sets) add(`${ph}.set.${p.map((s) => s.key).join('.')}`, e);
  }
  for (const [f, e] of Object.entries(core.bidFields)) add(`bid.${f}`, e);
  for (const [f, e] of Object.entries(core.response)) if (e.k !== 'absent') add(`response.${f}`, e);
  return out.map((r) => ({ ...r, cls: classify(r.e), lenient: classify(r.e, { lenient: true }), nodes: size(r.e) }));
}

const nonBlank = (s, comment) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith(comment)).length;
const HAND = {
  openx: { 'PBS-Go': '../../../../prebid-server/adapters/openx/openx.go', 'Prebid.js': '../../../../Prebid.js/modules/openxBidAdapter.js' },
  pubmatic: { 'PBS-Go': '../../../../prebid-server/adapters/pubmatic/pubmatic.go', 'Prebid.js': '../../../../Prebid.js/modules/pubmaticBidAdapter.js' },
};
const javaPath = (b) => {
  const base = new URL(`../../../../prebid-server-java/src/main/java/org/prebid/server/bidder/${b}/`, import.meta.url).pathname;
  return fs.existsSync(base) ? fs.readdirSync(base).filter((f) => f.endsWith('Bidder.java')).map((f) => base + f)[0] : null;
};

const report = [];
for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const { def, core, sides } = load(f);
  const rs = rules(core);
  const ext = { client: sides.client.imp.sets.length + sides.client.request.sets.length - core.imp.sets.length - core.request.sets.length,
    server: sides.server.imp.sets.length + sides.server.request.sets.length - core.imp.sets.length - core.request.sets.length };
  const hatch = rs.filter((r) => r.cls === 'hatch');
  const tot = rs.reduce((a, r) => a + r.nodes, 0), hn = hatch.reduce((a, r) => a + r.nodes, 0);
  const macros = [], fns = new Set();
  for (const r of hatch) walk(r.e, (n) => { if (n.k === 'macro') macros.push(`${n.name}`); if (n.k === 'call') fns.add(n.fn); });
  const yamlSrc = fs.readFileSync(f, 'utf8');
  const sizes = { Definition: nonBlank(yamlSrc, '#') };
  for (const [h, p] of Object.entries(HAND[def.bidder] || {})) {
    const abs = new URL(p, import.meta.url).pathname;
    if (fs.existsSync(abs)) sizes[h] = nonBlank(fs.readFileSync(abs, 'utf8'), '//');
  }
  const jp = javaPath(def.bidder);
  if (jp) sizes['PBS-Java'] = nonBlank(fs.readFileSync(jp, 'utf8'), '//');
  const len = rs.filter((r) => r.lenient === 'hatch');
  report.push({ bidder: def.bidder, rules: rs.length, hatchRules: hatch.length, lenientHatchRules: len.length, lenientHatchNodes: len.reduce((a, r) => a + r.nodes, 0), nodes: tot, hatchNodes: hn, ext, macros, fns: [...fns].sort(), sizes,
    hatch: hatch.map((r) => r.where) });
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
else for (const r of report) {
  console.log(`\n${r.bidder}: ${r.rules} core rules, ${r.hatchRules} escape hatch (${Math.round((100 * r.hatchRules) / r.rules)}% of rules, ${Math.round((100 * r.hatchNodes) / r.nodes)}% of expression nodes)`);
  console.log(`  lenient (numeric comparisons with a literal are declarative): ${r.lenientHatchRules} escape hatch (${Math.round((100 * r.lenientHatchRules) / r.rules)}% of rules, ${Math.round((100 * r.lenientHatchNodes) / r.nodes)}% of nodes)`);
  console.log(`  Extensions: client +${r.ext.client} set rules, server +${r.ext.server}`);
  console.log(`  escape-hatch rules: ${r.hatch.join(', ') || '-'}`);
  console.log(`  escape-hatch functions: ${r.fns.join(' ') || '-'}; macros: ${r.macros.length ? r.macros.join(' ') : '-'}`);
  console.log(`  non-blank, non-comment lines: ${Object.entries(r.sizes).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
}
