// ECMAScript RegExp as a generated TS validator would call it: new RegExp(p, flags).test(s).
// node js.mjs cases.json u > out/js-u.json ; node js.mjs cases.json "" > out/js.json
import fs from "node:fs";
const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const flags = process.argv[3] ?? "u";
const results = {};
for (const p of [...cases.catalogue, ...cases.probes]) {
  try {
    const re = new RegExp(p, flags);
    results[p] = { m: cases.strings.map(s => (re.test(s) ? "1" : "0")).join("") };
  } catch (e) {
    results[p] = { error: e.message };
  }
}
console.log(JSON.stringify({ engine: `node ${process.version} RegExp flags="${flags}"`, results }));
