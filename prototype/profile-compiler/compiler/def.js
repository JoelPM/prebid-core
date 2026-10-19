// PROTOTYPE. Loads an Adapter Definition (YAML), validates its shape, parses every expression and
// builds the per-side model the back ends emit from: core + Client Extension, or core + Server Extension.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';
import { parse, walk } from './el.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const schema = JSON.parse(fs.readFileSync(path.join(here, '../defs/definition.schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile(schema);

// A YAML value is an expression: strings parse as EL, mappings become object literals, YAML null
// (`~`) means absent (delete when written).
function expr(v) {
  if (v === null || v === undefined) return { k: 'absent' };
  if (typeof v === 'object' && !Array.isArray(v)) return { k: 'obj', entries: Object.entries(v).map(([k, x]) => [k, expr(x)]) };
  if (typeof v === 'string') return parse(v);
  return { k: 'lit', v };
}

// set keys are dotted paths; a segment ending in `?` is written only if it already exists in the output
function setPath(key) {
  return key.split('.').map((s) => (s.endsWith('?') ? { key: s.slice(0, -1), opt: true } : { key: s, opt: false }));
}

function section(sec = {}) {
  return {
    lets: Object.entries(sec.let || {}).map(([n, v]) => [n, expr(v)]),
    checks: (sec.check || []).map(([c, m]) => [parse(c), parse(m)]),
    warns: (sec.warn || []).map(([c, m]) => [parse(c), parse(m)]),
    drops: sec.drop ? [parse(sec.drop)] : [],
    sets: Object.entries(sec.set || {}).map(([k, v]) => [setPath(k), expr(v)]),
  };
}

const BID_FIELDS = ['type', 'seat', 'dealPriority', 'video', 'meta'];

export function load(file) {
  const def = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (!validate(def)) throw new Error(`${file}: ${JSON.stringify(validate.errors, null, 1)}`);
  const core = {
    imp: section(def.core.imp), request: section(def.core.request), bid: section(def.core.bid),
    bidFields: Object.fromEntries(BID_FIELDS.filter((f) => def.core.bid?.[f] !== undefined).map((f) => [f, expr(def.core.bid[f])])),
    response: { currency: expr(def.core.response?.currency), paapi: expr(def.core.response?.paapi) },
  };
  const sides = {};
  for (const side of ['client', 'server']) {
    const ext = def[side] || {};
    const m = structuredClone(core);
    for (const ph of ['imp', 'request', 'bid']) {
      const e = section(ext[ph]);
      for (const [p, v] of e.sets) {
        // Extensions only add: no deletes, no `keep`, and (enforced at runtime) never overwrite a field
        // the core output already has.
        walk(v, (n) => { if (n.k === 'keep') throw new Error(`${side}.${ph}: an Extension cannot use keep`); });
        if (v.k === 'absent') throw new Error(`${side}.${ph}.set ${p.map((s) => s.key).join('.')}: an Extension cannot delete`);
        m[ph].sets.push([p, v, 'add']);
      }
      if (e.checks.length || e.warns.length) throw new Error(`${side}.${ph}: an Extension cannot add errors`);
      m[ph].lets.push(...e.lets);
      m[ph].drops.push(...e.drops);
      for (const f of BID_FIELDS) if (ph === 'bid' && ext.bid?.[f] !== undefined) {
        if (core.bidFields[f]) throw new Error(`${side}.bid.${f}: already set by core`);
        m.bidFields[f] = expr(ext.bid[f]);
      }
    }
    sides[side] = { bidder: def.bidder, endpoint: ext.endpoint || def.endpoint, ...m };
  }
  return { def, core, sides };
}
