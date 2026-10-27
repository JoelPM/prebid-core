// PROTOTYPE: the subset checker's rejections. Each case is a one-line change to a minimal Adapter;
// the transpiler must refuse it with the given message. `ok` cases must transpile.
// Usage: node transpiler/rejects.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { transpile } from './transpile.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const CASES = [
  // [rule, body of core.imp (before `return out`), expected message, module-level code]
  ['ok: write to a fresh local', `out.tagid = str(p.unit);`, null],
  ['ok: let reassignment, for..of, typeof, === undefined', `let n = 0; for (const f of imp.banner?.format ?? []) { if (typeof f.w === 'number' && f.w !== undefined) n = f.w; } out.bidfloor = n;`, null],
  ['input mutation', `imp.tagid = 'x';`, 'writes only to objects this function created'],
  ['param mutation', `p.unit = 'x';`, 'writes only to objects this function created'],
  ['nested write through a shallow copy', `out.ext!.gpid = 'x';`, 'nested writes would mutate the input'],
  ['write after the object escaped', `const o = { a: 1 }; const l = [o]; o.a = 2;`, 'write after the object was used as a value'],
  ['reassigning a const-like binding', `const n = 1; n = 2;`, 'type error'],
  ['loose equality', `if (imp.id == 'x') return out;`, 'loose equality only as'],
  ['JS coercion', `const n = Number(p.unit);`, 'JS coercions are not allowed'],
  ['unary + coercion', `const n = +p.unit;`, 'unary operator not allowed'],
  ['string concatenation', `const s = imp.id + 'x';`, 'arithmetic only on numbers'],
  ['ordering comparison on strings', `if (imp.id < 'b') return out;`, 'ordering comparisons only between numbers'],
  ['`any`', `const a: any = imp; const b = a.foo;`, '`any` is not allowed'],
  ['while loop', `while (imp.id) { break; }`, 'is not in the subset'],
  ['for..in', `for (const k in imp) { out.tagid = k; }`, 'is not in the subset'],
  ['exceptions', `throw new Error('x');`, 'is not in the subset'],
  ['regex', `if (/x/.test(imp.id)) return out;`, 'is not in the subset'],
  ['delete', `delete out.tagid;`, 'only assignments may stand as statements'],
  ['++', `let i = 0; i++;`, 'only assignments may stand as statements'],
  ['new', `const d = new Date();`, 'is not in the subset'],
  ['local function', `const f = (x: string) => x;`, 'local functions are not in the subset'],
  ['callback with index', `const l = [1].map((x, i) => i);`, 'callbacks take one parameter'],
  ['callback with a block body', `const l = [1].map((x) => { return x; });`, 'callbacks must have an expression body'],
  ['split on a non-literal separator', `const s = imp.id.split(imp.id);`, 'split takes one non-empty string literal'],
  ['split on the empty string', `const s = imp.id.split('');`, 'split takes one non-empty string literal'],
  ['template with an object', 'const s = `${imp.banner}`;', 'template interpolations must be'],
  ['Object.keys of a locally built object', `const o = { a: undefined }; const k = Object.keys(o);`, 'Object.keys of an object this function built'],
  ['array .includes (not yet)', `const b = [1].includes(1);`, 'array method .includes is not in the subset'],
  ['Math.random', `const r = Math.random();`, 'Math.random is not in the subset'],
  ['typeof outside a comparison', `const t = typeof imp;`, 'typeof only in a comparison'],
  ['method on a value of unknown shape', `const x = imp.ext?.skadn; const y = x?.toString();`, `.toString() on a value that isn't statically`],
  ['reject outside a return', `const r = reject('x');`, 'reject(...) only as `return reject(message)`'],
  ['non-Core import', ``, 'not a Prebid Core helper', `import { build } from '../../core/index.ts';`],
  ['module state', ``, 'not allowed at module level', `let count = 0;`],
  ['class', ``, 'not allowed at module level', `class A {}`],
];

const dir = path.join(root, 'out/rejects');
fs.mkdirSync(dir, { recursive: true });
let bad = 0;
CASES.forEach(([rule, body, expect, modCode = ''], i) => {
  const f = path.join(dir, `case${i}.ts`);
  fs.writeFileSync(f, `import { defineAdapter, reject, str } from '../../core/index.ts';
${modCode}
export default defineAdapter<{ unit: string }>({
  bidder: 'x',
  endpoint: 'https://x',
  core: {
    imp(imp, p, req) { const out = { ...imp }; ${body}
      return out; },
    request: (req) => req,
    bid: (bid) => ({ type: 'banner' }),
    response: (resp) => ({}),
  },
});
`);
  const { errors } = transpile(f);
  const pass = expect === null ? errors.length === 0 : errors.some((e) => e.includes(expect));
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${rule}${pass ? '' : `\n   expected ${expect === null ? 'no errors' : JSON.stringify(expect)}, got:\n   ${errors.join('\n   ') || '(none)'}`}`);
  if (pass && expect !== null) console.log(`     ${errors.find((e) => e.includes(expect)).replace(/^.*?: /, '')}`);
});
console.log(`\n${CASES.length - bad}/${CASES.length} subset cases behave as expected`);
process.exitCode = bad ? 1 : 0;
