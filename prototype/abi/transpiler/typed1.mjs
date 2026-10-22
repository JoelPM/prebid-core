// PROTOTYPE typed Rust back end, Level 1, for the Definition Compiler (#17): views (a struct per shape node,
// decoded in one pass by a match on key bytes), a member arena for copy sources, and plans (spread-plus-
// overrides emitted straight into the output). Level 0 (typed.mjs) remains the fallback for any expression
// these don't cover.
//
// Level 0 header follows: Same front end and subset rules as
// transpile.mjs (rejections are checked there; run it first); this emits Rust against runtime/rt2:
//   - shape analysis: per Phase, which input paths are read, so decoding indexes exactly those in one
//     scan and keeps everything else as spans (raw pass-through, one-pass decode, lazy documents);
//   - Phases lowered to spread-plus-overrides on rt2 values, written straight into the output frame;
//   - keys and literals interned as pre-escaped byte strings.
import ts from 'typescript';
import path from 'node:path';
import { transpile as check } from './transpile.mjs';

const q = JSON.stringify;
// JSON-escaped content of s as a Rust byte-string literal (what rt2::Js::Esc holds)
const esc = (s) => {
  const c = q(s).slice(1, -1);
  let r = '';
  for (const ch of Buffer.from(c, 'utf8')) r += ch >= 0x20 && ch < 0x7f && ch !== 0x22 && ch !== 0x5c ? String.fromCharCode(ch) : `\\x${ch.toString(16).padStart(2, '0')}`;
  return `b"${r}"`;
};
const hasEsc = (s) => q(s).slice(1, -1).includes('\\');
const K = (k) => `rt::Js::${hasEsc(k) ? 'EscX' : 'Esc'}(${esc(k)})`;
const CORE_FNS = { str: 'str_', num: 'num_', int: 'int', obj: 'obj_' };
const HOOKS = {
  core: { imp: ['imp', 'p', 'req'], request: ['req', 'params'], bid: ['bid', 'imp', 'resp'], response: ['resp'] },
  ext: { imp: ['imp', 'p', 'req'], request: ['req', 'params'], bid: ['bid', 'imp'] },
};
const REJECTING = new Set(['core.imp', 'core.bid']);

