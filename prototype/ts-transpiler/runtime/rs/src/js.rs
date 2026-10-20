//! PROTOTYPE: the JavaScript built-ins restricted TypeScript may call, with JS semantics exactly, for
//! the Rust the transpiler emits (transpiler/transpile.mjs). The rest of the runtime is the Definition
//! prototype's; where its builtins followed the EL instead of JS (split, join, entries, templates,
//! array pushes), the JS version lives here.
use crate::*;

impl Doc {
    /// `undefined` as an array element: a node of kind Absent (id ≠ 0), so it can sit in a list.
    /// It is nullish, falsy, typeof "undefined", prints as null, and `=== undefined` holds, as in JS.
    fn undef_node(&mut self) -> V {
        self.node(N { k: K::Absent, ..Z })
    }
    /// Array push / array-literal element: undefined is kept, as JS keeps it.
    pub fn push_js(&mut self, a: V, v: V) {
        if v == ABSENT {
            let u = self.undef_node();
            self.append(a, u);
        } else {
            self.push(a, v)
        }
    }
    /// `{ ...a, ...src }` after the first spread: src's members in JS order (deduplicated,
    /// integer-like keys first); undefined members delete, as for every set.
    pub fn assign(&mut self, o: V, src: V) {
        for (k, c) in self.members(src) {
            self.set(o, &k, c);
        }
    }
    /// `x === undefined`
    pub fn is_undef(&self, v: V) -> bool {
        self.kind(v) == K::Absent
    }
    fn is_obj(&mut self, v: V) -> bool {
        self.expand(v);
        self.kind(v) == K::Obj
    }
    pub fn is_array(&mut self, v: V) -> bool {
        self.expand(v);
        self.kind(v) == K::Arr
    }
    /// Core `obj(x)`: x when it is a JSON object.
    pub fn obj_(&mut self, v: V) -> V {
        if self.is_obj(v) { v } else { ABSENT }
    }
    /// Extension patch, add-only: fills members `o` lacks and recurses into objects both have.
    /// Never mutates `o` (copy on write), like Prebid Core's TS `fill`.
    pub fn fill(&mut self, o: V, patch: V) -> V {
        if !self.is_obj(patch) {
            return o;
        }
        let mut r = o;
        let mut owned = false;
        for (k, v) in self.members(patch) {
            if self.kind(v) == K::Absent {
                continue;
            }
            let cur = self.get(r, &k);
            let nv = if cur == ABSENT {
                v
            } else if self.is_obj(cur) && self.is_obj(v) {
                let c = self.fill(cur, v);
                if c == cur {
                    continue;
                }
                c
            } else {
                continue;
            };
            if !owned {
                r = self.own(r);
                owned = true;
            }
            self.set(r, &k, nv);
        }
        r
    }
    /// What the Host merges into its own parsed bid: top-level members of `out` that differ from
    /// `orig`, and null for members `out` dropped.
    pub fn overrides(&mut self, orig: V, out: V) -> V {
        let ov = self.obj();
        if out == ABSENT || out == orig {
            return ov;
        }
        let om = self.members(orig);
        let nm = self.members(out);
        for (k, v) in &nm {
            let same = match om.iter().find(|(x, _)| x == k) {
                Some((_, o)) => *o == *v || self.to_json(*o) == self.to_json(*v),
                None => false,
            };
            if !same {
                self.set(ov, k, *v);
            }
        }
        for (k, _) in &om {
            if !nm.iter().any(|(x, _)| x == k) {
                self.set(ov, k, NULL);
            }
        }
        ov
    }
    /// `o[k]` for a non-literal key: arrays by integer index, objects by String(k).
    pub fn index(&mut self, o: V, k: V) -> V {
        self.expand(o);
        match self.kind(o) {
            K::Arr => match self.f64(k) {
                Some(f) if f >= 0.0 && f.fract() == 0.0 => self.at(o, f as usize),
                _ => ABSENT,
            },
            K::Obj => match self.scalar_string(k) {
                Some(s) => self.get(o, &s),
                None => ABSENT,
            },
            _ => ABSENT,
        }
    }
    /// `typeof x`
    pub fn typeof_js(&mut self, v: V) -> &'static str {
        self.expand(v);
        match self.kind(v) {
            K::Absent => "undefined",
            K::True | K::False => "boolean",
            K::Num | K::NumF => "number",
            K::Str => "string",
            _ => "object",
        }
    }
    /// `x.length`: UTF-16 code units for strings, as JS counts them.
    pub fn len_js(&mut self, v: V) -> V {
        self.expand(v);
        match self.kind(v) {
            K::Str => {
                let n = self.string(v).unwrap().encode_utf16().count();
                self.num(n as f64)
            }
            K::Arr => self.len(v),
            _ => ABSENT,
        }
    }
    /// `s.split(sep)` with a non-empty literal separator (the subset rejects others).
    pub fn split_js(&mut self, v: V, sep: &str) -> V {
        let Some(s) = self.string(v).map(|s| s.into_owned()) else { return ABSENT };
        let a = self.arr();
        for part in s.split(sep) {
            let p = self.new_str(part);
            self.push(a, p);
        }
        a
    }
    /// `s.includes(sub)` on a string.
    pub fn includes_js(&mut self, v: V, sub: V) -> V {
        match (self.string(v), self.string(sub)) {
            (Some(s), Some(t)) => {
                let r = s.contains(t.as_ref());
                self.bool(r)
            }
            _ => ABSENT,
        }
    }
    /// `a.join(sep)`: undefined and null print as "", nested arrays join with ",", objects as
    /// "[object Object]".
    pub fn join_js(&mut self, l: V, sep: &str) -> V {
        if !self.is_array(l) {
            return ABSENT;
        }
        let s = self.join_str(l, sep);
        self.new_str(&s)
    }
    fn join_str(&mut self, l: V, sep: &str) -> String {
        let mut out = String::new();
        for (i, c) in self.items(l).into_iter().enumerate() {
            if i > 0 {
                out.push_str(sep);
            }
            self.expand(c);
            match self.kind(c) {
                K::Absent | K::Null => {}
                K::Arr => {
                    let s = self.join_str(c, ",");
                    out.push_str(&s)
                }
                K::Obj => out.push_str("[object Object]"),
                _ => out.push_str(&self.scalar_string(c).unwrap()),
            }
        }
        out
    }
    /// Template interpolation, as JS prints it. The subset only lets scalars, null and undefined in.
    pub fn tmpl_js(&self, out: &mut String, v: V) {
        match self.kind(v) {
            K::Absent => out.push_str("undefined"),
            K::Null => out.push_str("null"),
            _ => self.tmpl(out, v),
        }
    }
    /// `Object.entries(o)`: `[key, value]` pairs in JS order.
    pub fn entries_js(&mut self, o: V) -> V {
        let a = self.arr();
        for (k, v) in self.members(o) {
            let e = self.arr();
            let ks = self.new_str(&k);
            self.push(e, ks);
            self.push(e, v);
            self.push(a, e);
        }
        a
    }
    /// `Object.fromEntries(list)` of `[key, value]` pairs.
    pub fn from_entries_js(&mut self, l: V) -> V {
        let r = self.obj();
        for e in self.items(l) {
            let k = self.at(e, 0);
            let v = self.at(e, 1);
            let ks = match self.kind(k) {
                K::Absent => "undefined".to_string(),
                K::Null => "null".to_string(),
                _ => match self.scalar_string(k) {
                    Some(s) => s,
                    None => continue,
                },
            };
            self.set(r, &ks, v);
        }
        r
    }
    /// Number arithmetic (`+` only on numbers; the subset rejects string `+`).
    pub fn arith(&mut self, a: V, b: V, op: u8) -> V {
        let (x, y) = (self.f64(a).unwrap_or(f64::NAN), self.f64(b).unwrap_or(f64::NAN));
        let r = match op {
            b'+' => x + y,
            b'-' => x - y,
            b'*' => x * y,
            b'/' => x / y,
            _ => x % y,
        };
        self.num(r)
    }
}
