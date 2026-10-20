// Prints values.json as a table: instance | PBS-Go | PBS-Java | what JS sees | what serde_json sees.
// node values-print.mjs values.json out/values-go.json out/values-java.json out/values-js.json out/values-rust.json
import fs from "node:fs";
const [cases, go, java, js, rust] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, "utf8")));
const cell = s => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, "\\n").slice(0, 110);
const show = s => JSON.stringify(s).replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
for (const c of cases) {
  console.log(`\n### ${c.name}\n\n| instance | PBS-Go | PBS-Java | JS sees | serde_json sees |\n|---|---|---|---|---|`);
  c.instances.forEach((raw, i) => {
    const long = raw.length > 60 && typeof JSON.parse(raw) === "string";
    const inst = long ? `"${JSON.parse(raw).slice(0, 12)}…" (${JSON.parse(raw).length} chars)` : show(raw).slice(1, -1).replace(/\\"/g, '"');
    console.log(`| \`${cell(inst)}\` | ${cell(go[c.name][i])} | ${cell(java[c.name][i])} | ${cell(js[c.name][i])} | ${cell(rust[c.name][i])} |`);
  });
}
