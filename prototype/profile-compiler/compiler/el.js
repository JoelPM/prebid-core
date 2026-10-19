// PROTOTYPE. The Definition expression language (EL): tokenizer + Pratt-style parser -> AST.
//
// Semantics (shared by the TS and Rust back ends; see README "Expression semantics"):
// - Values are JSON values plus `absent` (`~`). Reading a missing path yields absent, never an error.
// - Truthiness is JavaScript's: absent, null, false, 0, "" are falsy; [] and {} are truthy.
// - `a ?? b` falls through on absent or null; `a || b` on falsy. Both return an operand, not a bool.
// - `==` / `!=` are type-strict (1 == '1' is false). `<` etc. are false unless both sides are numbers.
// - No assignment, no loops, no user-defined functions. `list.map(x, e)` / `.filter` / `.some` are
//   CEL-style bounded macros: one pass over a list, no accumulator.

const PUNCT = ['...', '??', '?.', '||', '&&', '==', '!=', '<=', '>=', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}', '<', '>', '!', '+', '-', '~'];

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, s = '';
      while (src[j] !== c) { if (src[j] === '\\') { s += JSON.parse('"' + src.slice(j, j + 2) + '"'); j += 2; } else s += src[j++]; if (j >= src.length) throw new Error('unterminated string in: ' + src); }
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (c === '`') {
      // template: alternating literal strings and ${expr} sources
      const parts = []; let j = i + 1, s = '';
      while (src[j] !== '`') {
        if (j >= src.length) throw new Error('unterminated template in: ' + src);
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1, k = j + 2;
          while (depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
          parts.push(s); s = ''; parts.push({ src: src.slice(j + 2, k - 1) }); j = k;
        } else s += src[j++];
      }
      parts.push(s);
      toks.push({ t: 'tmpl', v: parts }); i = j + 1; continue;
    }
    const p = PUNCT.find((p) => src.startsWith(p, i));
    if (!p) throw new Error(`unexpected '${c}' in: ${src}`);
    toks.push({ t: 'p', v: p }); i += p.length;
  }
  toks.push({ t: 'eof' });
  return toks;
}

export const MACROS = ['map', 'filter', 'some'];

export function parse(src) {
  if (typeof src !== 'string') src = JSON.stringify(src); // YAML numbers/bools/null
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const isP = (v) => toks[k].t === 'p' && toks[k].v === v;
  const eat = (v) => { if (!isP(v)) throw new Error(`expected '${v}' at token ${k} in: ${src}`); k++; };

  function expr() { return cond(); }
  function cond() {
    const c = binary(0);
    if (isP('?')) { k++; const a = expr(); eat(':'); const b = expr(); return { k: 'cond', c, a, b }; }
    return c;
  }
  const LEVELS = [['??'], ['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-']];
  function binary(lvl) {
    if (lvl === LEVELS.length) return unary();
    let l = binary(lvl + 1);
    while (toks[k].t === 'p' && LEVELS[lvl].includes(toks[k].v)) {
      const op = toks[k++].v;
      l = { k: 'bin', op, l, r: binary(lvl + 1) };
    }
    return l;
  }
  function unary() {
    if (isP('!')) { k++; return { k: 'not', e: unary() }; }
    if (isP('-')) { k++; return { k: 'bin', op: '-', l: { k: 'lit', v: 0 }, r: unary() }; }
    return postfix(primary());
  }
  function postfix(e) {
    for (;;) {
      if (isP('.') || isP('?.')) {
        k++;
        const name = toks[k++].v;
        if (isP('(')) {
          if (!MACROS.includes(name)) throw new Error(`unknown method .${name}() in: ${src}`);
          k++; const v = toks[k++].v; eat(','); const body = expr(); eat(')');
          e = { k: 'macro', name, recv: e, v, body };
        } else e = { k: 'get', e, key: name };
      } else if (isP('[')) {
        k++; const i = expr(); eat(']');
        e = i.k === 'lit' && typeof i.v === 'string' ? { k: 'get', e, key: i.v } : i.k === 'lit' && typeof i.v === 'number' ? { k: 'at', e, i: i.v } : { k: 'index', e, i };
      } else return e;
    }
  }
  function primary() {
    const t = toks[k++];
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'tmpl') return { k: 'tmpl', parts: t.v.map((p) => (typeof p === 'string' ? p : parse(p.src))) };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (t.v === 'keep') return { k: 'keep' };
      if (isP('(')) {
        k++; const args = [];
        while (!isP(')')) { args.push(expr()); if (isP(',')) k++; }
        k++;
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    if (t.t === 'p') {
      if (t.v === '~') return { k: 'absent' };
      if (t.v === '(') { const e = expr(); eat(')'); return e; }
      if (t.v === '{') {
        const entries = [];
        while (!isP('}')) {
          const kt = toks[k++];
          const key = kt.t === 'num' ? String(kt.v) : kt.v;
          eat(':'); entries.push([key, expr()]); if (isP(',')) k++;
        }
        k++;
        return { k: 'obj', entries };
      }
      if (t.v === '[') {
        const items = [];
        while (!isP(']')) {
          if (isP('...')) { k++; items.push({ spread: true, e: expr() }); } else items.push({ e: expr() });
          if (isP(',')) k++;
        }
        k++;
        return { k: 'arr', items };
      }
    }
    throw new Error(`unexpected token ${JSON.stringify(t)} in: ${src}`);
  }
  const e = expr();
  if (peek().t !== 'eof') throw new Error(`trailing input at token ${k} in: ${src}`);
  return e;
}

