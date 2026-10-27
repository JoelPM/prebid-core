// PROTOTYPE transpiler: a Shared Adapter in restricted TypeScript -> Rust for the server Hosts.
// Front end: the TypeScript compiler (parse + type check). The subset checker runs as part of the walk:
// anything it can't map to JS-exact Rust is an error at its source location (see SUBSET.md).
// Back end: Rust against runtime/rs (prebid_core_rt), the Definition prototype's dynamic runtime plus
// js.rs. Every runtime call takes `&mut Doc`, so each operand is bound to a local in a nested block.
import ts from 'typescript';
import path from 'node:path';

const q = JSON.stringify;
const rsStr = (s) => q(q(s).slice(1, -1)); // JSON-escaped content as a Rust string literal (d.lit takes escaped text)

// Prebid Core helpers an Adapter may import, and the runtime call each becomes
const CORE_FNS = { str: 'str_', num: 'num_', int: 'int', nonempty: 'nonempty', obj: 'obj_', parseJson: 'json', formEncode: 'form_encode' };
// Phase positions: the driver passes these arguments, by position
const HOOKS = {
  core: { imp: ['imp', 'p', 'req', 'host'], group: ['imp', 'p', 'host'], request: ['req', 'params', 'host'], bid: ['bid', 'imp', 'resp', 'http', 'host'], response: ['resp', 'http', 'host'] },
  ext: { imp: ['imp', 'p', 'req'], request: ['req', 'params'], bid: ['bid', 'imp'] },
};
const REJECTING = new Set(['core.imp', 'core.bid', 'core.request', 'core.response']);

