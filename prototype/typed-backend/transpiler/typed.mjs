// PROTOTYPE typed Rust back end for the Definition Compiler (#17). Same front end and subset rules as
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

export function transpileTyped(file, side = 'server') {
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
  function newNode() { return { kids: new Map(), any: null, el: null, index: false }; }
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
        if (p) need(p.root, p.segs).index = true;
      }
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        if (ts.isIdentifier(c) && c.text === 'without') {
          const p = pathOf(n.arguments[0], al);
          if (p) need(p.root, p.segs).index = true;
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
          if (p) need(p.root, p.segs).index = true;
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

  // shapes -> Rust statics
  let shapeId = 0;
  const statics = [];
  function shapeRs(n) {
    const leaf = !n.index && !n.el && !n.any && !n.kids.size;
    if (leaf) return 'rt::LEAF';
    const id = `SH${shapeId++}`;
    let body;
    if (n.el) body = `rt::Shape::Arr(&${shapeRs(n.el)})`;
    else if (n.any) {
      const merged = n.any;
      for (const [, c] of n.kids) mergeInto(merged, c);
      body = `rt::Shape::All(&${shapeRs(merged)})`;
    } else body = `rt::Shape::Obj(&[${[...n.kids].map(([k, c]) => `(${q(k)}, &${shapeRs(c)})`).join(', ')}])`;
    statics.push(`static ${id}: rt::Shape = ${body};`);
    return id;
  }
  function mergeInto(a, b) {
    a.index ||= b.index;
    if (b.el) mergeInto(a.el ??= newNode(), b.el);
    if (b.any) mergeInto(a.any ??= newNode(), b.any);
    for (const [k, c] of b.kids) { if (!a.kids.has(k)) a.kids.set(k, newNode()); mergeInto(a.kids.get(k), c); }
  }

  // ================================================================ emission
  const newScope = (parent) => ({ vars: Object.create(parent?.vars ?? null), fn: parent?.fn });
  const v = (n, sc) => {
    const x = sc.vars[n];
    if (!x) bad({ getText: () => n }, 'unknown name');
    return x.call ? x.rs : `${x.rs}.clone()`;
  };

  function ex(n, sc) {
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
        return `${op === K_.ExclamationEqualsToken ? '!' : ''}rt::nullish(&${ex(other, sc)})`;
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
    return `rt::truthy(&${ex(n, sc)})`;
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
        isc.vars[p0.name.text] = { rs };
        binds = `let ${rs} = ${item}.clone();`;
      } else p0.name.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        const rs = `v_${el.name.text}_${tmp++}`;
        isc.vars[el.name.text] = { rs };
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

  function stmts(list, sc) { return list.map((s) => stmt(s, sc)).join('\n'); }
  function stmt(s, sc) {
    const K_ = ts.SyntaxKind;
    switch (s.kind) {
      case K_.Block: return `{\n${stmts(s.statements, newScope(sc))}\n}`;
      case K_.VariableStatement:
        return s.declarationList.declarations.map((d) => {
          const rs = `v_${d.name.text}_${tmp++}`;
          const code = `let mut ${rs} = ${ex(d.initializer, sc)};`;
          sc.vars[d.name.text] = { rs };
          return code;
        }).join('\n');
      case K_.IfStatement: return `if ${cond(s.expression, sc)} ${block(s.thenStatement, sc)}${s.elseStatement ? ` else ${block(s.elseStatement, sc)}` : ''}`;
      case K_.ReturnStatement: {
        const e = s.expression;
        if (sc.fn.kind === 'helper') return `return ${e ? ex(e, sc) : 'rt::U'};`;
        if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'reject') return `return Err(rt::to_string(&${ex(e.arguments[0], sc)}));`;
        return `return Ok(${e ? ex(e, sc) : 'rt::U'});`;
      }
      case K_.ExpressionStatement: {
        const e = s.expression;
        const L = e.left;
        if (ts.isIdentifier(L)) return `${sc.vars[L.text].rs} = ${ex(e.right, sc)};`;
        return `{ let x = ${ex(e.right, sc)}; rt::set_v(&mut ${sc.vars[L.expression.text].rs}, ${K(L.name.text)}, x); }`;
      }
      case K_.ForOfStatement: {
        const isc = newScope(sc);
        const rs = `v_${s.initializer.declarations[0].name.text}_${tmp++}`;
        isc.vars[s.initializer.declarations[0].name.text] = { rs };
        return `for ${rs} in rt::items(&${ex(s.expression, sc)}).iter().cloned() ${block(s.statement, isc)}`;
      }
    }
    bad(s, 'statement');
  }
  const block = (s, sc) => (ts.isBlock(s) ? `{\n${stmts(s.statements, newScope(sc))}\n}` : `{ ${stmt(s, newScope(sc))} }`);

  function fnBody(fnNode, params, kind) {
    const sc = newScope(null);
    sc.fn = { kind };
    const sig = [];
    fnNode.parameters.forEach((p, i) => {
      const role = params[i];
      if (kind === 'hook' && role === 'imp' && params.includes('bid')) {
        sc.vars[p.name.text] = { rs: `v_imp()`, call: true };
        sig.push([role, `v_imp: &dyn Fn() -> V<'a>`]);
      } else {
        sc.vars[p.name.text] = { rs: `v_${p.name.text}` };
        sig.push([role, `v_${p.name.text}: V<'a>`]);
      }
    });
    const ok = kind === 'helper' ? (x) => x : (x) => `Ok(${x})`;
    const body = ts.isBlock(fnNode.body) ? `${stmts(fnNode.body.statements, sc)}\n${ok('rt::U')}` : ok(ex(fnNode.body, sc));
    return { sig, body };
  }

  let out = '';
  for (const [name, f] of Object.entries(mod.fnNodes)) {
    const params = f.parameters.map((p) => p.name.getText(sf));
    const { body } = fnBody(f, params, 'helper');
    out += `fn ${mod.fns[name]}<'a>(cx: &'a rt::Cx${params.map((p) => `, v_${p}: V<'a>`).join('')}) -> V<'a> {\n${body}\n}\n`;
  }
  const has = {};
  for (const [g, k, f] of hooks) {
    const params = HOOKS[g === 'core' ? 'core' : 'ext'][k];
    const { sig, body } = fnBody(f, params, 'hook');
    const names = new Map(sig);
    const full = params.map((p) => names.get(p) ?? (p === 'imp' && params.includes('bid') ? `_imp: &dyn Fn() -> V<'a>` : `_${p}: V<'a>`));
    out += `fn ${g}_${k}<'a>(cx: &'a rt::Cx, ${full.join(', ')}) -> Result<V<'a>, String> {\n${body}\n}\n`;
    has[`${g}_${k}`] = true;
  }
  const shReq = shapeRs(shapes.req), shResp = shapeRs(shapes.resp), shBreq = shapeRs(shapes.breq);
  const okU = (x) => `match ${x} { Ok(v) => v, Err(_) => rt::U }`;

  let s = `// GENERATED by the PROTOTYPE typed back end from adapters/${path.basename(file)} (${side}) - do not edit.\n`;
  s += `#![allow(unused_variables, unused_mut, unused_braces, unused_parens, unreachable_code, non_snake_case, clippy::all)]\n`;
  s += `use prebid_core_rt2::{self as rt, Fr, V};\n\npub const BIDDER: &str = ${q(bidder)};\npub const ENDPOINT: &str = ${q(endpoint)};\n\n`;
  s += `// what the Phases read, per input document\n${statics.join('\n')}\n\n${out}\n`;
  s += `pub fn make_requests(input: &[u8], out: &mut Vec<u8>) {
let cx = rt::Cx::new(); let cx = &cx;
let req = rt::parse(input, &${shReq});
let mut errs: Vec<String> = Vec::new(); let mut imps: Vec<V> = Vec::new(); let mut params: Vec<V> = Vec::new(); let mut ids: Vec<String> = Vec::new();
for imp in rt::items(&rt::get(&req, "imp")).iter().cloned() {
let p = rt::get(&rt::get(&imp, "ext"), "bidder");
let o = match core_imp(cx, imp.clone(), p.clone(), req.clone()) { Ok(o) => o, Err(e) => { errs.push(e); continue; } };
${has.ext_imp ? `let o = { let patch = ${okU('ext_imp(cx, imp.clone(), p.clone(), req.clone())')}; rt::fill(o, &patch) };` : ''}
ids.push(rt::to_string(&rt::get(&o, "id"))); imps.push(o); params.push(p);
}
if ids.is_empty() { out.u32(0); } else {
let mut r = rt::spread(&req); r.set(rt::Js::Esc(b"imp"), rt::arr_v(imps)); let r = rt::obj_v(r); let pl = rt::arr_v(params);
let o = ${okU('core_request(cx, r.clone(), pl.clone())')};
${has.ext_request ? `let o = { let patch = ${okU('ext_request(cx, r.clone(), pl.clone())')}; rt::fill(o, &patch) };` : ''}
out.u32(1); let at = out.begin(); rt::emit(&o, out); out.end(at);
}
out.u32(ids.len() as u32); for i in &ids { out.bytes(i.as_bytes()); }
out.u32(errs.len() as u32); for e in &errs { out.bytes(e.as_bytes()); }
}

pub fn make_bids(req_b: &[u8], resp_b: &[u8], out: &mut Vec<u8>) {
let cx = rt::Cx::new(); let cx = &cx;
let resp = rt::parse(resp_b, &${shResp});
// the outgoing request is decoded only if a bid Phase reads its imp
let imps: std::cell::OnceCell<std::rc::Rc<Vec<V>>> = std::cell::OnceCell::new();
let mut errs: Vec<String> = Vec::new();
let n_at = out.len(); out.u32(0); let mut n = 0u32;
for sb in rt::items(&rt::get(&resp, "seatbid")).iter() { for bid in rt::items(&rt::get(sb, "bid")).iter().cloned() {
n += 1;
let imp_f = || -> V { let id = rt::get(&bid, "impid"); imps.get_or_init(|| rt::items(&rt::get(&rt::parse(req_b, &${shBreq}), "imp"))).iter().find(|i| rt::eq(&rt::get(i, "id"), &id)).cloned().unwrap_or(rt::U) };
match core_bid(cx, bid.clone(), &imp_f, resp.clone()) {
Err(e) => { errs.push(e); for _ in 0..7 { out.u32(0); } }
Ok(r) => {
let w = rt::get(&r, "warning"); if !rt::is_undef(&w) { errs.push(rt::to_string(&w)); }
out.u32(1); rt::str_slot(&rt::get(&r, "type"), out); rt::str_slot(&rt::get(&r, "seat"), out);
let dp = rt::get(&r, "dealPriority"); out.u32({ let f = rt::f64_(&dp); if f.is_nan() { 0 } else { f as i32 as u32 } });
rt::kv_slot(&rt::get(&r, "video"), out);
let meta = rt::get(&r, "meta");
${has.ext_bid ? `let meta = { let patch = rt::get(&${okU('ext_bid(cx, bid.clone(), &imp_f)')}, "meta"); let base = if rt::is_undef(&meta) { rt::obj_v(rt::O::default()) } else { meta }; rt::nonempty(rt::fill(base, &patch)) };` : ''}
rt::kv_slot(&meta, out);
rt::overrides(&bid, &rt::get(&r, "bid"), out);
}
}
}}
out.patch(n_at, n);
let r = ${okU('core_response(cx, resp.clone())')};
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
