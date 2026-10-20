// What Prebid.js's JSON path does with each case in ../cases.tsv (Node's V8 = the browser's JSON).
// Bidder responses arrive via fetch/XHR, whose text() decodes UTF-8 with replacement (TextDecoder,
// non-fatal); then JSON.parse. Outgoing bodies are JSON.stringify'd and sent as a string, which
// fetch encodes as UTF-8 (USVString: lone surrogates become U+FFFD).
import { readFileSync } from 'node:fs';

const units = (s) => '[' + [...Array(s.length).keys()].map((i) => {
  const c = s.charCodeAt(i);
  return c >= 0x20 && c < 0x7f ? s[i] : '<' + c.toString(16).padStart(4, '0') + '>';
}).join('') + ']';
const show = (b) => [...b].map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '\\x' + c.toString(16).padStart(2, '0'))).join('');

for (const line of readFileSync(new URL('../cases.tsv', import.meta.url), 'utf8').trim().split('\n')) {
  const [name, hex] = line.split('\t');
  const doc = Buffer.from(hex, 'hex');
  console.log(`== ${name}  ${show(doc)}`);
  const text = new TextDecoder().decode(doc);
  console.log(`  text() (TextDecoder)        ${units(text)}`);
  const v = JSON.parse(text);
  console.log(`  JSON.parse .s               ${units(v.s)}  isWellFormed=${v.s.isWellFormed()} length=${v.s.length} [...s].length=${[...v.s].length}`);
  const out = JSON.stringify(v);
  console.log(`  JSON.stringify              ${units(out)}`);
  console.log(`  fetch body (TextEncoder)    ${show(new TextEncoder().encode(out))}`);
  console.log(`  raw string sent, no JSON    ${show(new TextEncoder().encode(v.s))}`);
  try { encodeURIComponent(v.s); console.log(`  encodeURIComponent          ok ${encodeURIComponent(v.s)}`); }
  catch (e) { console.log(`  encodeURIComponent          ERR ${e.name}: ${e.message}`); }
  // PubMatic-style native adm: the adm text holds JSON whose string holds the case
  const adm = '{"native":' + text + '}';
  const nat = JSON.parse(adm);
  console.log(`  JSON.stringify(JSON.parse(adm).native) ${units(JSON.stringify(nat.native))}`);
}

console.log('== how lone surrogates arise in JS');
const t = 'Big sale \u{1F600}\u{1F600}';
for (const n of [10, 11]) {
  const cut = t.substring(0, n);
  console.log(`  substring(0,${n})  ${units(cut)}  wellFormed=${cut.isWellFormed()}  stringify=${units(JSON.stringify(cut))}`);
}
console.log(`  slice(-1) of "a\\u{1F600}"  ${units('a\u{1F600}'.slice(-1))}`);
console.log(`  "\\u{1F600}"[0]          ${units('\u{1F600}'[0])}`);
console.log(`  toWellFormed()          ${units('\ud800A'.toWellFormed())}`);

// PubMatic (adapter definition / Prebid.js): out.adm = JSON.stringify(JSON.parse(bid.adm).native)
for (const line of readFileSync(new URL('../adm.tsv', import.meta.url), 'utf8').trim().split('\n')) {
  const [name, hex] = line.split('\t');
  const doc = Buffer.from(hex, 'hex');
  const bid = JSON.parse(new TextDecoder().decode(doc));
  bid.adm = JSON.stringify(JSON.parse(bid.adm).native);
  console.log(`== adm ${name}\n  in  ${show(doc)}\n  out ${show(new TextEncoder().encode(JSON.stringify(bid)))}`);
}