export function transpile(file, side = 'server') {
  const configPath = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram([file], { ...cfg.options, noEmit: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const errors = [];
  const diags = ts.getPreEmitDiagnostics(program, sf);
  for (const dg of diags) errors.push(`${where(dg.file, dg.start)}: type error: ${ts.flattenDiagnosticMessageText(dg.messageText, '\n')}`);
  if (errors.length) return { errors };

  let tmp = 0;
  const t = () => `t${tmp++}`;
  function fail(node, msg) {
    errors.push(`${where(sf, node.getStart(sf))}: ${msg}: \`${node.getText(sf).split('\n')[0].slice(0, 80)}\``);
    return 'rt::ABSENT';
  }

  // ---------- types ----------
  const typeOf = (n) => checker.getTypeAtLocation(n);
  const parts = (ty) => (ty.isUnion() ? ty.types : [ty]);
  const nonNull = (ty) => parts(ty).filter((p) => !(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
  const isAny = (ty) => !!(ty.flags & ts.TypeFlags.Any);
  const isStr = (ty) => nonNull(ty).length > 0 && nonNull(ty).every((p) => p.flags & ts.TypeFlags.StringLike);
  const isNum = (ty) => nonNull(ty).length > 0 && nonNull(ty).every((p) => p.flags & ts.TypeFlags.NumberLike);
  const isArr = (ty) => nonNull(ty).length > 0 && nonNull(ty).every((p) => checker.isArrayType(p) || checker.isTupleType(p));
  const isScalarish = (ty) => parts(ty).every((p) => p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null));

  // ---------- module scope: imports, lookup tables, helper functions ----------
  const mod = { tables: {}, fns: {}, consts: {}, coreImports: new Set() };
  let defObj = null;
  const fnItems = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const from = st.moduleSpecifier.text;
      const typeOnly = st.importClause?.isTypeOnly;
      if (typeOnly) continue;
      if (!/core\/index\.ts$/.test(from)) { fail(st, 'only Prebid Core (and type-only imports) may be imported'); continue; }
      for (const el of st.importClause?.namedBindings?.elements ?? []) {
        if (el.isTypeOnly) continue;
        const name = el.name.text;
        if (!(name in CORE_FNS) && !['defineAdapter', 'reject', 'without'].includes(name)) fail(el, `not a Prebid Core helper`);
        mod.coreImports.add(name);
      }
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      continue;
    } else if (ts.isExportAssignment(st)) {
      const e = st.expression;
      if (ts.isCallExpression(e) && e.expression.getText(sf) === 'defineAdapter' && ts.isObjectLiteralExpression(e.arguments[0])) defObj = e.arguments[0];
      else fail(st, 'the default export must be defineAdapter({...})');
    } else if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
      for (const dcl of st.declarationList.declarations) {
        const name = dcl.name.getText(sf);
        let init = dcl.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
        if (init && ts.isArrowFunction(init)) {
          mod.fns[name] = `f_${name}`;
          fnItems.push([name, init]);
        } else if (init && ts.isObjectLiteralExpression(init) && init.properties.every((p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer))) {
          mod.tables[name] = init.properties.map((p) => [propName(p.name), p.initializer.text]);
        } else if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
          mod.consts[name] = init;
        } else fail(dcl, 'module-level consts must be helper functions (arrow), lookup tables of string literals, or string/number literals');
      }
    } else fail(st, 'not allowed at module level');
  }
  if (!defObj) return { errors: errors.length ? errors : ['no default export defineAdapter({...})'] };

  // ---------- the definition ----------
  const prop = (o, k) => o.properties.find((p) => p.name && propName(p.name) === k);
  const strProp = (o, k) => {
    const p = prop(o, k);
    if (!p) return undefined;
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer)) return fail(p, `${k} must be a string literal`), undefined;
    return p.initializer.text;
  };
  const bidder = strProp(defObj, 'bidder');
  const sideObj = (() => {
    const p = prop(defObj, side);
    return p && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer) ? p.initializer : null;
  })();
  const endpoint = (sideObj && strProp(sideObj, 'endpoint')) ?? strProp(defObj, 'endpoint');
  const coreObj = prop(defObj, 'core')?.initializer;
  if (!coreObj || !ts.isObjectLiteralExpression(coreObj)) return { errors: [...errors, 'core: {...} is required'] };
  const hookFn = (o, k) => {
    const p = o && prop(o, k);
    if (!p) return null;
    if (ts.isMethodDeclaration(p)) return p;
    if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.initializer;
    return fail(p, 'Phases must be methods or arrow functions'), null;
  };

  // ---------- scopes ----------
  // var: { rs, fresh (object/array this function created; may be written), escaped, mutable (let) }
  const newScope = (parent) => ({ vars: Object.create(parent?.vars ?? null), fn: parent?.fn });
  const lookupVar = (sc, name) => sc.vars[name];

  // ---------- expressions: Rust expression evaluating to a V ----------
  function ex(n, sc) {
    if (isAny(typeOf(n)) && !ts.isObjectLiteralExpression(n) && !ts.isArrayLiteralExpression(n)) fail(n, '`any` is not allowed');
    switch (n.kind) {
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.NonNullExpression:
        return ex(n.expression, sc);
      case ts.SyntaxKind.NumericLiteral: return `d.num(${num(n.text)})`;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return `d.lit(${rsStr(n.text)})`;
      case ts.SyntaxKind.TrueKeyword: return 'rt::TRUE';
      case ts.SyntaxKind.FalseKeyword: return 'rt::FALSE';
      case ts.SyntaxKind.NullKeyword: return 'rt::NULL';
      case ts.SyntaxKind.Identifier: {
        if (n.text === 'undefined') return 'rt::ABSENT';
        const v = lookupVar(sc, n.text);
        if (v) { markEscape(n, v); return v.rs; }
        if (mod.consts[n.text]) return ex(mod.consts[n.text], sc);
        if (mod.tables[n.text]) return fail(n, 'lookup tables can only be indexed');
        return fail(n, 'unknown name');
      }
      case ts.SyntaxKind.TemplateExpression: {
        const s = t();
        let body = n.head.text ? `${s}.push_str(${q(n.head.text)}); ` : '';
        for (const span of n.templateSpans) {
          if (!isScalarish(typeOf(span.expression))) fail(span.expression, 'template interpolations must be strings, numbers, booleans, null or undefined');
          body += `{ let v = ${ex(span.expression, sc)}; d.tmpl_js(&mut ${s}, v); } `;
          if (span.literal.text) body += `${s}.push_str(${q(span.literal.text)}); `;
        }
        return `{ let mut ${s} = String::new(); ${body}d.new_str(&${s}) }`;
      }
      case ts.SyntaxKind.PropertyAccessExpression: {
        const k = n.name.text;
        if (k === 'length') {
          const ty = typeOf(n.expression);
          if (!isStr(ty) && !isArr(ty)) return fail(n, '.length only on strings and arrays');
          const a = t();
          return `{ let ${a} = ${ex(n.expression, sc)}; d.len_js(${a}) }`;
        }
        const a = t();
        return `{ let ${a} = ${ex(n.expression, sc)}; d.get(${a}, ${q(k)}) }`;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const arg = n.argumentExpression;
        if (ts.isIdentifier(n.expression) && mod.tables[n.expression.text]) {
          const a = t();
          return `{ let ${a} = ${ex(arg, sc)}; d.lookup(${a}, &[${mod.tables[n.expression.text].map(([k, v]) => `(${q(k)}, ${rsStr(v)})`).join(', ')}]) }`;
        }
        const a = t();
        if (ts.isNumericLiteral(arg)) return `{ let ${a} = ${ex(n.expression, sc)}; d.at(${a}, ${+arg.text}) }`;
        if (ts.isStringLiteral(arg)) return `{ let ${a} = ${ex(n.expression, sc)}; d.get(${a}, ${q(arg.text)}) }`;
        const b = t();
        return `{ let ${a} = ${ex(n.expression, sc)}; let ${b} = ${ex(arg, sc)}; d.index(${a}, ${b}) }`;
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        if (n.operator === ts.SyntaxKind.ExclamationToken) return `{ let b = !${cond(n.operand, sc)}; d.bool(b) }`;
        if (n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return `d.num(-${num(n.operand.text)})`;
        return fail(n, 'unary operator not allowed (coerce with Prebid Core str/num/int)');
      }
      case ts.SyntaxKind.ConditionalExpression:
        return `if ${cond(n.condition, sc)} { ${ex(n.whenTrue, sc)} } else { ${ex(n.whenFalse, sc)} }`;
      case ts.SyntaxKind.BinaryExpression: return binary(n, sc);
      case ts.SyntaxKind.ObjectLiteralExpression: return objLit(n, sc);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const a = t();
        const items = n.elements.map((e) =>
          ts.isSpreadElement(e) ? `{ let v = ${ex(e.expression, sc)}; d.extend(${a}, v); }` : `{ let v = ${ex(e, sc)}; d.push_js(${a}, v); }`);
        return `{ let ${a} = d.arr(); ${items.join(' ')} ${a} }`;
      }
      case ts.SyntaxKind.CallExpression: return call(n, sc);
      case ts.SyntaxKind.TypeOfExpression: return fail(n, 'typeof only in a comparison with a string literal');
    }
    return fail(n, `${ts.SyntaxKind[n.kind]} is not in the subset`);
  }

  // writes to a fresh local are only allowed before it escapes (JS objects are references; Rust values aren't)
  function markEscape(n, v) {
    if (!v.fresh) return;
    const p = n.parent;
    const isRead = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n;
    const isWriteTarget = ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === n;
    if (!isRead && !isWriteTarget) v.escaped = true;
  }

  function binary(n, sc) {
    const op = n.operatorToken.kind;
    const K = ts.SyntaxKind;
    const [a, b] = [t(), t()];
    switch (op) {
      case K.QuestionQuestionToken: return `{ let ${a} = ${ex(n.left, sc)}; if d.nullish(${a}) { ${ex(n.right, sc)} } else { ${a} } }`;
      case K.BarBarToken: return `{ let ${a} = ${ex(n.left, sc)}; if d.truthy(${a}) { ${a} } else { ${ex(n.right, sc)} } }`;
      case K.AmpersandAmpersandToken: return `{ let ${a} = ${ex(n.left, sc)}; if !d.truthy(${a}) { ${a} } else { ${ex(n.right, sc)} } }`;
      case K.PlusToken: case K.MinusToken: case K.AsteriskToken: case K.SlashToken: case K.PercentToken:
        if (!isNum(typeOf(n.left)) || !isNum(typeOf(n.right))) return fail(n, 'arithmetic only on numbers (build strings with templates)');
        return `{ let ${a} = ${ex(n.left, sc)}; let ${b} = ${ex(n.right, sc)}; d.arith(${a}, ${b}, b'${n.operatorToken.getText(sf)}') }`;
      case K.EqualsToken: return fail(n, 'assignment is a statement, not an expression');
    }
    if ([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken, K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken].includes(op)) {
      return `{ let r = ${cond(n, sc)}; d.bool(r) }`;
    }
    return fail(n, 'operator not in the subset');
  }

  // a Rust bool: JS truthiness of n
  function cond(n, sc) {
    const K = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (ts.isPrefixUnaryExpression(n) && n.operator === K.ExclamationToken) return `!${cond(n.operand, sc)}`;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken) return `(${cond(n.left, sc)} && ${cond(n.right, sc)})`;
      if (op === K.BarBarToken) return `(${cond(n.left, sc)} || ${cond(n.right, sc)})`;
      const isNull = (e) => e.kind === K.NullKeyword;
      const isUndef = (e) => ts.isIdentifier(e) && e.text === 'undefined';
      if (op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken) {
        if (!isNull(n.left) && !isNull(n.right)) return fail(n, 'loose equality only as `== null` / `!= null`'), 'false';
        const other = isNull(n.left) ? n.right : n.left;
        const a = t();
        return `${op === K.ExclamationEqualsToken ? '!' : ''}{ let ${a} = ${ex(other, sc)}; d.nullish(${a}) }`;
      }
      if (op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken) {
        const neg = op === K.ExclamationEqualsEqualsToken ? '!' : '';
        if (isUndef(n.left) || isUndef(n.right)) {
          const a = t();
          return `${neg}{ let ${a} = ${ex(isUndef(n.left) ? n.right : n.left, sc)}; d.is_undef(${a}) }`;
        }
        const ty = ts.isTypeOfExpression(n.left) ? n.left : ts.isTypeOfExpression(n.right) ? n.right : null;
        if (ty) {
          const lit = ty === n.left ? n.right : n.left;
          if (!ts.isStringLiteral(lit)) return fail(n, 'typeof must be compared with a string literal'), 'false';
          const a = t();
          return `${neg}({ let ${a} = ${ex(ty.expression, sc)}; d.typeof_js(${a}) } == ${q(lit.text)})`;
        }
        const [a, b] = [t(), t()];
        return `${neg}{ let ${a} = ${ex(n.left, sc)}; let ${b} = ${ex(n.right, sc)}; d.eq(${a}, ${b}) }`;
      }
      const cmp = { [K.LessThanToken]: 'lt', [K.GreaterThanToken]: 'gt', [K.LessThanEqualsToken]: 'le', [K.GreaterThanEqualsToken]: 'ge' }[op];
      if (cmp) {
        if (!isNum(typeOf(n.left)) || !isNum(typeOf(n.right))) return fail(n, 'ordering comparisons only between numbers'), 'false';
        const [a, b] = [t(), t()];
        return `{ let ${a} = ${ex(n.left, sc)}; let ${b} = ${ex(n.right, sc)}; d.${cmp}(${a}, ${b}) }`;
      }
    }
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Array.isArray') {
      const a = t();
      return `{ let ${a} = ${ex(n.arguments[0], sc)}; d.is_array(${a}) }`;
    }
    const a = t();
    return `{ let ${a} = ${ex(n, sc)}; d.truthy(${a}) }`;
  }

  function objLit(n, sc) {
    const o = t();
    let s = '';
    let started = false;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        if (!started) s += `let ${o} = { let src = ${ex(p.expression, sc)}; d.own(src) }; `;
        else s += `{ let src = ${ex(p.expression, sc)}; d.assign(${o}, src); } `;
      } else {
        if (!started) s += `let ${o} = d.obj(); `;
        if (ts.isPropertyAssignment(p)) {
          if (ts.isComputedPropertyName(p.name)) { fail(p, 'computed keys are not allowed'); continue; }
          s += `{ let v = ${ex(p.initializer, sc)}; d.set(${o}, ${q(propName(p.name))}, v); } `;
        } else if (ts.isShorthandPropertyAssignment(p)) {
          s += `{ let v = ${ex(p.name, sc)}; d.set(${o}, ${q(p.name.text)}, v); } `;
        } else fail(p, 'methods and accessors are not allowed in object literals');
      }
      started = true;
    }
    if (!started) s = `let ${o} = d.obj(); `;
    return `{ ${s}${o} }`;
  }

  // callbacks (array methods): an arrow with an expression body; params bound per element
  function callback(fnNode, sc, item) {
    if (!fnNode || !ts.isArrowFunction(fnNode)) return [fail(fnNode ?? sf, 'expected an arrow function'), newScope(sc), ''];
    if (ts.isBlock(fnNode.body)) fail(fnNode, 'callbacks must have an expression body (use a module-level helper)');
    const isc = newScope(sc);
    let binds = '';
    const p0 = fnNode.parameters[0];
    if (p0) {
      if (ts.isIdentifier(p0.name)) {
        const rs = `v_${p0.name.text}_${tmp++}`;
        isc.vars[p0.name.text] = { rs };
        binds = `let ${rs} = ${item};`;
      } else if (ts.isArrayBindingPattern(p0.name)) {
        p0.name.elements.forEach((el, i) => {
          if (ts.isOmittedExpression(el)) return;
          const rs = `v_${el.name.text}_${tmp++}`;
          isc.vars[el.name.text] = { rs };
          binds += `let ${rs} = d.at(${item}, ${i}); `;
        });
      } else fail(p0, 'object destructuring is not in the subset');
    }
    const p1 = fnNode.parameters[1];
    if (p1) {
      // the element's index, as JS passes it
      if (!ts.isIdentifier(p1.name)) fail(p1, 'the index parameter must be a name');
      else {
        const rs = `v_${p1.name.text}_${tmp++}`;
        isc.vars[p1.name.text] = { rs };
        binds += ` let ${rs} = d.num(ix);`;
      }
    }
    if (fnNode.parameters.length > 2) fail(fnNode.parameters[2], 'callbacks take (element, index) at most');
    return [binds, isc, fnNode.body];
  }

  function call(n, sc) {
    const callee = n.expression;
    const args = n.arguments;
    if (args.some((a) => ts.isSpreadElement(a))) return fail(n, 'spread arguments are not allowed');
    const bind = (xs) => {
      const names = xs.map(() => t());
      return [names, xs.map((a, i) => `let ${names[i]} = ${ex(a, sc)};`).join(' ')];
    };
    // Prebid Core helpers and module helpers
    if (ts.isIdentifier(callee)) {
      const name = callee.text;
      if (name === 'reject') return fail(n, 'reject(...) only as `return reject(message)` in the core imp / bid Phases');
      if (name === 'without' && mod.coreImports.has(name)) {
        if (!args.slice(1).every(ts.isStringLiteral)) return fail(n, 'without(o, ...keys) takes literal keys');
        const a = t();
        return `{ let ${a} = ${ex(args[0], sc)}; d.without(${a}, &[${args.slice(1).map((k) => q(k.text)).join(', ')}]) }`;
      }
      if (CORE_FNS[name] && mod.coreImports.has(name)) {
        const [ns, bs] = bind(args);
        return `{ ${bs} d.${CORE_FNS[name]}(${ns.join(', ')}) }`;
      }
      if (mod.fns[name]) {
        const [ns, bs] = bind(args);
        return `{ ${bs} ${mod.fns[name]}(d${ns.map((x) => ', ' + x).join('')}) }`;
      }
      if (['String', 'Number', 'parseInt', 'parseFloat', 'Boolean'].includes(name)) return fail(n, 'JS coercions are not allowed (use Prebid Core str/num/int)');
      return fail(n, 'unknown function');
    }
    if (!ts.isPropertyAccessExpression(callee)) return fail(n, 'call not in the subset');
    const m = callee.name.text;
    const recvText = callee.expression.getText(sf);
    const statics = {
      'Object.entries': () => `{ let a = ${ex(args[0], sc)}; d.entries_js(a) }`,
      'Object.keys': () => `{ let a = ${ex(args[0], sc)}; d.keys(a) }`,
      'Object.fromEntries': () => `{ let a = ${ex(args[0], sc)}; d.from_entries_js(a) }`,
      'JSON.stringify': () => (args.length !== 1 ? fail(n, 'JSON.stringify takes one argument') : `{ let a = ${ex(args[0], sc)}; d.stringify(a) }`),
      'Math.max': () => (args.length !== 2 ? fail(n, 'Math.max takes two numbers') : `{ let a = ${ex(args[0], sc)}; let b = ${ex(args[1], sc)}; d.max(a, b) }`),
      'Array.isArray': () => `{ let r = ${cond(n, sc)}; d.bool(r) }`,
    };
    if (statics[`${recvText}.${m}`]) {
      if ((m === 'keys' || m === 'entries') && ts.isIdentifier(args[0]) && lookupVar(sc, args[0].text)?.fresh) {
        return fail(n, `Object.${m} of an object this function built (undefined members would differ)`);
      }
      return statics[`${recvText}.${m}`]();
    }
    if (['JSON', 'Object', 'Math', 'Array', 'Number', 'String'].includes(recvText)) return fail(n, `${recvText}.${m} is not in the subset`);
    // the Host context and the bidder's HTTP response (Phase arguments)
    const role = ts.isIdentifier(callee.expression) ? lookupVar(sc, callee.expression.text)?.role : undefined;
    if (role === 'host' && m === 'now' && !args.length) return `{ let f = rt::host_now(); d.num(f) }`;
    if (role === 'host' && m === 'convertCurrency' && args.length === 3) {
      const [ns, bs] = bind(args);
      return `{ ${bs} d.convert_currency(${ns.join(', ')}) }`;
    }
    if (role === 'http' && m === 'header' && args.length === 1) {
      const a = t();
      return `{ let ${a} = ${ex(args[0], sc)}; d.header(${lookupVar(sc, callee.expression.text).rs}, ${a}) }`;
    }
    if (role) return fail(n, `${role}.${m}() is not part of the Host context`);
    const rty = typeOf(callee.expression);
    const r = t();
    const recv = `let ${r} = ${ex(callee.expression, sc)};`;
    if (isStr(rty)) {
      if (m === 'trim' || m === 'toLowerCase') return `{ ${recv} d.${m === 'trim' ? 'trim' : 'lower'}(${r}) }`;
      if (m === 'split') {
        if (!(args.length === 1 && ts.isStringLiteral(args[0]) && args[0].text)) return fail(n, 'split takes one non-empty string literal');
        return `{ ${recv} d.split_js(${r}, ${q(args[0].text)}) }`;
      }
      if (m === 'includes') return `{ ${recv} let s = ${ex(args[0], sc)}; d.includes_js(${r}, s) }`;
      return fail(n, `string method .${m} is not in the subset`);
    }
    if (isArr(rty)) {
      if (m === 'join') {
        if (!(args.length === 1 && ts.isStringLiteral(args[0]))) return fail(n, 'join takes one string literal');
        return `{ ${recv} d.join_js(${r}, ${q(args[0].text)}) }`;
      }
      const loop = (body) => `let mut it = d.first_item(${r}); let mut ix = 0f64; while it != 0 { ${body} it = d.next_item(it); ix += 1.0; }`;
      if (['map', 'filter', 'some', 'every', 'find'].includes(m)) {
        const [binds, isc, body] = callback(args[0], sc, 'it');
        if (m === 'map') return `{ ${recv} let out = d.arr(); ${loop(`{ ${binds} let v = ${ex(body, isc)}; d.push_js(out, v); }`)} out }`;
        if (m === 'filter') return `{ ${recv} let out = d.arr(); ${loop(`{ ${binds} if ${cond(body, isc)} { d.push(out, it); } }`)} out }`;
        if (m === 'find') return `{ ${recv} let mut f = rt::ABSENT; ${loop(`{ ${binds} if ${cond(body, isc)} { f = it; break; } }`)} f }`;
        if (m === 'some') return `{ ${recv} let mut f = false; ${loop(`{ ${binds} if ${cond(body, isc)} { f = true; break; } }`)} d.bool(f) }`;
        return `{ ${recv} let mut f = true; ${loop(`{ ${binds} if !${cond(body, isc)} { f = false; break; } }`)} d.bool(f) }`;
      }
      return fail(n, `array method .${m} is not in the subset`);
    }
    return fail(n, `.${m}() on a value that isn't statically a string or an array`);
  }

  // ---------- statements ----------
  function stmts(list, sc) {
    return list.map((s) => stmt(s, sc)).join('\n');
  }
  function stmt(s, sc) {
    const K = ts.SyntaxKind;
    switch (s.kind) {
      case K.Block: return `{\n${stmts(s.statements, newScope(sc))}\n}`;
      case K.VariableStatement: {
        const isLet = !(s.declarationList.flags & ts.NodeFlags.Const);
        return s.declarationList.declarations.map((dcl) => {
          if (!ts.isIdentifier(dcl.name)) return fail(dcl, 'destructuring declarations are not in the subset');
          if (!dcl.initializer) return fail(dcl, 'declarations need an initializer');
          let init = dcl.initializer;
          while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return fail(dcl, 'local functions are not in the subset (use a module-level helper)');
          const rs = `v_${dcl.name.text}_${tmp++}`;
          const code = `let mut ${rs} = ${ex(dcl.initializer, sc)};`;
          sc.vars[dcl.name.text] = { rs, fresh: ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init), mutable: isLet };
          return code;
        }).join('\n');
      }
      case K.IfStatement:
        return `if ${cond(s.expression, sc)} ${block(s.thenStatement, sc)}${s.elseStatement ? ` else ${block(s.elseStatement, sc)}` : ''}`;
      case K.ReturnStatement: {
        const e = s.expression;
        if (sc.fn.kind === 'helper') return `return ${e ? ex(e, sc) : 'rt::ABSENT'};`;
        if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'reject') {
          if (!sc.fn.rejects) return fail(s, 'reject(...) only in the core imp / bid Phases');
          return `return Err({ let m = ${ex(e.arguments[0], sc)}; d.to_string(m) });`;
        }
        return `return Ok(${e ? ex(e, sc) : 'rt::ABSENT'});`;
      }
      case K.ExpressionStatement: {
        const e = s.expression;
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.EqualsToken) return assign(e, sc);
        return fail(s, 'only assignments may stand as statements');
      }
      case K.ForOfStatement: {
        const dl = s.initializer;
        if (!ts.isVariableDeclarationList(dl) || !ts.isIdentifier(dl.declarations[0].name)) return fail(s, 'for (const x of list) only');
        const isc = newScope(sc);
        const rs = `v_${dl.declarations[0].name.text}_${tmp++}`;
        isc.vars[dl.declarations[0].name.text] = { rs };
        return `{ let src = ${ex(s.expression, sc)}; for ${rs} in d.items(src) ${block(s.statement, isc)} }`;
      }
    }
    return fail(s, `${ts.SyntaxKind[s.kind]} is not in the subset`);
  }
  const block = (s, sc) => (ts.isBlock(s) ? `{\n${stmts(s.statements, newScope(sc))}\n}` : `{ ${stmt(s, newScope(sc))} }`);

  function assign(e, sc) {
    const L = e.left;
    if (ts.isIdentifier(L)) {
      const v = lookupVar(sc, L.text);
      if (!v?.mutable) return fail(e, 'only `let` locals can be reassigned');
      return `${v.rs} = ${ex(e.right, sc)};`;
    }
    if (ts.isPropertyAccessExpression(L) && ts.isIdentifier(L.expression)) {
      const v = lookupVar(sc, L.expression.text);
      if (!v) return fail(e, 'unknown name');
      if (!v.fresh) return fail(e, 'writes only to objects this function created (inputs and parameters are read-only)');
      if (v.escaped) return fail(e, 'write after the object was used as a value (JS would share it; copy instead)');
      return `{ let v = ${ex(e.right, sc)}; d.set(${v.rs}, ${q(L.name.text)}, v); }`;
    }
    if (ts.isPropertyAccessExpression(L)) return fail(e, 'nested writes would mutate the input through a shallow copy; write `out.a = { ...out.a, b }`');
    return fail(e, 'assignment target not in the subset');
  }

  // ---------- functions ----------
  function fnBody(fnNode, params, kind, rejects) {
    const sc = newScope(null);
    sc.fn = { kind, rejects };
    const used = [];
    fnNode.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) return fail(p, 'parameter destructuring is not in the subset');
      sc.vars[p.name.text] = { rs: `v_${p.name.text}` };
      used.push([params[i], `v_${p.name.text}`]);
      if (params[i] === 'host' || params[i] === 'http') sc.vars[p.name.text].role = params[i];
    });
    const ok = kind === 'helper' ? (x) => x : (x) => `Ok(${x})`;
    const body = ts.isBlock(fnNode.body) ? `${stmts(fnNode.body.statements, sc)}\n${ok('rt::ABSENT')}` : ok(ex(fnNode.body, sc));
    return { used, body };
  }
  function hook(group, name, fnNode) {
    const params = HOOKS[group === 'core' ? 'core' : 'ext'][name];
    if (!params) return fail(fnNode, `unknown Phase ${group}.${name}`), null;
    if (fnNode.parameters.length > params.length) fail(fnNode, `${name} takes at most (${params.join(', ')})`);
    const { used, body } = fnBody(fnNode, params, 'hook', REJECTING.has(`${group}.${name}`));
    const names = new Map(used);
    const sig = params.map((p) => `${names.get(p) ?? '_' + p}: V`).join(', ');
    return { rs: `fn ${group}_${name}(d: &mut Doc, ${sig}) -> Result<V, String> {\n${body}\n}\n`, usesImp: names.has('imp') };
  }

  let out = '';
  for (const [name, fnNode] of fnItems) {
    const params = fnNode.parameters.map((p) => p.name.getText(sf));
    const { body } = fnBody(fnNode, params, 'helper', false);
    out += `fn ${mod.fns[name]}(d: &mut Doc${params.map((p) => `, v_${p}: V`).join('')}) -> V {\n${body}\n}\n`;
  }
  const hooks = {};
  for (const k of ['imp', 'request', 'bid', 'response']) {
    const f = hookFn(coreObj, k);
    if (!f) { errors.push(`core.${k} is required`); continue; }
    hooks[`core_${k}`] = hook('core', k, f);
  }
  { const f = hookFn(coreObj, 'group'); if (f) hooks.core_group = hook('core', 'group', f); }
  for (const k of ['imp', 'request', 'bid']) {
    const f = hookFn(sideObj, k);
    if (f) hooks[`ext_${k}`] = hook('ext', k, f);
  }
  for (const p of sideObj?.properties ?? []) if (!['endpoint', 'imp', 'request', 'bid'].includes(propName(p.name))) fail(p, 'Extensions have endpoint, imp, request and bid only');
  if (errors.length) return { errors };
  for (const h of Object.values(hooks)) out += h.rs;

  const has = (k) => !!hooks[k];
  const unwrap = (x) => `match ${x} { Ok(v) => v, Err(_) => rt::ABSENT }`;
  let s = `// GENERATED by the PROTOTYPE transpiler from adapters/${path.basename(file)} (${side}) - do not edit.\n`;
  s += `#![allow(unused_variables, unused_mut, unused_assignments, unused_braces, unused_parens, unreachable_code, non_snake_case, clippy::all)]\n`;
  s += `use prebid_core_rt::{self as rt, Doc, V, Reqs, BidsOut, BidAnnot};\n\n`;
  s += `pub const BIDDER: &str = ${q(bidder)};\npub const ENDPOINT: &str = ${q(endpoint)};\n\n${out}\n`;
  // the driver: the same steps as core/index.ts build()
  s += `pub fn make_requests(d: &mut Doc, host: V, req: V) -> Reqs {
let mut errs: Vec<String> = Vec::new();
// outgoing imps grouped into requests (same key, same request; first-seen order)
let mut groups: Vec<(String, V, V)> = Vec::new();
let imp_list = { let a = d.get(req, "imp"); d.items(a) };
for imp in imp_list {
let p = { let a = d.get(imp, "ext"); d.get(a, "bidder") };
let r = match core_imp(d, imp, p, req, host) { Ok(o) => o, Err(e) => { errs.push(e); continue; } };
let outs = if d.is_array(r) { d.items(r) } else { vec![r] };
for o in outs {
${has('ext_imp') ? `let patch = ${unwrap('ext_imp(d, imp, p, req)')}; let o = d.fill(o, patch);` : ''}
let key = ${has('core_group') ? `{ let k = ${unwrap('core_group(d, o, p, host)')}; d.to_string(k) }` : 'String::new()'};
let gi = match groups.iter().position(|g| g.0 == key) { Some(i) => i, None => { let (a, b) = (d.arr(), d.arr()); groups.push((key, a, b)); groups.len() - 1 } };
d.push(groups[gi].1, o); d.push(groups[gi].2, p);
}
}
let mut reqs = Vec::new();
for (_, imps, params) in groups {
let r = d.own(req); d.put_mut(r, &["imp"], imps);
let o = match core_request(d, r, params, host) { Ok(o) => o, Err(e) => { errs.push(e); continue; } };
${has('ext_request') ? `let patch = ${unwrap('ext_request(d, r, params)')}; let o = d.fill(o, patch);` : ''}
let ids: Vec<String> = { let l = d.items(imps); l.into_iter().map(|i| { let id = d.get(i, "id"); d.to_string(id) }).collect() };
reqs.push((d.to_json(o), ids));
}
Reqs { reqs, errs }
}

pub fn make_bids(d: &mut Doc, host: V, req: V, resp: V, http: V) -> BidsOut {
let mut errs: Vec<String> = Vec::new(); let mut bids: Vec<BidAnnot> = Vec::new();
// the response Phase first: rejecting it drops every bid
let top = match core_response(d, resp, http, host) { Ok(r) => r, Err(e) => { return BidsOut { bids, currency: String::new(), paapi: vec![], errs: vec![e], rejected: true }; } };
let seatbids = { let a = d.get(resp, "seatbid"); d.items(a) };
for seatbid in seatbids { let bid_list = { let a = d.get(seatbid, "bid"); d.items(a) }; for bid in bid_list {
let imp = ${hooks.core_bid.usesImp || hooks.ext_bid?.usesImp ? `{ let id = d.get(bid, "impid"); let l = { let a = d.get(req, "imp"); d.items(a) }; let mut f = rt::ABSENT; for i in l { let iid = d.get(i, "id"); if d.eq(iid, id) { f = i; break; } } f }` : 'rt::ABSENT'};
let r = match core_bid(d, bid, imp, resp, http, host) { Ok(r) => r, Err(e) => { errs.push(e); bids.push(BidAnnot { keep: false, typ: String::new(), seat: String::new(), deal_priority: 0.0, video: vec![], meta: vec![], overrides: vec![] }); continue; } };
let w = d.get(r, "warning"); if !d.is_undef(w) { errs.push(d.to_string(w)); }
let ob = d.get(r, "bid"); let ov = d.overrides(bid, ob);
let typ = d.get(r, "type"); let seat = d.get(r, "seat"); let dp = d.get(r, "dealPriority"); let video = d.get(r, "video"); let meta = d.get(r, "meta");
${has('ext_bid') ? `let patch = { let x = ${unwrap('ext_bid(d, bid, imp)')}; d.get(x, "meta") }; let base = if d.is_undef(meta) { d.obj() } else { meta }; let meta = d.fill(base, patch); let meta = d.nonempty(meta);` : ''}
bids.push(BidAnnot { keep: true, typ: d.to_string(typ), seat: d.to_string(seat), deal_priority: d.f64(dp).unwrap_or(0.0), video: d.kv_slot(video), meta: d.kv_slot(meta), overrides: d.slot(ov) });
}}
let cur = d.get(top, "currency"); let paapi = d.get(top, "paapi");
BidsOut { bids, currency: d.to_string(cur), paapi: d.slot(paapi), errs, rejected: false }
}
`;
  return { rs: s, errors };
}

function propName(n) {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : n.getText();
}
function num(text) {
  const v = Number(text.replace(/_/g, ''));
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}
function where(sf, pos) {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return `${path.relative(process.cwd(), sf.fileName)}:${line + 1}:${character + 1}`;
}
