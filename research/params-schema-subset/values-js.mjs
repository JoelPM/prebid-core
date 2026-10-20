// What a TS validator would be handed for each values.json instance: JSON.parse's value, and for strings
// both .length (UTF-16 units) and the code-point count. node values-js.mjs values.json > out/values-js.json
import fs from "node:fs";
const out = {};
for (const c of JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) {
  out[c.name] = c.instances.map(raw => {
    let v;
    try { v = JSON.parse(raw); } catch (e) { return `parse error: ${e.message}`; }
    if (typeof v === "number") return `number ${Object.is(v, -0) ? "-0" : String(v)} isInteger=${Number.isInteger(v)}`;
    if (typeof v === "string") return `string length=${v.length} codePoints=${[...v].length}`;
    return `${Array.isArray(v) ? "array" : typeof v} ${JSON.stringify(v)}`;
  });
}
console.log(JSON.stringify(out));
