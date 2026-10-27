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

    /// Core `formEncode`: application/x-www-form-urlencoded (Go's url.QueryEscape): every UTF-8 byte
    /// but A-Z a-z 0-9 - _ . ~ as %XX, a space as '+'.
    pub fn form_encode(&mut self, v: V) -> V {
        let Some(s) = self.string(v).map(|s| s.into_owned()) else { return ABSENT };
        let mut out = String::with_capacity(s.len() * 3);
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
                b' ' => out.push('+'),
                b => out.push_str(&format!("%{:02X}", b)),
            }
        }
        self.new_str(&out)
    }
    /// `http.header(name)`: the Host passes `{status, headers}`, header names lower-cased.
    pub fn header(&mut self, http: V, name: V) -> V {
        let Some(n) = self.string(name).map(|s| s.to_lowercase()) else { return ABSENT };
        let h = self.get(http, "headers");
        self.get(h, &n)
    }
    /// `host.convertCurrency(amount, from, to)`: the Host's currency service; undefined without a rate.
    pub fn convert_currency(&mut self, amount: V, from: V, to: V) -> V {
        let (Some(a), Some(f), Some(t)) = (self.f64(amount), self.string(from).map(|s| s.into_owned()), self.string(to).map(|s| s.into_owned())) else { return ABSENT };
        let r = host_convert(a, &f, &t);
        if r.is_nan() { ABSENT } else { self.num(r) }
    }
}

// ---------- the Host's functions (guest imports from "prebid"; native builds use a settable stand-in) ----------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "prebid")]
extern "C" {
    fn now_ms() -> f64;
    fn convert_currency(amount: f64, from: *const u8, from_len: u32, to: *const u8, to_len: u32) -> f64;
}
/// `host.now()`: milliseconds since the epoch, by the Host's clock.
#[cfg(target_arch = "wasm32")]
pub fn host_now() -> f64 {
    unsafe { now_ms() }
}
#[cfg(target_arch = "wasm32")]
fn host_convert(a: f64, f: &str, t: &str) -> f64 {
    unsafe { convert_currency(a, f.as_ptr(), f.len() as u32, t.as_ptr(), t.len() as u32) }
}
#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static NOW: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    static RATES: std::cell::RefCell<Vec<(String, String, f64)>> = const { std::cell::RefCell::new(Vec::new()) };
}
/// Native builds (tests, fuzz): what `host.now()` and `host.convertCurrency` answer.
#[cfg(not(target_arch = "wasm32"))]
pub fn set_host(now: f64, rates: Vec<(String, String, f64)>) {
    NOW.with(|c| c.set(now));
    RATES.with(|r| *r.borrow_mut() = rates);
}
#[cfg(not(target_arch = "wasm32"))]
pub fn host_now() -> f64 {
    NOW.with(|c| c.get())
}
#[cfg(not(target_arch = "wasm32"))]
fn host_convert(a: f64, f: &str, t: &str) -> f64 {
    if f == t {
        return a;
    }
    RATES.with(|r| {
        let r = r.borrow();
        if let Some((_, _, x)) = r.iter().find(|(x, y, _)| x == f && y == t) {
            return a * x;
        }
        if let Some((_, _, x)) = r.iter().find(|(x, y, _)| x == t && y == f) {
            return a / x;
        }
        f64::NAN
    })
}