// Builtins: name -> [minArgs, maxArgs, class]. class 'map' = counts as a declarative mapping
// (casts and structural helpers a mapping vocabulary would have); 'hatch' = escape-hatch logic.
export const BUILTINS = {
  str: [1, 1, 'map'], num: [1, 1, 'map'], int: [1, 1, 'map'], nonempty: [1, 1, 'map'], without: [2, 9, 'map'], merge: [2, 9, 'map'], first: [1, 1, 'map'],
  trim: [1, 1, 'hatch'], lower: [1, 1, 'hatch'], split: [2, 2, 'hatch'], join: [2, 2, 'hatch'], contains: [2, 2, 'hatch'],
  len: [1, 1, 'hatch'], max: [2, 2, 'hatch'], keys: [1, 1, 'hatch'], entries: [1, 1, 'hatch'], fromEntries: [1, 1, 'hatch'],
  type: [1, 1, 'hatch'], json: [1, 1, 'hatch'], stringify: [1, 1, 'hatch'],
};

// Classify an expression: 'map' if every node is a declarative-mapping construct, else 'hatch'.
export function classify(e) {
  let hatch = false;
  walk(e, (n) => {
    if (['tmpl', 'macro', 'index'].includes(n.k)) {
      // a lookup table (`{...}[key]`) is declarative; computed indexing into data is not
      if (n.k === 'index' && n.e.k === 'obj') return;
      hatch = true;
    }
    if (n.k === 'bin' && ['<', '>', '<=', '>=', '+', '-'].includes(n.op)) hatch = true;
    if (n.k === 'arr' && n.items.some((i) => i.spread)) hatch = true;
    if (n.k === 'call') {
      const b = BUILTINS[n.fn];
      if (!b) throw new Error(`unknown function ${n.fn}()`);
      if (n.args.length < b[0] || n.args.length > b[1]) throw new Error(`${n.fn}() takes ${b[0]}..${b[1]} args`);
      if (b[2] === 'hatch') hatch = true;
    }
  });
  return hatch ? 'hatch' : 'map';
}

export function walk(e, f) {
  f(e);
  switch (e.k) {
    case 'get': case 'at': case 'not': walk(e.e, f); break;
    case 'index': walk(e.e, f); walk(e.i, f); break;
    case 'bin': walk(e.l, f); walk(e.r, f); break;
    case 'cond': walk(e.c, f); walk(e.a, f); walk(e.b, f); break;
    case 'call': e.args.forEach((a) => walk(a, f)); break;
    case 'macro': walk(e.recv, f); walk(e.body, f); break;
    case 'obj': e.entries.forEach(([, v]) => walk(v, f)); break;
    case 'arr': e.items.forEach((i) => walk(i.e, f)); break;
    case 'tmpl': e.parts.forEach((p) => typeof p !== 'string' && walk(p, f)); break;
  }
}

export function size(e) {
  let n = 0;
  walk(e, () => n++);
  return n;
}
