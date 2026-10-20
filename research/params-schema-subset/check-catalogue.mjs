// Checks every PBS-Go and PBS-Java bidder-params schema against the proposed params-schema subset and
// lists the files that fall outside it, with the reasons. node check-catalogue.mjs > out/outside.txt
import fs from "node:fs";
import path from "node:path";
import { classify } from "./subset.mjs";

const TREES = {
  go: "/Users/joel.meyer/Developer/work/prebid/prebid-server/static/bidder-params",
  java: "/Users/joel.meyer/Developer/work/prebid/prebid-server-java/src/main/resources/static/bidder-params",
};
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const ANNOTATIONS = new Set(["title", "description"]);
const REJECTED = {
  $ref: "not needed; resolution rules differ", definitions: "not needed", id: "not needed", $id: "not needed",
  default: "never applied by any validator; put defaults in the imp Phase",
  const: "draft-06: both PBS validators ignore it under draft-04", examples: "draft-06",
  exclusiveMinimum: "draft-04 boolean vs draft-06 number forms; numeric form fails gojsonschema schema load",
  exclusiveMaximum: "as exclusiveMinimum", multipleOf: "decimal divisor is inexact in f64 (TS)",
  patternProperties: "regex on keys: not needed", uniqueItems: "deep equality rules: not needed",
  minProperties: "not needed", maxProperties: "not needed", additionalItems: "tuple form: not needed",
  if: "draft-07: ignored under draft-04", then: "draft-07", else: "draft-07", $defs: "not needed",
  dependentRequired: "2019-09", dependentSchemas: "2019-09", prefixItems: "2020-12", contains: "draft-06",
  propertyNames: "draft-06",
};
const ALLOWED = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "minLength", "maxLength", "minimum", "maximum", "enum", "pattern", "format", "anyOf", "oneOf", "allOf", "not", "dependencies"]);
const sig = n => String(n).replace(/^-|e.*$|\./g, "").replace(/^0+/, "").length;

function check(node, at, out) {
  if (typeof node !== "object" || node === null || Array.isArray(node)) { out.push(`${at}: schema is not an object`); return; }
  for (const [k, v] of Object.entries(node)) {
    const here = `${at}/${k}`;
    if (ANNOTATIONS.has(k)) continue;
    if (k === "$schema") { if (at === "" && v !== "http://json-schema.org/draft-04/schema#") out.push(`$schema ${v} (subset is draft-04)`); continue; }
    if (k in REJECTED) { out.push(`${here}: ${k} rejected (${REJECTED[k]})`); continue; }
    if (!ALLOWED.has(k)) { out.push(`${here}: unknown keyword ${k} (ignored by validators)`); continue; }
    switch (k) {
      case "type": for (const t of [v].flat()) if (!TYPES.has(t)) out.push(`${here}: type ${t}`); break;
      case "properties": for (const [pk, pv] of Object.entries(v)) check(pv, `${at}/properties/${pk}`, out); break;
      case "additionalProperties": if (typeof v === "object") check(v, here, out); break;
      case "items": if (Array.isArray(v)) out.push(`${here}: tuple items rejected`); else check(v, here, out); break;
      case "anyOf": case "oneOf": case "allOf": v.forEach((b, i) => check(b, `${here}/${i}`, out)); break;
      case "not": check(v, here, out); break;
      case "dependencies": for (const [dk, dv] of Object.entries(v)) if (!Array.isArray(dv)) check(dv, `${here}/${dk}`, out); break;
      case "enum": for (const e of v) if (typeof e === "number" || (typeof e === "object" && e !== null)) out.push(`${here}: enum value ${JSON.stringify(e)} (only strings, booleans, null)`); break;
      case "minimum": case "maximum": if (sig(v) > 15) out.push(`${here}: bound ${v} has over 15 significant digits`); break;
      case "format": if (v !== "uuid" && v !== "hostname") out.push(`${here}: format ${v}`); break;
      case "pattern": {
        const c = classify(v);
        if (c.verdict === "reject") out.push(`${here}: pattern ${JSON.stringify(v)} rejected: ${c.reason}`);
        break;
      }
    }
  }
}

const pick = new Set(["openx", "pubmatic"]);
for (const [host, dir] of Object.entries(TREES)) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  const outside = [];
  const ruled = {};
  for (const f of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const out = [];
    check(schema, "", out);
    // property names that sit beside `properties` (malformed: pangle in Java) are unknown keywords
    if (out.length) outside.push([f.slice(0, -5), out]);
    const walk = n => { if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) { if (k === "pattern" && typeof v === "string") { const c = classify(v); if (c.verdict === "rule") (ruled[f.slice(0, -5)] ??= new Set()).add(`${JSON.stringify(v)} (${c.rules.join(" ")})`); } walk(v); } };
    walk(schema);
  }
  console.log(`== ${host}: ${files.length - outside.length}/${files.length} files inside the subset; ${outside.length} outside`);
  for (const [b, out] of outside) console.log(`  ${pick.has(b) ? "**" + b + "**" : b}: ${out.join("; ")}`);
  console.log(`  patterns inside the subset only with a translation rule: ${Object.keys(ruled).length} files`);
  for (const [b, r] of Object.entries(ruled)) console.log(`    ${b}: ${[...r].join(", ")}`);
  for (const b of pick) console.log(`  ${b}: ${outside.find(o => o[0] === b) ? "OUTSIDE" : "inside"}`);
}
