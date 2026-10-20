// Prints, per pattern, the strings on which the engines disagree (or which engines refuse to compile it).
// node compare.mjs cases.json out/js-u.json out/rust.json out/go.json out/java.json [out/js.json]
import fs from "node:fs";
const [casesPath, ...outs] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const runs = outs.map(f => ({ name: f.replace(/^.*\/|\.json$/g, ""), ...JSON.parse(fs.readFileSync(f, "utf8")) }));
for (const r of runs) console.log(`# ${r.name}: ${r.engine}`);
const show = s => JSON.stringify(s).replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).slice(0, 40);
let agree = 0, total = 0;
for (const group of ["catalogue", "probes"]) {
  console.log(`\n## ${group}`);
  for (const p of cases[group]) {
    total++;
    const res = runs.map(r => r.results[p]);
    const errs = res.map((x, i) => (x.error ? `${runs[i].name}: ${x.error.slice(0, 70)}` : null)).filter(Boolean);
    const lines = [];
    if (errs.length) lines.push(`  compile error in ${errs.length}/${runs.length}: ${errs.join(" | ")}`);
    const ok = res.map((x, i) => [x, runs[i].name]).filter(([x]) => x.m);
    cases.strings.forEach((s, j) => {
      const v = ok.map(([x, n]) => `${n}=${x.m[j]}`);
      if (new Set(ok.map(([x]) => x.m[j])).size > 1) lines.push(`  ${show(s)}: ${v.join(" ")}`);
    });
    if (!lines.length) { agree++; continue; }
    console.log(`${JSON.stringify(p)}`);
    lines.forEach(l => console.log(l));
  }
}
console.log(`\n${agree}/${total} patterns: every engine compiles and agrees on every string`);
