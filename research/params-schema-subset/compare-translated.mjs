// Checks subset.mjs's translations: each engine ran its own translation of every in-subset pattern
// (out/cases-<engine>.json); every engine must agree with ECMA-262 (node, u flag) on every string.
// node compare-translated.mjs cases.json out/tr-js.json out/tr-rust.json out/tr-go.json out/tr-java.json
import fs from "node:fs";
const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
const [casesPath, ...outs] = process.argv.slice(2);
const { strings } = read(casesPath);
const index = read("out/cases-index.json");
const runs = outs.map(f => {
  const name = f.replace(/^.*\/tr-|\.json$/g, "");
  const translated = read(`out/cases-${name}.json`).catalogue;
  return { name, engine: read(f).engine, at: i => read(f).results[translated[i]] };
});
let bad = 0;
index.forEach((p, i) => {
  const res = runs.map(r => r.at(i));
  res.forEach((x, k) => { if (x.error) { bad++; console.log(`${JSON.stringify(p)}: ${runs[k].name} cannot compile its translation: ${x.error}`); } });
  strings.forEach((s, j) => {
    const v = res.map(x => x.m?.[j]);
    if (new Set(v.filter(Boolean)).size > 1) { bad++; console.log(`${JSON.stringify(p)} on ${JSON.stringify(s)}: ${runs.map((r, k) => `${r.name}=${v[k]}`).join(" ")}`); }
  });
});
console.log(`${index.length} in-subset patterns x ${strings.length} strings, ${runs.map(r => r.engine).join("; ")}: ${bad} disagreements`);