export function transpileTyped1(file, side = 'server') {
  const front = check(file, side);
  if (front.errors.length) return { errors: front.errors };
  const configPath = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram([file], { ...cfg.options, noEmit: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const typeOf = (n) => checker.getTypeAtLocation(n);
  const parts = (ty) => (ty.isUnion() ? ty.types : [ty]);
  const nonNull = (ty) => parts(ty).filter((p) => !(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
  const isStr = (ty) => nonNull(ty).length > 0 && nonNull(ty).every((p) => p.flags & ts.TypeFlags.StringLike);
  const unwrapE = (n) => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
    return n;
  };
  let tmp = 0;
  const t = () => `t${tmp++}`;
  const bad = (n, msg) => { throw new Error(`${msg}: ${n.getText(sf).slice(0, 80)}`); };

  // ---------- module scope ----------
  const mod = { tables: {}, fns: {}, fnNodes: {} };
  let defObj = null;
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) defObj = st.expression.arguments[0];
    else if (ts.isVariableStatement(st)) {
      for (const dcl of st.declarationList.declarations) {
        const name = dcl.name.getText(sf);
        const init = unwrapE(dcl.initializer);
        if (ts.isArrowFunction(init)) { mod.fns[name] = `f_${name}`; mod.fnNodes[name] = init; }
        else mod.tables[name] = init.properties.map((p) => [p.name.text ?? p.name.getText(sf), p.initializer.text]);
      }
    }
  }
  const propName = (n) => (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : n.getText(sf));
  const prop = (o, k) => o?.properties.find((p) => p.name && propName(p.name) === k);
  const strProp = (o, k) => prop(o, k)?.initializer.text;
  const sideObj = prop(defObj, side)?.initializer;
  const coreObj = prop(defObj, 'core').initializer;
  const bidder = strProp(defObj, 'bidder');
  const endpoint = strProp(sideObj, 'endpoint') ?? strProp(defObj, 'endpoint');
  const hookFn = (o, k) => {
    const p = o && prop(o, k);
    if (!p) return null;
    return ts.isMethodDeclaration(p) ? p : p.initializer;
  };

  // ================================================================ shape analysis
  // A path is a list of segments rooted at an input document: a key, '*' (any array element) or
  // '%' (any object member). `need(path)` records that a Phase reads (or spreads) there.
  const shapes = { req: newNode(), resp: newNode(), breq: newNode() };
  function newNode() { return { kids: new Map(), any: null, el: null, index: false, copy: false }; }
  function need(root, segs) {
    let n = shapes[root];
    for (const s of segs) {
      n.index = true;
      if (s === '*') n = n.el ??= newNode();
      else if (s === '%') n = n.any ??= newNode();
      else { if (!n.kids.has(s)) n.kids.set(s, newNode()); n = n.kids.get(s); }
    }
    return n;
  }
  // paths of an expression: { root, segs } or null; aliases maps local names to paths
  function pathOf(e, al) {
    e = unwrapE(e);
    if (!e) return null;
    if (ts.isIdentifier(e)) return al.get(e.text) ?? null;
    if (ts.isPropertyAccessExpression(e)) {
      const b = pathOf(e.expression, al);
      if (!b) return null;
      if (e.name.text === 'length') { need(b.root, [...b.segs, '*']); return null; }
      return { root: b.root, segs: [...b.segs, e.name.text] };
    }
    if (ts.isElementAccessExpression(e)) {
      const b = pathOf(e.expression, al);
      if (!b) return null;
      const a = e.argumentExpression;
      if (ts.isNumericLiteral(a)) return { root: b.root, segs: [...b.segs, '*'] };
      if (ts.isStringLiteral(a)) return { root: b.root, segs: [...b.segs, a.text] };
      return { root: b.root, segs: [...b.segs, '%'] };
    }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) return pathOf(e.left, al);
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c) && c.text === 'obj') return pathOf(e.arguments[0], al);
      if (ts.isPropertyAccessExpression(c) && ['filter', 'find'].includes(c.name.text)) {
        const b = pathOf(c.expression, al);
        return b && (c.name.text === 'find' ? { root: b.root, segs: [...b.segs, '*'] } : b);
      }
    }
    return null;
  }
  // walk a function body, recording reads; `al` maps names to input paths
  function analyze(node, al, depth = 0) {
    const visit = (n, al) => {
      n = n ?? null;
      if (!n) return;
      // declarations introduce aliases
      if (ts.isVariableDeclaration(n) && n.initializer) {
        visit(n.initializer, al);
        const p = pathOf(n.initializer, al) ?? (ts.isObjectLiteralExpression(unwrapE(n.initializer)) ? spreadSrc(unwrapE(n.initializer), al) : null);
        if (p && ts.isIdentifier(n.name)) al.set(n.name.text, p);
        return;
      }
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        // a method's name isn't a path: `x.trim()` reads x
        const isCallee = ts.isCallExpression(n.parent) && n.parent.expression === n && ts.isPropertyAccessExpression(n);
        const p = pathOf(isCallee ? n.expression : n, al);
        if (p) need(p.root, p.segs);
      }
      if (ts.isSpreadAssignment(n)) {
        const p = pathOf(n.expression, al);
        if (p) need(p.root, p.segs).copy = true;
      }
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        if (ts.isIdentifier(c) && c.text === 'without') {
          const p = pathOf(n.arguments[0], al);
          if (p) need(p.root, p.segs).copy = true;
        }
        if (ts.isIdentifier(c) && mod.fnNodes[c.text] && depth < 4) {
          // interprocedural: bind the helper's parameters to its arguments' paths
          const f = mod.fnNodes[c.text];
          const fal = new Map();
          f.parameters.forEach((p, i) => { const ap = n.arguments[i] && pathOf(n.arguments[i], al); if (ap && ts.isIdentifier(p.name)) fal.set(p.name.text, ap); });
          analyze(f.body, fal, depth + 1);
        }
        if (ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === 'Object' && ['entries', 'keys'].includes(c.name.text)) {
          const p = pathOf(n.arguments[0], al);
          if (p) need(p.root, p.segs).copy = true;
        }
        if (ts.isPropertyAccessExpression(c) && ['map', 'filter', 'find', 'some', 'every'].includes(c.name.text)) {
          const recv = c.expression;
          let elem = null;
          const r = unwrapE(recv);
          const ent = entriesOf(r);
          if (ent) {
            const p = pathOf(ent, al);
            if (p) elem = { entry: p };
          } else {
            const p = pathOf(recv, al);
            if (p) { need(p.root, [...p.segs, '*']); elem = { root: p.root, segs: [...p.segs, '*'] }; }
          }
          const cb = n.arguments[0];
          if (cb && ts.isArrowFunction(cb) && cb.parameters[0]) {
            const cal = new Map(al);
            const p0 = cb.parameters[0].name;
            if (elem?.entry && ts.isArrayBindingPattern(p0) && p0.elements[1] && !ts.isOmittedExpression(p0.elements[1])) {
              cal.set(p0.elements[1].name.text, { root: elem.entry.root, segs: [...elem.entry.segs, '%'] });
              need(elem.entry.root, [...elem.entry.segs, '%']);
            } else if (elem && !elem.entry && ts.isIdentifier(p0)) cal.set(p0.text, elem);
            visit(recv, al);
            visit(cb.body, cal);
            return;
          }
        }
      }
      ts.forEachChild(n, (c) => visit(c, al));
    };
    visit(node, al);
  }
  // Object.entries(X), possibly behind .filter(...) calls: X
  function entriesOf(e) {
    e = unwrapE(e);
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'filter') e = unwrapE(e.expression.expression);
    return ts.isCallExpression(e) && e.expression.getText(sf) === 'Object.entries' ? e.arguments[0] : null;
  }
  // a fresh object built by spreading an input object reads like that object
  function spreadSrc(o, al) {
    const s = o.properties.find((p) => ts.isSpreadAssignment(p));
    return s ? pathOf(s.expression, al) : null;
  }
  const P = (root, ...segs) => ({ root, segs });
  const impP = P('req', 'imp', '*');
  const pP = P('req', 'imp', '*', 'ext', 'bidder');
  const bidP = P('resp', 'seatbid', '*', 'bid', '*');
  need('req', ['imp', '*', 'ext', 'bidder']);
  need('req', ['imp', '*', 'id']);
  need('resp', ['seatbid', '*', 'bid', '*']).index = true;
  need('breq', ['imp', '*', 'id']);
  const rootsOf = (group, name) => {
    if (name === 'imp') return { imp: impP, p: pP, req: P('req') };
    if (name === 'request') return { req: P('req'), params: { root: 'req', segs: ['imp', '*', 'ext', 'bidder'], list: true } };
    if (name === 'bid') return { bid: bidP, imp: P('breq', 'imp', '*'), resp: P('resp') };
    return { resp: P('resp') };
  };
  function analyzeHook(group, name, fnNode) {
    const roots = rootsOf(group, name);
    const al = new Map();
    HOOKS[group === 'core' ? 'core' : 'ext'][name].forEach((role, i) => {
      const p = fnNode.parameters[i];
      if (!p || !roots[role]) return;
      // `params` is the list of p's: params[i] / params.map(x => ...) read req.imp.*.ext.bidder
      al.set(p.name.text, roots[role].list ? { root: 'plist', segs: [] } : roots[role]);
    });
    analyze(fnNode.body, al);
  }
  // plist paths: map '*' to req.imp.*.ext.bidder
  const origNeed = need;
  const needWrap = (root, segs) => {
    if (root === 'plist') {
      if (segs[0] !== '*') return newNode();
      return origNeed('req', ['imp', '*', 'ext', 'bidder', ...segs.slice(1)]);
    }
    return origNeed(root, segs);
  };
  // eslint-disable-next-line no-func-assign
  need = needWrap;

  const hooks = [];
  for (const k of ['imp', 'request', 'bid', 'response']) hooks.push(['core', k, hookFn(coreObj, k)]);
  for (const k of ['imp', 'request', 'bid']) { const f = hookFn(sideObj, k); if (f) hooks.push(['ext', k, f]); }
  for (const [g, k, f] of hooks) analyzeHook(g, k, f);
  if (hooks.some(([g, k, f]) => k === 'bid' && f.parameters.length > 1)) need('resp', ['seatbid', '*', 'bid', '*', 'impid']);

  // ================================================================ emission
  const newScope = (parent) => ({ vars: Object.create(parent?.vars ?? null), fn: parent?.fn });
  const v = (n, sc) => {
    const x = sc.vars[n];
    if (!x) bad({ getText: () => n }, 'unknown name');
    return x.call ? x.rs : `${x.rs}.clone()`;
  };

  // Level 0 expression over values; sub-expressions go through `ex`, which tries the typed forms first
  function ex(n, sc) {
    const e = unwrapE(n);
    const K_ = ts.SyntaxKind;
    if ((ts.isIdentifier(e) && e.text !== 'undefined') || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isObjectLiteralExpression(e)
      || (ts.isBinaryExpression(e) && [K_.QuestionQuestionToken, K_.BarBarToken].includes(e.operatorToken.kind))) return toVal(tex(e, sc));
    return exRaw(e, sc);
  }
  function exRaw(n, sc) {
    n = unwrapE(n);
    switch (n.kind) {
      case ts.SyntaxKind.NumericLiteral: return `rt::num(${num(n.text)})`;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return `rt::${hasEsc(n.text) ? 'litx' : 'lit'}(${esc(n.text)})`;
      case ts.SyntaxKind.TrueKeyword: return 'rt::V::T';
      case ts.SyntaxKind.FalseKeyword: return 'rt::V::F';
      case ts.SyntaxKind.NullKeyword: return 'rt::V::Null';
      case ts.SyntaxKind.Identifier:
        if (n.text === 'undefined') return 'rt::U';
        return v(n.text, sc);
      case ts.SyntaxKind.TemplateExpression: {
        let s = `{ let mut tm = rt::Tmpl::new(); `;
        if (n.head.text) s += `tm.lit(${q(n.head.text)}); `;
        for (const sp of n.templateSpans) {
          s += `tm.val(&${ex(sp.expression, sc)}); `;
          if (sp.literal.text) s += `tm.lit(${q(sp.literal.text)}); `;
        }
        return s + 'tm.done() }';
      }
      case ts.SyntaxKind.PropertyAccessExpression:
        if (n.name.text === 'length') return `rt::len(&${ex(n.expression, sc)})`;
        return `rt::get(&${ex(n.expression, sc)}, ${q(n.name.text)})`;
      case ts.SyntaxKind.ElementAccessExpression: {
        const a = n.argumentExpression;
        if (ts.isIdentifier(n.expression) && mod.tables[n.expression.text]) return `rt::table(&${ex(a, sc)}, &[${mod.tables[n.expression.text].map(([k, x]) => `(${q(k)}, ${esc(x)} as &[u8])`).join(', ')}])`;
        if (ts.isNumericLiteral(a)) return `rt::at(&${ex(n.expression, sc)}, ${+a.text})`;
        if (ts.isStringLiteral(a)) return `rt::get(&${ex(n.expression, sc)}, ${q(a.text)})`;
        return `rt::index(&${ex(n.expression, sc)}, &${ex(a, sc)})`;
      }
      case ts.SyntaxKind.PrefixUnaryExpression:
        if (n.operator === ts.SyntaxKind.ExclamationToken) return `rt::bool_(!${cond(n.operand, sc)})`;
        return `rt::num(-${num(n.operand.text)})`;
      case ts.SyntaxKind.ConditionalExpression: return `if ${cond(n.condition, sc)} { ${ex(n.whenTrue, sc)} } else { ${ex(n.whenFalse, sc)} }`;
      case ts.SyntaxKind.BinaryExpression: {
        const op = n.operatorToken.kind, K_ = ts.SyntaxKind, a = t();
        if (op === K_.QuestionQuestionToken) return `{ let ${a} = ${ex(n.left, sc)}; if rt::nullish(&${a}) { ${ex(n.right, sc)} } else { ${a} } }`;
        if (op === K_.BarBarToken) return `{ let ${a} = ${ex(n.left, sc)}; if rt::truthy(&${a}) { ${a} } else { ${ex(n.right, sc)} } }`;
        if (op === K_.AmpersandAmpersandToken) return `{ let ${a} = ${ex(n.left, sc)}; if !rt::truthy(&${a}) { ${a} } else { ${ex(n.right, sc)} } }`;
        if ([K_.PlusToken, K_.MinusToken, K_.AsteriskToken, K_.SlashToken, K_.PercentToken].includes(op)) return `rt::arith(&${ex(n.left, sc)}, &${ex(n.right, sc)}, b'${n.operatorToken.getText(sf)}')`;
        return `rt::bool_(${cond(n, sc)})`;
      }
      case ts.SyntaxKind.ObjectLiteralExpression: return objLit(n, sc);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const a = t();
        const items = n.elements.map((e) => (ts.isSpreadElement(e) ? `${a}.extend(rt::items(&${ex(e.expression, sc)}).iter().cloned());` : `${a}.push(${ex(e, sc)});`));
        return `{ let mut ${a}: Vec<V> = Vec::with_capacity(${n.elements.length}); ${items.join(' ')} rt::arr_v(${a}) }`;
      }
      case ts.SyntaxKind.CallExpression: return call(n, sc);
    }
    bad(n, `typed back end: ${ts.SyntaxKind[n.kind]} not handled`);
  }

  function cond(n, sc) {
    const K_ = ts.SyntaxKind;
    n = unwrapE(n);
    if (ts.isPrefixUnaryExpression(n) && n.operator === K_.ExclamationToken) return `!${cond(n.operand, sc)}`;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === K_.AmpersandAmpersandToken) return `(${cond(n.left, sc)} && ${cond(n.right, sc)})`;
      if (op === K_.BarBarToken) return `(${cond(n.left, sc)} || ${cond(n.right, sc)})`;
      const isNull = (e) => e.kind === K_.NullKeyword;
      const isUndef = (e) => ts.isIdentifier(e) && e.text === 'undefined';
      if (op === K_.EqualsEqualsToken || op === K_.ExclamationEqualsToken) {
        const other = isNull(n.left) ? n.right : n.left;
        return `${op === K_.ExclamationEqualsToken ? '!' : ''}${presence(other, sc, 'nullish')}`;
      }
      if (op === K_.EqualsEqualsEqualsToken || op === K_.ExclamationEqualsEqualsToken) {
        const neg = op === K_.ExclamationEqualsEqualsToken ? '!' : '';
        if (isUndef(n.left) || isUndef(n.right)) return `${neg}rt::is_undef(&${ex(isUndef(n.left) ? n.right : n.left, sc)})`;
        const ty = ts.isTypeOfExpression(n.left) ? n.left : ts.isTypeOfExpression(n.right) ? n.right : null;
        if (ty) return `${neg}(rt::typeof_(&${ex(ty.expression, sc)}) == ${q((ty === n.left ? n.right : n.left).text)})`;
        if (ts.isStringLiteral(n.right)) return `${neg}rt::is_lit(&${ex(n.left, sc)}, ${q(n.right.text)})`;
        if (ts.isStringLiteral(n.left)) return `${neg}rt::is_lit(&${ex(n.right, sc)}, ${q(n.left.text)})`;
        return `${neg}rt::eq(&${ex(n.left, sc)}, &${ex(n.right, sc)})`;
      }
      const cmp = { [K_.LessThanToken]: 'lt', [K_.GreaterThanToken]: 'gt', [K_.LessThanEqualsToken]: 'le', [K_.GreaterThanEqualsToken]: 'ge' }[op];
      if (cmp) return `rt::${cmp}(&${ex(n.left, sc)}, &${ex(n.right, sc)})`;
    }
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Array.isArray') return `rt::is_array(&${ex(n.arguments[0], sc)})`;
    return presence(n, sc, 'truthy');
  }

  function objLit(n, sc) {
    const o = t();
    let s = '';
    let started = false;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) s += started ? `rt::assign(&mut ${o}, &${ex(p.expression, sc)}); ` : `let mut ${o} = rt::spread(&${ex(p.expression, sc)}); `;
      else {
        if (!started) s += `let mut ${o} = rt::O::default(); `;
        const [k, val] = ts.isShorthandPropertyAssignment(p) ? [p.name.text, ex(p.name, sc)] : [propName(p.name), ex(p.initializer, sc)];
        s += `{ let x = ${val}; ${o}.set(${K(k)}, x); } `;
      }
      started = true;
    }
    if (!started) s = `let ${o} = rt::O::default(); `;
    return `{ ${s}rt::obj_v(${o}) }`;
  }

  function callback(fnNode, sc, item) {
    const isc = newScope(sc);
    let binds = '';
    const p0 = fnNode.parameters[0];
    if (p0) {
      if (ts.isIdentifier(p0.name)) {
        const rs = `v_${p0.name.text}_${tmp++}`;
        isc.vars[p0.name.text] = { k: 'val', rs };
        binds = `let ${rs} = ${item}.clone();`;
      } else p0.name.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        const rs = `v_${el.name.text}_${tmp++}`;
        isc.vars[el.name.text] = { k: 'val', rs };
        binds += `let ${rs} = rt::at(&${item}, ${i}); `;
      });
    }
    return [binds, isc, fnNode.body];
  }

  function call(n, sc) {
    const c = n.expression;
    const args = n.arguments;
    if (ts.isIdentifier(c)) {
      const name = c.text;
      if (name === 'without') return `rt::without(&${ex(args[0], sc)}, &[${args.slice(1).map((k) => q(k.text)).join(', ')}])`;
      if (name === 'nonempty') return `rt::nonempty(${ex(args[0], sc)})`;
      if (name === 'parseJson') return `rt::json(cx, &${ex(args[0], sc)})`;
      if (CORE_FNS[name]) return `rt::${CORE_FNS[name]}(&${ex(args[0], sc)})`;
      if (mod.fns[name]) return `${mod.fns[name]}(cx${args.map((a) => `, ${ex(a, sc)}`).join('')})`;
      bad(n, 'unknown function');
    }
    const m = c.name.text;
    const recvText = c.expression.getText(sf);
    const statics = {
      'Object.entries': () => `rt::entries(&${ex(args[0], sc)})`,
      'Object.keys': () => `rt::keys(&${ex(args[0], sc)})`,
      'Object.fromEntries': () => `rt::from_entries(&${ex(args[0], sc)})`,
      'JSON.stringify': () => `rt::stringify(&${ex(args[0], sc)})`,
      'Math.max': () => `rt::max(&${ex(args[0], sc)}, &${ex(args[1], sc)})`,
      'Array.isArray': () => `rt::bool_(${cond(n, sc)})`,
    };
    if (statics[`${recvText}.${m}`]) return statics[`${recvText}.${m}`]();
    const recv = ex(c.expression, sc);
    if (isStr(typeOf(c.expression))) {
      if (m === 'trim') return `rt::trim(&${recv})`;
      if (m === 'toLowerCase') return `rt::lower(&${recv})`;
      if (m === 'split') return `rt::split(&${recv}, ${q(args[0].text)})`;
      if (m === 'includes') return `rt::includes(&${recv}, &${ex(args[0], sc)})`;
    }
    if (m === 'join') return `rt::join(&${recv}, ${q(args[0].text)})`;
    const [binds, isc, body] = callback(args[0], sc, 'it');
    const src = `let src = rt::items(&${recv});`;
    if (m === 'map') return `{ ${src} let mut out: Vec<V> = Vec::with_capacity(src.len()); for it in src.iter() { ${binds} out.push(${ex(body, isc)}); } rt::arr_v(out) }`;
    if (m === 'filter') return `{ ${src} let mut out: Vec<V> = Vec::with_capacity(src.len()); for it in src.iter() { ${binds} if ${cond(body, isc)} { out.push(it.clone()); } } rt::arr_v(out) }`;
    if (m === 'find') return `{ ${src} let mut f = rt::U; for it in src.iter() { ${binds} if ${cond(body, isc)} { f = it.clone(); break; } } f }`;
    if (m === 'some') return `{ ${src} let mut f = false; for it in src.iter() { ${binds} if ${cond(body, isc)} { f = true; break; } } rt::bool_(f) }`;
    if (m === 'every') return `{ ${src} let mut f = true; for it in src.iter() { ${binds} if !${cond(body, isc)} { f = false; break; } } rt::bool_(f) }`;
    bad(n, 'method');
  }

  // ================================================================ Level 1: views and plans
  // Every shape node is a leaf (a V), an array of leaves (a V), a list of structs, or a struct
  // (one field per key read; members recorded in the arena when it is a copy source).
  const cls = (n) => {
    if (n.el) return cls(n.el) === 'leaf' ? 'arrleaf' : 'list';
    if (n.kids.size || n.index || n.copy || n.any) return 'struct';
    return 'leaf';
  };
  const ids = new Map();
  const nid = (n) => { if (!ids.has(n)) ids.set(n, ids.size); return ids.get(n); };
  const sname = (n) => `N${nid(n)}`;
  const lname = (n) => `L${nid(n)}`;
  const fields = new Map(); // node -> Map(key -> field name)
  const fname = (n, k) => {
    if (!fields.has(n)) fields.set(n, new Map());
    const m = fields.get(n);
    if (!m.has(k)) m.set(k, `f_${k.replace(/[^A-Za-z0-9_]/g, '_')}_${m.size}`);
    return m.get(k);
  };
  const tyOf = (c) => ({ leaf: "V<'a>", arrleaf: "V<'a>", list: `${lname(c.el)}<'a>`, struct: `${sname(c)}<'a>` })[cls(c)];
  let typesRs = '';
  const emitted = new Set();
  function genNode(n) {
    if (emitted.has(n)) return;
    emitted.add(n);
    const c = cls(n);
    if (c === 'list') {
      genNode(n.el);
      const el = n.el;
      typesRs += `#[derive(Default)]\npub struct ${lname(el)}<'a> { pub v: V<'a>, pub items: Vec<${sname(el)}<'a>> }\n`;
      typesRs += `fn l${nid(el)}<'a>(p: &mut rt::P<'a>, ar: &mut rt::Ar<'a>, x: &mut ${lname(el)}<'a>) {\nlet s = p.start();\nif !p.is_arr() { x.v = p.leaf(); return; }\np.arr_each(|p| { x.items.push(Default::default()); d${nid(el)}(p, ar, x.items.last_mut().unwrap()) });\nx.v = V::Raw(p.since(s));\n}\n`;
      return;
    }
    if (c !== 'struct') return;
    const kids = [...n.kids];
    for (const [, k] of kids) genNode(k);
    const copy = !!(n.copy || n.any);
    typesRs += `pub struct ${sname(n)}<'a> { pub v: V<'a>, pub m: u32, pub dup: bool, ${kids.map(([k, ch]) => `pub ${fname(n, k)}: ${tyOf(ch)}`).join(', ')} }\n`;
    typesRs += `impl Default for ${sname(n)}<'_> { fn default() -> Self { ${sname(n)} { v: V::U, m: rt::NONE, dup: false, ${kids.map(([k]) => `${fname(n, k)}: Default::default()`).join(', ')} } } }\n`;
    const arms = kids.map(([k, ch]) => {
      const f = `x.${fname(n, k)}`;
      switch (cls(ch)) {
        case 'leaf': return `b${q(k)} => ${f} = p.leaf(),`;
        case 'arrleaf': return `b${q(k)} => ${f} = p.leaf_arr(),`;
        case 'list': return `b${q(k)} => l${nid(ch.el)}(p, ar, &mut ${f}),`;
        default: return `b${q(k)} => { d${nid(ch)}(p, ar, &mut ${f}); ${copy && (ch.copy || ch.any) ? `kid = (${f}.m, ${f}.dup, true); ` : ''}}`;
      }
    });
    typesRs += `fn d${nid(n)}<'a>(p: &mut rt::P<'a>, ar: &mut rt::Ar<'a>, x: &mut ${sname(n)}<'a>) {
let s = p.start();
if !p.is_obj() { x.v = p.leaf(); return; }
${copy ? 'let (mut first, mut last, mut seen) = (rt::NONE, rt::NONE, 0u64);' : ''}
p.obj_each(|p, k, kx| {
${copy ? 'let vs = p.start(); let mut kid = (rt::NONE, false, false);' : ''}
match &*rt::key(k, kx) { ${arms.join(' ')} _ => p.skip_val(), }
${copy ? 'rt::link(ar, &mut first, &mut last, &mut seen, &mut x.dup, k, kx, p.since(vs), kid);' : ''}
});
x.v = V::Raw(p.since(s)); ${copy ? 'x.m = first;' : ''}
}
`;
  }
  const nodeAt = (root, segs) => {
    let n = shapes[root];
    for (const s of segs) n = s === '*' ? n.el : s === '%' ? n.any : n.kids.get(s);
    return n;
  };
  // the driver reads these as views: force them to be structs
  const nImp = nodeAt('req', ['imp', '*']), nP = nodeAt('req', ['imp', '*', 'ext', 'bidder']);
  const nBid = nodeAt('resp', ['seatbid', '*', 'bid', '*']), nBimp = nodeAt('breq', ['imp', '*']);
  for (const n of [nImp, nP, nBid, nBimp, shapes.req, shapes.resp, shapes.breq, nodeAt('resp', ['seatbid', '*'])]) n.index = true;
  shapes.req.copy = true; // the request Phase spreads it
  shapes.breq.copy = false;
  for (const r of ['req', 'resp', 'breq']) genNode(shapes[r]);

  // ---------- typed expressions ----------
  // kinds: val (a V), view (&N), oview (Option<&N>), list (&L), olist (Option<&L>), vlist (Vec<&N>),
  // plan (a Plan local), out (an Out), pm (a member of a plan: lazily a value or a plan), reqin
  const V_ = (rs) => ({ k: 'val', rs });
  function toVal(x) {
    switch (x.k) {
      case 'val': return x.rs;
      case 'view': whole(x.node); return x.objOnly ? `rt::obj_(&${x.rs}.v)` : `${x.rs}.v.clone()`;
      case 'oview': whole(x.node); return `${x.rs}.map_or(V::U, |x| ${x.objOnly ? 'rt::obj_(&x.v)' : 'x.v.clone()'})`;
      case 'list': whole(x.arr); return `${x.rs}.v.clone()`;
      case 'olist': whole(x.arr); return `${x.rs}.map_or(V::U, |l| l.v.clone())`;
      case 'vlist': whole(x.node); return `rt::arr_v(${x.rs}.iter().map(|x| x.v.clone()).collect())`;
      case 'plan': whole(x.src); return `${x.rs}.to_v(ar)`;
      case 'out': return `(${x.rs}).to_v(ar)`;
      case 'pm': return `(${x.plan}).get(ar, ${q(x.key)})`;
      case 'reqin': return `rt::Plan::of(&v_req.v.v, v_req.v.m, v_req.v.dup).with("imp", rt::Out::IdxList(v_req.imps.clone(), v_req.ix.clone())).to_v(ar)`;
    }
    throw new Error('toVal ' + x.k);
  }
  function toOut(x, move = false) {
    if (x.k === 'plan') return move ? `rt::Out::P(Box::new(std::mem::take(&mut ${x.rs})))` : `rt::Out::P(Box::new(${x.rs}.clone()))`;
    if (x.k === 'out') return x.rs;
    if (x.k === 'pm') return `(${x.plan}).member_out(ar, ${q(x.key)})`;
    return `rt::Out::V(${toVal(x)})`;
  }
  const whole = (n) => { if (n) n.whole = true; };
  // truthiness / nullishness: a view's projected value answers it (present iff the input's is)
  function presence(n, sc, f) {
    const t = tex(n, sc);
    if (t.k === 'view' || t.k === 'list') return `rt::${f}(&${t.rs}.v)`;
    if (t.k === 'oview' || t.k === 'olist') return `${t.rs}.map_or(${f === 'nullish'}, |x| rt::${f}(&x.v))`;
    return `rt::${f}(&${toVal(t)})`;
  }
  const planable = (x) => ['view', 'oview', 'plan', 'out', 'pm', 'reqin'].includes(x.k);
  function toPlan(x) {
    switch (x.k) {
      case 'view': return `rt::Plan::of(&${x.rs}.v, ${x.rs}.m, ${x.rs}.dup)`;
      case 'oview': return `${x.rs}.map_or_else(rt::Plan::default, |x| rt::Plan::of(&x.v, x.m, x.dup))`;
      case 'plan': return `${x.rs}.clone()`;
      case 'out': return `rt::Plan::from_out(${x.rs}, ar)`;
      case 'pm': return `rt::Plan::from_out((${x.plan}).member_out(ar, ${q(x.key)}), ar)`;
      case 'reqin': return `rt::Plan::of(&v_req.v.v, v_req.v.m, v_req.v.dup).with("imp", rt::Out::IdxList(v_req.imps.clone(), v_req.ix.clone()))`;
    }
    return `rt::Plan::from_out(rt::Out::V(${toVal(x)}), ar)`;
  }
  const isEmptyLit = (e) => (e = unwrapE(e)) && ((ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) && !(e.properties ?? e.elements).length);
  const L0 = (rs) => V_(rs); // a Level 0 expression over values

  function tex(n, sc) {
    n = unwrapE(n);
    if (ts.isIdentifier(n) && n.text !== 'undefined') {
      const x = sc.vars[n.text];
      if (!x) bad(n, 'unknown name');
      if (x.k === 'val') return V_(x.call ? x.rs : `${x.rs}.clone()`);
      return { ...x };
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text !== 'length') return member(tex(n.expression, sc), n.name.text, n);
    if (ts.isElementAccessExpression(n)) {
      if (ts.isIdentifier(n.expression) && mod.tables[n.expression.text]) return L0(exRaw(n, sc));
      const b = tex(n.expression, sc);
      const a = n.argumentExpression;
      if (ts.isStringLiteral(a)) return member(b, a.text, n);
      if (ts.isNumericLiteral(a) && ['list', 'olist', 'vlist'].includes(b.k)) {
        const i = +a.text;
        if (b.k === 'list') return { k: 'oview', rs: `${b.rs}.items.get(${i})`, node: b.node };
        if (b.k === 'olist') return { k: 'oview', rs: `${b.rs}.and_then(|l| l.items.get(${i}))`, node: b.node };
        return { k: 'oview', rs: `${b.rs}.get(${i}).copied()`, node: b.node };
      }
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') {
      const b = tex(n.expression, sc);
      if (b.k === 'list') return V_(`rt::num(${b.rs}.items.len() as f64)`);
      if (b.k === 'vlist') return V_(`rt::num(${b.rs}.len() as f64)`);
      return V_(`rt::len(&${toVal(b)})`);
    }
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind) && isEmptyLit(n.right)) {
      const l = tex(n.left, sc);
      if (['view', 'oview', 'list', 'olist'].includes(l.k)) return l;
    }
    if (ts.isObjectLiteralExpression(n)) {
      const p = objPlan(n, sc);
      if (p) return { k: 'out', rs: `rt::Out::P(Box::new(${p}))` };
    }
    if (ts.isCallExpression(n)) {
      const r = callTyped(n, sc);
      if (r) return r;
    }
    return L0(exRaw(n, sc));
  }
  function member(b, k, n) {
    if (b.k === 'reqin') {
      if (k === 'imp') bad(n, 'typed back end: the request Phase reading req.imp');
      b = { k: 'view', rs: 'v_req.v', node: shapes.req };
    }
    if (b.k === 'view' || b.k === 'oview') {
      const ch = b.node.kids.get(k);
      if (!ch) return V_(`rt::get(&${toVal(b)}, ${q(k)})`);
      const f = fname(b.node, k);
      const c = cls(ch);
      if (b.k === 'view') {
        if (c === 'leaf' || c === 'arrleaf') return V_(`${b.rs}.${f}.clone()`);
        if (c === 'list') return { k: 'list', rs: `(&${b.rs}.${f})`, node: ch.el, arr: ch };
        return { k: 'view', rs: `(&${b.rs}.${f})`, node: ch };
      }
      if (c === 'leaf' || c === 'arrleaf') return V_(`${b.rs}.map_or(V::U, |x| x.${f}.clone())`);
      if (c === 'list') return { k: 'olist', rs: `${b.rs}.map(|x| &x.${f})`, node: ch.el, arr: ch };
      return { k: 'oview', rs: `${b.rs}.map(|x| &x.${f})`, node: ch };
    }
    if (b.k === 'plan') return { k: 'pm', plan: b.rs, key: k };
    if (b.k === 'pm') return { k: 'pm', plan: toPlan(b), key: k };
    if (b.k === 'out') return V_(`(${b.rs}).get(ar, ${q(k)})`);
    return V_(`rt::get(&${toVal(b)}, ${q(k)})`);
  }
  // `{ ...src, k: v }` over something with members: a Plan expression, or null (Level 0)
  function objPlan(n, sc) {
    const ps = n.properties;
    if (!ps.length || !ts.isSpreadAssignment(ps[0]) || ps.slice(1).some((p) => ts.isSpreadAssignment(p))) return null;
    const src = tex(ps[0].expression, sc);
    if (!planable(src)) return null;
    let s = `{ let mut pl = ${toPlan(src)}; `;
    for (const p of ps.slice(1)) {
      const [k, x] = ts.isShorthandPropertyAssignment(p) ? [p.name.text, tex(p.name, sc)] : [propName(p.name), tex(p.initializer, sc)];
      s += `{ let o = ${toOut(x)}; pl.set(${q(k)}, o); } `;
    }
    return s + 'pl }';
  }
  function iterOf(x) {
    if (x.k === 'list') return `${x.rs}.items.iter()`;
    if (x.k === 'olist') return `${x.rs}.map_or(&[][..], |l| &l.items[..]).iter()`;
    return `${x.rs}.iter().copied()`;
  }
  function callTyped(n, sc) {
    const c = n.expression, args = n.arguments;
    if (ts.isIdentifier(c)) {
      if (c.text === 'obj') {
        const a = tex(args[0], sc);
        if (a.k === 'view' || a.k === 'oview') return { ...a, objOnly: true };
        return null;
      }
      if (c.text === 'without') {
        const a = tex(args[0], sc);
        if (a.k === 'view' || a.k === 'oview') return { k: 'out', rs: `rt::Out::P(Box::new(${toPlan(a)}.del(&[${args.slice(1).map((k) => q(k.text)).join(', ')}])))` };
        return null;
      }
      if (c.text === 'nonempty') {
        const a = tex(args[0], sc);
        if (a.k === 'out' || a.k === 'plan') return { k: 'out', rs: `rt::Out::nonempty(${toOut(a)})` };
        return V_(`rt::nonempty(${toVal(a)})`);
      }
      return null;
    }
    if (!ts.isPropertyAccessExpression(c)) return null;
    const m = c.name.text, recvText = c.expression.getText(sf);
    if (recvText === 'Object' && m === 'fromEntries') {
      const mc = unwrapE(args[0]);
      const cb = ts.isCallExpression(mc) && ts.isPropertyAccessExpression(mc.expression) && mc.expression.name.text === 'map' ? mc.arguments[0] : null;
      const pair = cb && ts.isArrowFunction(cb) && !ts.isBlock(cb.body) && ts.isArrayLiteralExpression(unwrapE(cb.body)) && unwrapE(cb.body).elements.length === 2 && cb.parameters.length === 1 && ts.isIdentifier(cb.parameters[0].name) ? unwrapE(cb.body).elements : null;
      if (!pair) return null;
      const recv = tex(mc.expression.expression, sc);
      const isc = newScope(sc);
      const xr = `x${tmp++}`;
      let it;
      if (['list', 'olist', 'vlist'].includes(recv.k)) { isc.vars[cb.parameters[0].name.text] = { k: 'view', rs: xr, node: recv.node }; it = iterOf(recv); }
      else { isc.vars[cb.parameters[0].name.text] = { k: 'val', rs: xr }; it = `rt::items(&${toVal(recv)}).iter().cloned()`; }
      return V_(`{ let mut o = rt::O::default(); for ${xr} in ${it} { let k = ${ex(pair[0], isc)}; let v = ${ex(pair[1], isc)}; rt::from_entry(&mut o, k, v); } rt::obj_v(o) }`);
    }
    if (recvText === 'Object' && (m === 'entries' || m === 'keys')) {
      const a = tex(args[0], sc);
      const f = m === 'entries' ? 'entries_mem' : 'keys_mem';
      if (a.k === 'view') return V_(`rt::${f}(ar, ${a.rs}.m, &${a.rs}.v)`);
      if (a.k === 'oview') return V_(`${a.rs}.map_or_else(|| rt::arr_v(vec![]), |x| rt::${f}(ar, x.m, &x.v))`);
      return null;
    }
    if (!['map', 'filter', 'find', 'some', 'every'].includes(m)) return null;
    const recv = tex(c.expression, sc);
    if (!['list', 'olist', 'vlist'].includes(recv.k)) return null;
    const cb = args[0];
    const isc = newScope(sc);
    const p0 = cb.parameters[0];
    if (p0 && !ts.isIdentifier(p0.name)) return null;
    const xr = `x${tmp++}`;
    if (p0) isc.vars[p0.name.text] = { k: 'view', rs: xr, node: recv.node };
    const body = cb.body;
    const it = iterOf(recv);
    if (m === 'filter') return { k: 'vlist', rs: `{ let mut o = Vec::new(); for ${xr} in ${it} { if ${condT(body, isc)} { o.push(${xr}); } } o }`, node: recv.node };
    if (m === 'find') return { k: 'oview', rs: `{ let mut f = None; for ${xr} in ${it} { if ${condT(body, isc)} { f = Some(${xr}); break; } } f }`, node: recv.node };
    if (m === 'map') return V_(`{ let mut o: Vec<V> = Vec::new(); for ${xr} in ${it} { o.push(${toVal(tex(body, isc))}); } rt::arr_v(o) }`);
    if (m === 'some') return V_(`{ let mut f = false; for ${xr} in ${it} { if ${condT(body, isc)} { f = true; break; } } rt::bool_(f) }`);
    return V_(`{ let mut f = true; for ${xr} in ${it} { if !${condT(body, isc)} { f = false; break; } } rt::bool_(f) }`);
  }
  // conditions see through views (their value's truthiness)
  function condT(n, sc) {
    const e = unwrapE(n);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return `!${condT(e.operand, sc)}`;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return `(${condT(e.left, sc)} && ${condT(e.right, sc)})`;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return `(${condT(e.left, sc)} || ${condT(e.right, sc)})`;
    return cond(e, sc);
  }
  // ---------- statements (Level 1) ----------
  function stmts1(list, sc) { return list.map((s) => stmt1(s, sc)).join('\n'); }
  const block1 = (s, sc) => (ts.isBlock(s) ? `{\n${stmts1(s.statements, newScope(sc))}\n}` : `{ ${stmt1(s, newScope(sc))} }`);
  function stmt1(s, sc) {
    const K_ = ts.SyntaxKind;
    switch (s.kind) {
      case K_.Block: return `{\n${stmts1(s.statements, newScope(sc))}\n}`;
      case K_.VariableStatement:
        return s.declarationList.declarations.map((d) => {
          const name = d.name.text;
          const rs = `v_${name}_${tmp++}`;
          const init = unwrapE(d.initializer);
          if (ts.isObjectLiteralExpression(init)) {
            const p = objPlan(init, sc);
            if (p) { sc.vars[name] = { k: 'plan', rs, src: tex(init.properties[0].expression, sc).node }; return `let mut ${rs} = ${p};`; }
          }
          const x = tex(d.initializer, sc);
          if (['view', 'oview', 'list', 'olist', 'vlist'].includes(x.k)) { sc.vars[name] = { ...x, rs }; return `let ${rs} = ${x.rs};`; }
          if (x.k === 'out') { sc.vars[name] = { k: 'out', rs: `${rs}.clone()` }; return `let ${rs} = ${x.rs};`; }
          sc.vars[name] = { k: 'val', rs };
          return `let mut ${rs} = ${toVal(x)};`;
        }).join('\n');
      case K_.IfStatement: return `if ${condT(s.expression, sc)} ${block1(s.thenStatement, sc)}${s.elseStatement ? ` else ${block1(s.elseStatement, sc)}` : ''}`;
      case K_.ReturnStatement: {
        const e = s.expression;
        const fk = sc.fn.kind;
        if (fk === 'helper') return `return ${e ? ex(e, sc) : 'V::U'};`;
        if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'reject') return `return Err(rt::to_string(&${ex(e.arguments[0], sc)}));`;
        if (fk === 'out') return `return Ok(${e ? toOut(tex(e, sc), true) : 'rt::Out::V(V::U)'});`;
        if (fk === 'bid') {
          const lit = e && unwrapE(e);
          if (lit && ts.isObjectLiteralExpression(lit) && !lit.properties.some((p) => ts.isSpreadAssignment(p))) {
            let bidOut = 'None';
            let s2 = `{ let mut o = rt::O::default(); `;
            for (const p of lit.properties) {
              const [k, node] = ts.isShorthandPropertyAssignment(p) ? [p.name.text, p.name] : [propName(p.name), p.initializer];
              if (k === 'bid') bidOut = `Some(${toOut(tex(node, sc))})`;
              else s2 += `{ let x = ${ex(node, sc)}; o.set(${K(k)}, x); } `;
            }
            return `return Ok((${s2}rt::obj_v(o) }, ${bidOut}));`;
          }
          return `return Ok((${e ? ex(e, sc) : 'V::U'}, None));`;
        }
        return `return Ok(${e ? ex(e, sc) : 'V::U'});`;
      }
      case K_.ExpressionStatement: {
        const e = s.expression;
        const L = e.left;
        if (ts.isIdentifier(L)) return `${sc.vars[L.text].rs} = ${ex(e.right, sc)};`;
        const tgt = sc.vars[L.expression.text];
        if (tgt.k === 'plan') return `{ let o = ${toOut(tex(e.right, sc))}; ${tgt.rs}.set(${q(L.name.text)}, o); }`;
        return `{ let x = ${ex(e.right, sc)}; rt::set_v(&mut ${tgt.rs}, ${K(L.name.text)}, x); }`;
      }
      case K_.ForOfStatement: {
        const isc = newScope(sc);
        const name = s.initializer.declarations[0].name.text;
        const src = tex(s.expression, sc);
        const rs = `v_${name}_${tmp++}`;
        if (['list', 'olist', 'vlist'].includes(src.k)) {
          isc.vars[name] = { k: 'view', rs, node: src.node };
          return `for ${rs} in ${iterOf(src)} ${block1(s.statement, isc)}`;
        }
        isc.vars[name] = { k: 'val', rs };
        return `for ${rs} in rt::items(&${toVal(src)}).iter().cloned() ${block1(s.statement, isc)}`;
      }
    }
    bad(s, 'statement');
  }

  // ---------- Phases ----------
  // per Phase role: the Rust parameter and how the Definition sees it
  const roleSig = {
    imp: () => [`v_imp: &'x ${sname(nImp)}<'a>`, { k: 'view', rs: 'v_imp', node: nImp }],
    p: () => [`v_p: &'x ${sname(nP)}<'a>`, { k: 'view', rs: 'v_p', node: nP }],
    req: (phase) => (phase === 'request'
      ? [`v_req: &'x ReqIn<'x, 'a>`, { k: 'reqin', rs: 'v_req' }]
      : [`v_req: &'x ${sname(shapes.req)}<'a>`, { k: 'view', rs: 'v_req', node: shapes.req }]),
    params: () => [`v_params: &'x Vec<&'x ${sname(nP)}<'a>>`, { k: 'vlist', rs: 'v_params', node: nP }],
    bid: () => [`v_bid: &'x ${sname(nBid)}<'a>`, { k: 'view', rs: 'v_bid', node: nBid }],
    bimp: () => [`v_imp: &dyn Fn() -> Option<&'x ${sname(nBimp)}<'a>>`, { k: 'oview', rs: 'v_imp()', node: nBimp }],
    resp: () => [`v_resp: &'x ${sname(shapes.resp)}<'a>`, { k: 'view', rs: 'v_resp', node: shapes.resp }],
  };
  function hookRs(group, name, fnNode) {
    const roles = HOOKS[group === 'core' ? 'core' : 'ext'][name].map((r) => (r === 'imp' && name === 'bid' ? 'bimp' : r));
    const sc = newScope(null);
    const kind = group === 'core' && (name === 'imp' || name === 'request') ? 'out' : group === 'core' && name === 'bid' ? 'bid' : 'val';
    sc.fn = { kind };
    const sig = roles.map((role, i) => {
      const [rsig, view] = roleSig[role](name);
      const p = fnNode.parameters[i];
      if (p) sc.vars[p.name.text] = view;
      return p ? rsig : rsig.replace(/^v_/, '_v_');
    });
    const ret = { out: "rt::Out<'a>", bid: "(V<'a>, Option<rt::Out<'a>>)", val: "V<'a>" }[kind];
    const fin = { out: 'Ok(rt::Out::V(V::U))', bid: 'Ok((V::U, None))', val: 'Ok(V::U)' }[kind];
    let body;
    if (ts.isBlock(fnNode.body)) body = `${stmts1(fnNode.body.statements, sc)}\n${fin}`;
    else body = stmt1(ts.factory.createReturnStatement(fnNode.body), sc).replace(/^return /, '').replace(/;$/, '');
    return `fn ${group}_${name}<'a, 'x>(cx: &'a rt::Cx, ar: &'x rt::Ar<'a>, ${sig.join(', ')}) -> Result<${ret}, String> {\n${body}\n}\n`;
  }
  // ---------- module: helpers, Phases, driver ----------
  let out = '';
  for (const [name, f] of Object.entries(mod.fnNodes)) {
    const params = f.parameters.map((p) => p.name.getText(sf));
    const sc = newScope(null);
    sc.fn = { kind: 'helper' };
    params.forEach((p) => (sc.vars[p] = { k: 'val', rs: `v_${p}` }));
    const body = ts.isBlock(f.body) ? `${stmts1(f.body.statements, sc)}\nV::U` : ex(f.body, sc);
    out += `fn ${mod.fns[name]}<'a>(cx: &'a rt::Cx${params.map((p) => `, v_${p}: V<'a>`).join('')}) -> V<'a> {\n${body}\n}\n`;
  }
  const has = {};
  for (const [g, k, f] of hooks) { out += hookRs(g, k, f); has[`${g}_${k}`] = true; }
  const fld = (n, k) => fname(n, k);
  const nSb = nodeAt('resp', ['seatbid', '*']);
  const okU = (x, d = 'V::U') => `match ${x} { Ok(v) => v, Err(_) => ${d} }`;
  const bidReadsImp = !!hooks.find(([g, k, f]) => k === 'bid' && f.parameters.length > 1);

  let s = `// GENERATED by the PROTOTYPE typed back end (Level 1) from adapters/${path.basename(file)} (${side}) - do not edit.\n`;
  s += `#![allow(unused_variables, unused_mut, unused_braces, unused_parens, unreachable_code, non_snake_case, dead_code, clippy::all)]\n`;
  s += `use prebid_core_rt2::{self as rt, Fr, V};\n\npub const BIDDER: &str = ${q(bidder)};\npub const ENDPOINT: &str = ${q(endpoint)};\n\n`;
  s += `// views: one struct per shape node, one field per key a Phase reads; d<n> decodes one in place\n${typesRs}\n`;
  // the projection contract: per input document, the terminal paths the Phases read ('*' any element,
  // '%' any member); the Host sends only these (whole values at each terminal path)
  const terminals = (n, pre, outp) => {
    if (n.whole) { outp.push(pre); return outp; }
    if (n.el) return terminals(n.el, [...pre, '*'], outp);
    if (n.any) { outp.push([...pre, '%']); }
    if (!n.kids.size) { if (!n.any) outp.push(pre); return outp; }
    for (const [k, c] of n.kids) terminals(c, [...pre, k], outp);
    return outp;
  };
  const shapeJson = JSON.stringify({ req: terminals(shapes.req, [], []), resp: terminals(shapes.resp, [], []), breq: terminals(shapes.breq, [], []) });
  s += `/// What the Phases read, per input document (the Host's projection; see the ABI prototype).\npub const SHAPES: &str = ${q(shapeJson)};\n\n`;
    s += `pub struct ReqIn<'x, 'a> { pub v: &'x ${sname(shapes.req)}<'a>, pub imps: std::rc::Rc<Vec<rt::Out<'a>>>, pub ix: std::rc::Rc<Vec<u32>> }\n`;
  s += `impl<'a> ${sname(shapes.req)}<'a> { fn v_raw(&self) -> Option<&'a [u8]> { if let V::Raw(r) = self.v { Some(r) } else { None } } }\n\n${out}\n`;
  s += `pub fn make_requests(input: &[u8], out: &mut Vec<u8>) {
let cx = rt::Cx::new(); let cx = &cx;
let mut ar: rt::Ar = Vec::with_capacity(128);
let mut req = ${sname(shapes.req)}::default(); d${nid(shapes.req)}(&mut rt::P::new(input), &mut ar, &mut req);
let ar = &ar;
let mut errs: Vec<String> = Vec::new(); let mut imps: Vec<rt::Out> = Vec::new(); let mut params = Vec::new(); let mut ids: Vec<String> = Vec::new();
for imp in req.${fld(shapes.req, 'imp')}.items.iter() {
let p = &imp.${fld(nImp, 'ext')}.${fld(nodeAt('req', ['imp', '*', 'ext']), 'bidder')};
let o = match core_imp(cx, ar, imp, p, &req) { Ok(o) => o, Err(e) => { errs.push(e); continue; } };
${has.ext_imp ? `let o = { let patch = ${okU('ext_imp(cx, ar, imp, p, &req)')}; rt::fill_out(o, &patch, ar) };` : ''}
ids.push(rt::to_string(&o.get(ar, "id"))); imps.push(o); params.push(p);
}
if ids.is_empty() { out.u32(0); } else {
let rq = ReqIn { v: &req, imps: std::rc::Rc::new(imps), ix: std::rc::Rc::new(Vec::new()) };
let o = ${okU('core_request(cx, ar, &rq, &params)', 'rt::Out::V(V::U)')};
${has.ext_request ? `let o = { let patch = ${okU('ext_request(cx, ar, &rq, &params)')}; rt::fill_out(o, &patch, ar) };` : ''}
out.u32(1); let at = out.begin(); rt::emit_out(&o, ar, out); out.end(at);
}
out.u32(ids.len() as u32); for i in &ids { out.bytes(i.as_bytes()); }
out.u32(errs.len() as u32); for e in &errs { out.bytes(e.as_bytes()); }
}

/// ABI #24: MakeRequests over a projected request, returning edits to the Host's own request.
pub fn make_requests_edits(input: &[u8], out: &mut Vec<u8>) {
let cx = rt::Cx::new(); let cx = &cx;
let mut ar: rt::Ar = Vec::with_capacity(128);
let mut req = ${sname(shapes.req)}::default(); d${nid(shapes.req)}(&mut rt::P::new(input), &mut ar, &mut req);
let ar = &ar;
let mut errs: Vec<String> = Vec::new(); let mut imps: Vec<rt::Out> = Vec::new(); let mut ix: Vec<u32> = Vec::new(); let mut params = Vec::new(); let mut ids: Vec<String> = Vec::new();
for (i, imp) in req.${fld(shapes.req, 'imp')}.items.iter().enumerate() {
let p = &imp.${fld(nImp, 'ext')}.${fld(nodeAt('req', ['imp', '*', 'ext']), 'bidder')};
let o = match core_imp(cx, ar, imp, p, &req) { Ok(o) => o, Err(e) => { errs.push(e); continue; } };
${has.ext_imp ? `let o = { let patch = ${okU('ext_imp(cx, ar, imp, p, &req)')}; rt::Out::Fill(Box::new(o), patch) };` : ''}
ids.push(rt::to_string(&o.get(ar, "id"))); imps.push(o); ix.push(i as u32); params.push(p);
}
if ids.is_empty() { out.u32(0); } else {
let rq = ReqIn { v: &req, imps: std::rc::Rc::new(imps), ix: std::rc::Rc::new(ix) };
let o = ${okU('core_request(cx, ar, &rq, &params)', 'rt::Out::V(V::U)')};
${has.ext_request ? `let o = { let patch = ${okU('ext_request(cx, ar, &rq, &params)')}; rt::Out::Fill(Box::new(o), patch) };` : ''}
out.u32(1); let at = out.begin(); rt::emit_edit(&o, ar, req.v_raw(), out); out.end(at);
}
out.u32(ids.len() as u32); for i in &ids { out.bytes(i.as_bytes()); }
out.u32(errs.len() as u32); for e in &errs { out.bytes(e.as_bytes()); }
}

pub fn make_bids(req_b: &[u8], resp_b: &[u8], out: &mut Vec<u8>) {
let cx = rt::Cx::new(); let cx = &cx;
let mut ar: rt::Ar = Vec::with_capacity(64);
let mut resp = ${sname(shapes.resp)}::default(); d${nid(shapes.resp)}(&mut rt::P::new(resp_b), &mut ar, &mut resp);
let ar = &ar;
// the outgoing request is decoded only if a bid Phase reads its imp
let breq: std::cell::OnceCell<${sname(shapes.breq)}> = std::cell::OnceCell::new();
let mut errs: Vec<String> = Vec::new();
let n_at = out.len(); out.u32(0); let mut n = 0u32;
for sb in resp.${fld(shapes.resp, 'seatbid')}.items.iter() { for bid in sb.${fld(nSb, 'bid')}.items.iter() {
n += 1;
let imp_f = || -> Option<&${sname(nBimp)}> { ${bidReadsImp ? `let b = breq.get_or_init(|| { let mut a2: rt::Ar = Vec::new(); let mut b = ${sname(shapes.breq)}::default(); d${nid(shapes.breq)}(&mut rt::P::new(req_b), &mut a2, &mut b); b }); b.${fld(shapes.breq, 'imp')}.items.iter().find(|i| rt::eq(&i.${fld(nBimp, 'id')}, &bid.${fld(nBid, 'impid')}))` : 'None'} };
match core_bid(cx, ar, bid, &imp_f, &resp) {
Err(e) => { errs.push(e); for _ in 0..7 { out.u32(0); } }
Ok((r, ob)) => {
let w = rt::get(&r, "warning"); if !rt::is_undef(&w) { errs.push(rt::to_string(&w)); }
out.u32(1); rt::str_slot(&rt::get(&r, "type"), out); rt::str_slot(&rt::get(&r, "seat"), out);
let dp = rt::get(&r, "dealPriority"); out.u32({ let f = rt::f64_(&dp); if f.is_nan() { 0 } else { f as i32 as u32 } });
rt::kv_slot(&rt::get(&r, "video"), out);
let meta = rt::get(&r, "meta");
${has.ext_bid ? `let meta = { let patch = rt::get(&${okU('ext_bid(cx, ar, bid, &imp_f)')}, "meta"); let base = if rt::is_undef(&meta) { rt::obj_v(rt::O::default()) } else { meta }; rt::nonempty(rt::fill(base, &patch)) };` : ''}
rt::kv_slot(&meta, out);
match ob { Some(o) => rt::plan_overrides(&bid.v, &o, ar, out), None => out.u32(0) }
}
}
}}
out.patch(n_at, n);
let r = ${okU('core_response(cx, ar, &resp)')};
rt::str_slot(&rt::get(&r, "currency"), out); rt::json_slot(&rt::get(&r, "paapi"), out);
out.u32(errs.len() as u32); for e in &errs { out.bytes(e.as_bytes()); }
}
`;
  return { rs: s, errors: [] };
}

function num(text) {
  const v = Number(text.replace(/_/g, ''));
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}
