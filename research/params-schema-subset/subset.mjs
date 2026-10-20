// Prototype of the Definition Compiler's `pattern` check: parses a pattern in the proposed subset of
// ECMA-262 (u flag) and emits an equivalent pattern for Rust `regex`, Go RE2 and java.util.regex, or
// rejects it with a reason. Meaning is always ECMA-262 with the u flag, as JSON Schema specifies.
//   node subset.mjs cases.json   -> writes out/cases-{js,rust,go,java}.json and prints the classification
import fs from "node:fs";

// ECMA-262 WhiteSpace + LineTerminator, which is what \s means in JS.
const WS = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, [0x2000, 0x200a], 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const LT = [0x0a, 0x0d, 0x2028, 0x2029]; // what `.` excludes in JS without the s flag
const SYNTAX = "^$\\.*+?()[]{}|/";
const hex = (cp, eng) => eng === "js" ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\x{${cp.toString(16)}}`;
const items = (list, eng) => list.map(x => Array.isArray(x) ? `${hex(x[0], eng)}-${hex(x[1], eng)}` : hex(x, eng)).join("");
const lit = (c, eng) => /[A-Za-z0-9 _,:;'"<>=!@#%&~`]/.test(c) ? c : SYNTAX.includes(c) || c === "-" ? "\\" + c : hex(c.codePointAt(0), eng);
const CLASS_ESC = { d: () => "0-9", w: () => "0-9A-Za-z_", s: eng => items(WS, eng) };
const CTRL = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };

class Reject extends Error {}
function translate(p, eng) {
  let i = 0, out = "", rules = new Set();
  const peek = () => p[i], eof = () => i >= p.length;
  const groupStack = [{ hasQuant: false }];
  const quantifier = () => {
    const c = peek();
    if (c === "*" || c === "+" || c === "?") { i++; return c; }
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (!m) throw new Reject("`{` that is not a quantifier");
      if (+m[1] > 1000 || (m[3] && +m[3] > 1000)) throw new Reject("repetition count over 1000 (Go RE2 limit)");
      i += m[0].length; return m[0];
    }
    return null;
  };
  const afterAtom = (atomIsGroup, groupHadQuant) => {
    const q = quantifier();
    if (!q) return "";
    if (!eof() && "*+?{".includes(peek())) throw new Reject("lazy, possessive or stacked quantifier");
    if (atomIsGroup && groupHadQuant && q !== "?") throw new Reject("quantified group containing a quantifier (nested repetition: exponential backtracking in V8)");
    groupStack.at(-1).hasQuant = true;
    return q;
  };
  const escape = (inClass) => {
    i++; const c = p[i++];
    if (c === undefined) throw new Reject("trailing backslash");
    if (SYNTAX.includes(c) || c === "-") return c === "/" ? "/" : "\\" + c;
    if (c in CTRL) { rules.add(`\\${c}`); return eng === "js" ? "\\" + c : hex(CTRL[c], eng); }
    if (c in CLASS_ESC) { rules.add(`\\${c}`); return eng === "js" ? "\\" + c : inClass ? CLASS_ESC[c](eng) : `[${CLASS_ESC[c](eng)}]`; }
    if ("DWS".includes(c)) {
      if (inClass) throw new Reject(`\\${c} inside a class`);
      rules.add(`\\${c}`); return eng === "js" ? "\\" + c : `[^${CLASS_ESC[c.toLowerCase()](eng)}]`;
    }
    throw new Reject(`escape \\${c} (not in the subset: \\b, \\p, \\u, \\x, \\c, \\0, backreferences and the like differ or are missing somewhere)`);
  };
  const cls = () => {
    i++; let s = "[";
    if (peek() === "^") { s += "^"; i++; }
    if (peek() === "]") throw new Reject("`]` first in a class");
    while (!eof() && peek() !== "]") {
      const c = peek();
      if (c === "[") throw new Reject("`[` inside a class (Rust and Java read it as a nested class)");
      if ((c === "&" || c === "-" || c === "~") && p[i + 1] === c) throw new Reject(`\`${c}${c}\` inside a class (Rust/Java set operation)`);
      if (c === "\\") { s += escape(true); continue; }
      if (c.codePointAt(0) > 0x7e || c.codePointAt(0) < 0x20) throw new Reject("non-ASCII or control literal");
      s += c === "-" ? "-" : lit(c, eng); i++;
    }
    if (eof()) throw new Reject("unclosed class");
    i++; return s + "]";
  };
  const seq = (depth) => {
    let s = "";
    while (!eof()) {
      const c = peek();
      if (c === ")") { if (!depth) throw new Reject("unbalanced `)`"); return s; }
      if (c === "|") { s += "|"; i++; continue; }
      if (c === "^") { s += eng === "java" ? "\\A" : "^"; i++; continue; }
      if (c === "$") { s += eng === "java" ? "\\z" : "$"; i++; continue; }
      if (c === "(") {
        i++;
        if (peek() === "?") { if (p[i + 1] !== ":") throw new Reject("`(?` other than `(?:` (lookaround, named groups, flags)"); i += 2; }
        groupStack.push({ hasQuant: false });
        const inner = seq(depth + 1);
        if (peek() !== ")") throw new Reject("unclosed group");
        i++;
        const g = groupStack.pop();
        if (g.hasQuant) groupStack.at(-1).hasQuant = true;
        s += `(?:${inner})` + afterAtom(true, g.hasQuant);
        continue;
      }
      if ("*+?{".includes(c)) throw new Reject("quantifier with nothing to repeat");
      if (c === "}" || c === "]") throw new Reject(`lone \`${c}\``);
      let atom;
      if (c === "[") atom = cls();
      else if (c === "\\") atom = escape(false);
      else if (c === ".") { i++; rules.add("."); atom = eng === "js" ? "." : `[^${items(LT, eng)}]`; }
      else if (c.codePointAt(0) > 0x7e || c.codePointAt(0) < 0x20) throw new Reject("non-ASCII or control literal");
      else { i++; atom = lit(c, eng); }
      s += atom + afterAtom(false, false);
    }
    return s;
  };
  const body = seq(0);
  if (!eof()) throw new Reject("unbalanced `)`");
  return { out: eng === "js" ? p : body, rules: [...rules] };
}

export function classify(p) {
  try {
    const t = Object.fromEntries(["js", "rust", "go", "java"].map(e => [e, translate(p, e)]));
    const rules = t.js.rules;
    return { verdict: rules.length ? "rule" : "safe", rules, ...Object.fromEntries(Object.entries(t).map(([e, v]) => [e, v.out])) };
  } catch (e) {
    if (e instanceof Reject) return { verdict: "reject", reason: e.message };
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const all = [...cases.catalogue, ...cases.probes];
  const res = all.map(p => ({ p, ...classify(p) }));
  for (const r of res) console.log(`${r.verdict.padEnd(6)} ${JSON.stringify(r.p)}${r.reason ? "  -- " + r.reason : r.rules.length ? "  rules: " + r.rules.join(" ") + "  rust: " + JSON.stringify(r.rust) + "  java: " + JSON.stringify(r.java) : ""}`);
  const ok = res.filter(r => r.verdict !== "reject");
  for (const eng of ["js", "rust", "go", "java"])
    fs.writeFileSync(`out/cases-${eng}.json`, JSON.stringify({ catalogue: ok.map(r => r[eng]), probes: [], strings: cases.strings }));
  fs.writeFileSync("out/cases-index.json", JSON.stringify(ok.map(r => r.p)));
}
