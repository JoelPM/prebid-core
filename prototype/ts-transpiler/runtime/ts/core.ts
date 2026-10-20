// PROTOTYPE Prebid Core runtime, TS side: the helpers generated Shared Adapters call.
// Values are plain JSON values; `undefined` is "absent". Arrays never hold absent elements.
// Erasable TS only (no enums/namespaces) so Node can run it with type stripping.
type J = any;

export const arr = (x: J): J[] => (Array.isArray(x) ? x : []);
const isObj = (x: J) => x !== null && typeof x === 'object' && !Array.isArray(x);
const c = (a: J[]) => a.filter((x) => x !== undefined);

// copy-on-write set: returns a new root; absent `v` deletes; never mutates its input
export function put(o: J, path: string[], v: J, i = 0): J {
  const k = path[i];
  const r = Array.isArray(o) ? o.slice() : { ...o };
  if (i === path.length - 1) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  } else {
    if (v === undefined && !isObj(r[k])) return o;
    r[k] = put(isObj(r[k]) ? r[k] : {}, path, v, i + 1);
  }
  return r;
}
export function get(o: J, path: string[]): J {
  for (const k of path) o = isObj(o) ? o[k] : undefined;
  return o;
}

// numbers only; NaN makes every comparison false
export const n = (x: J) => (typeof x === 'number' ? x : NaN);
export const lk = (t: J, k: J) => (typeof k === 'string' || typeof k === 'number') && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined;
// template interpolation: absent and non-scalars render as ''
export const s = (x: J) => (x == null || typeof x === 'object' ? '' : String(x));

export const str = (x: J) => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : undefined);
export const num = (x: J) => (typeof x === 'number' ? x : typeof x === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(x) ? +x : undefined);
export const int = (x: J) => (typeof x === 'number' ? (Number.isInteger(x) ? x : undefined) : typeof x === 'string' && /^[+-]?\d+$/.test(x) ? +x : undefined);
export const nonempty = (x: J) =>
  x === '' || (Array.isArray(x) && !x.length) || (isObj(x) && !Object.values(x).some((v) => v !== undefined)) ? undefined : x;
export function without(o: J, ...ks: string[]) {
  if (!isObj(o)) return undefined;
  const r = { ...o };
  for (const k of ks) delete r[k];
  return r;
}
export function merge(...os: J[]) {
  const r: J = {};
  for (const o of os) if (isObj(o)) for (const k in o) if (o[k] !== undefined) r[k] = o[k];
  return r;
}
export const first = (l: J) => arr(l).find((x) => x);
export const trim = (x: J) => (typeof x === 'string' ? x.trim() : undefined);
export const lower = (x: J) => (typeof x === 'string' ? x.toLowerCase() : undefined);
export const split = (x: J, sep: J) => (typeof x === 'string' ? x.split(sep) : []);
export const join = (l: J, sep: J) => arr(l).map(str).filter((x) => x !== undefined).join(sep);
export const contains = (x: J, sub: J) => typeof x === 'string' && x.includes(sub);
export const len = (x: J) => (Array.isArray(x) ? x.length : isObj(x) ? Object.keys(x).length : undefined);
export const max = (a: J, b: J) => (typeof a === 'number' && typeof b === 'number' ? Math.max(a, b) : undefined);
export const keys = (o: J) => (isObj(o) ? Object.keys(o) : []);
export const entries = (o: J) => (isObj(o) ? Object.entries(o).map(([k, v]) => ({ k, v })) : []);
export function fromEntries(l: J) {
  const r: J = {};
  for (const e of arr(l)) if (typeof e?.k === 'string' && e.v !== undefined) r[e.k] = e.v;
  return r;
}
export const type = (x: J) =>
  x === undefined ? undefined : x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x === 'boolean' ? 'bool' : typeof x;
export function json(x: J) {
  try {
    return typeof x === 'string' ? JSON.parse(x) : undefined;
  } catch {
    return undefined;
  }
}
export const stringify = (x: J) => (x === undefined ? undefined : JSON.stringify(x));
// macros: map drops absent results so arrays never hold absent
export const map = (l: J, f: (x: J) => J) => c(arr(l).map(f));
export const arrLit = c;
