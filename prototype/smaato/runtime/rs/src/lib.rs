//! PROTOTYPE Prebid Core runtime, Rust side. Generated Shared Adapters (gen/rs/*.rs) call these.
//!
//! A `Doc` is an arena of nodes over one byte buffer that starts as the input JSON. Containers stay
//! *raw* (an unparsed span) until something reads into them, so untouched subtrees are skipped once
//! and re-emitted as a byte copy. Strings stay in their escaped JSON form. Writes are copy-on-write,
//! so expressions always read the input.
//!
//! Semantics match runtime/ts/core.ts (JavaScript's), including: duplicate keys read as the last
//! value; `entries`/`keys` list integer-like keys first, ascending; `trim` uses JS's whitespace set;
//! numbers compute as f64 and print like JS `String(n)`; `stringify` is canonical JSON.stringify.
use std::borrow::Cow;
mod js;
pub use js::host_now;
#[cfg(not(target_arch = "wasm32"))]
pub use js::set_host;

pub type V = u32; // node id; 0 = absent
pub const ABSENT: V = 0;
pub const NULL: V = 1;
pub const TRUE: V = 2;
pub const FALSE: V = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum K {
    Absent,
    Null,
    True,
    False,
    Num,  // raw number text at s..s+l
    NumF, // computed f64; bits in (s, l)
    Str,  // escaped string content at s..s+l (no quotes)
    Obj,
    Arr,
    RawObj, // unparsed object text at s..s+l
    RawArr,
}

#[derive(Clone, Copy)]
struct N {
    k: K,
    pristine: bool, // parsed container whose span still describes it exactly
    s: u32,
    l: u32,
    ks: u32, // key span (escaped) when this node is an object member
    kl: u32,
    first: u32,
    last: u32,
    next: u32,
}

pub struct Doc {
    n: Vec<N>,
    pub buf: Vec<u8>,
}

const Z: N = N { k: K::Absent, pristine: false, s: 0, l: 0, ks: 0, kl: 0, first: 0, last: 0, next: 0 };

impl Doc {
    pub fn new() -> Doc {
        let mut d = Doc { n: Vec::with_capacity(1024), buf: Vec::with_capacity(16 * 1024) };
        d.reset();
        d
    }
    pub fn reset(&mut self) {
        self.n.clear();
        self.buf.clear();
        for k in [K::Absent, K::Null, K::True, K::False] {
            self.n.push(N { k, ..Z });
        }
    }
    fn node(&mut self, n: N) -> V {
        self.n.push(n);
        (self.n.len() - 1) as V
    }
    #[inline]
    pub fn kind(&self, v: V) -> K {
        self.n[v as usize].k
    }
    fn span(&self, v: V) -> &[u8] {
        let x = &self.n[v as usize];
        &self.buf[x.s as usize..(x.s + x.l) as usize]
    }
    fn key(&self, v: V) -> &[u8] {
        let x = &self.n[v as usize];
        &self.buf[x.ks as usize..(x.ks + x.kl) as usize]
    }

    // ---------- parsing ----------
    /// Appends JSON text to the buffer and returns its root, unparsed: the first read parses it in
    /// one eager pass (so a document no rule reads, like the request in MakeBids, is never scanned).
    /// Lenient: it trusts its input (the Host's serializer, or a body the Host already parsed);
    /// `json()` validates.
    pub fn parse(&mut self, text: &[u8]) -> V {
        let off = self.buf.len();
        self.buf.extend_from_slice(text);
        let mut p = off;
        self.ws(&mut p);
        let k = match self.buf.get(p) {
            Some(b'{') => K::RawObj,
            Some(b'[') => K::RawArr,
            _ => return self.value(&mut p),
        };
        let end = self.buf.len();
        self.node(N { k, s: p as u32, l: (end - p) as u32, ..Z })
    }
    #[inline]
    fn ws(&self, p: &mut usize) {
        while *p < self.buf.len() && matches!(self.buf[*p], b' ' | b'\n' | b'\r' | b'\t') {
            *p += 1;
        }
    }
    #[inline]
    fn skip_str(&self, p: &mut usize) -> (usize, usize) {
        let b = &self.buf[..];
        let s = *p + 1;
        let mut i = s;
        while i < b.len() {
            let c = b[i];
            if c == b'"' {
                break;
            }
            i += if c == b'\\' { 2 } else { 1 };
        }
        *p = i + 1;
        (s, i - s)
    }
    /// Eager recursive parse of one value; containers record their span and start pristine.
    fn value(&mut self, p: &mut usize) -> V {
        self.ws(p);
        if *p >= self.buf.len() {
            return ABSENT;
        }
        let s = *p;
        match self.buf[*p] {
            c @ (b'{' | b'[') => {
                let obj = c == b'{';
                let v = self.node(N { k: if obj { K::Obj } else { K::Arr }, pristine: true, s: s as u32, ..Z });
                *p += 1;
                loop {
                    self.ws(p);
                    if *p >= self.buf.len() {
                        break;
                    }
                    match self.buf[*p] {
                        b'}' | b']' => {
                            *p += 1;
                            break;
                        }
                        b',' => {
                            *p += 1;
                            continue;
                        }
                        _ => {}
                    }
                    let (mut ks, mut kl) = (0, 0);
                    if obj {
                        (ks, kl) = self.skip_str(p);
                        self.ws(p);
                        *p += 1; // ':'
                    }
                    let c = self.value(p);
                    let cn = &mut self.n[c as usize];
                    cn.ks = ks as u32;
                    cn.kl = kl as u32;
                    self.append(v, c);
                }
                self.n[v as usize].l = (*p - s) as u32;
                v
            }
            b'"' => {
                let (s, l) = self.skip_str(p);
                self.node(N { k: K::Str, s: s as u32, l: l as u32, ..Z })
            }
            b't' => {
                *p += 4;
                self.node(N { k: K::True, ..Z })
            }
            b'f' => {
                *p += 5;
                self.node(N { k: K::False, ..Z })
            }
            b'n' => {
                *p += 4;
                self.node(N { k: K::Null, ..Z })
            }
            _ => {
                while *p < self.buf.len() && matches!(self.buf[*p], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                    *p += 1;
                }
                self.node(N { k: K::Num, s: s as u32, l: (*p - s) as u32, ..Z })
            }
        }
    }
    /// Parses a still-unparsed root in place.
    #[inline]
    fn expand(&mut self, v: V) {
        let x = self.n[v as usize];
        if x.k != K::RawObj && x.k != K::RawArr {
            return;
        }
        let mut p = x.s as usize;
        let parsed = self.value(&mut p);
        let y = self.n[parsed as usize];
        self.n[v as usize] = N { ks: x.ks, kl: x.kl, next: x.next, ..y };
    }
    fn append(&mut self, p: V, c: V) {
        let last = self.n[p as usize].last;
        if last == 0 {
            self.n[p as usize].first = c;
        } else {
            self.n[last as usize].next = c;
        }
        self.n[p as usize].last = c;
        self.n[c as usize].next = 0;
    }
    fn children(&mut self, v: V) -> Vec<V> {
        self.expand(v);
        let mut out = Vec::new();
        if matches!(self.kind(v), K::Obj | K::Arr) {
            let mut c = self.n[v as usize].first;
            while c != 0 {
                out.push(c);
                c = self.n[c as usize].next;
            }
        }
        out
    }

    // ---------- reading ----------
    #[inline]
    fn key_eq(&self, c: V, k: &str) -> bool {
        let x = &self.n[c as usize];
        let kl = x.kl as usize;
        if kl == k.len() {
            // an escaped key can't be as short as its unescaped form, so equal length means compare bytes
            return &self.buf[x.ks as usize..x.ks as usize + kl] == k.as_bytes();
        }
        kl > k.len() && {
            let raw = self.key(c);
            raw.contains(&b'\\') && unescape(raw) == k
        }
    }
    /// Object member by key; the last one wins, as in JSON.parse.
    pub fn get(&mut self, o: V, k: &str) -> V {
        self.expand(o);
        if self.kind(o) != K::Obj {
            return ABSENT;
        }
        let mut c = self.n[o as usize].first;
        let mut hit = ABSENT;
        while c != 0 {
            if self.key_eq(c, k) {
                hit = c;
            }
            c = self.n[c as usize].next;
        }
        hit
    }
    pub fn at(&mut self, a: V, i: usize) -> V {
        self.expand(a);
        if self.kind(a) != K::Arr {
            return ABSENT;
        }
        let mut c = self.n[a as usize].first;
        for _ in 0..i {
            if c == 0 {
                return ABSENT;
            }
            c = self.n[c as usize].next;
        }
        c
    }
    /// First element of an array (0 if none or not an array); walk on with `next_item`. Generated
    /// loops use these instead of `items` so iterating doesn't allocate.
    #[inline]
    pub fn first_item(&mut self, a: V) -> V {
        self.expand(a);
        if self.kind(a) == K::Arr { self.n[a as usize].first } else { ABSENT }
    }
    #[inline]
    pub fn next_item(&self, c: V) -> V {
        self.n[c as usize].next
    }
    pub fn items(&mut self, a: V) -> Vec<V> {
        self.expand(a);
        if self.kind(a) == K::Arr {
            self.children(a)
        } else {
            Vec::new()
        }
    }
    /// Object members as JS sees them: deduplicated (first position, last value), integer-like
    /// keys first in ascending order.
    fn members(&mut self, o: V) -> Vec<(String, V)> {
        self.expand(o);
        if self.kind(o) != K::Obj {
            return Vec::new();
        }
        let mut out: Vec<(String, V)> = Vec::new();
        for c in self.children(o) {
            let k = unescape(self.key(c)).into_owned();
            match out.iter_mut().find(|(x, _)| *x == k) {
                Some(e) => e.1 = c,
                None => out.push((k, c)),
            }
        }
        let idx = |k: &str| -> Option<u64> {
            if k == "0" || (!k.is_empty() && !k.starts_with('0') && k.len() <= 10 && k.bytes().all(|b| b.is_ascii_digit())) {
                k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64)
            } else {
                None
            }
        };
        let mut ints: Vec<(String, V)> = out.iter().filter(|(k, _)| idx(k).is_some()).cloned().collect();
        ints.sort_by_key(|(k, _)| idx(k));
        ints.extend(out.into_iter().filter(|(k, _)| idx(k).is_none()));
        ints
    }

    pub fn truthy(&mut self, v: V) -> bool {
        match self.kind(v) {
            K::Absent | K::Null | K::False => false,
            K::Num | K::NumF => {
                let f = self.f64(v).unwrap();
                f != 0.0 && !f.is_nan()
            }
            K::Str => self.n[v as usize].l > 0,
            _ => true,
        }
    }
    pub fn nullish(&self, v: V) -> bool {
        matches!(self.kind(v), K::Absent | K::Null)
    }
    pub fn f64(&self, v: V) -> Option<f64> {
        match self.kind(v) {
            K::Num => std::str::from_utf8(self.span(v)).ok()?.parse().ok(),
            K::NumF => Some(f64::from_bits(((self.n[v as usize].s as u64) << 32) | self.n[v as usize].l as u64)),
            _ => None,
        }
    }
    pub fn string(&self, v: V) -> Option<Cow<'_, str>> {
        if self.kind(v) == K::Str {
            Some(unescape(self.span(v)))
        } else {
            None
        }
    }

    // ---------- making values ----------
    pub fn bool(&mut self, b: bool) -> V {
        if b { TRUE } else { FALSE }
    }
    pub fn num(&mut self, f: f64) -> V {
        let b = f.to_bits();
        self.node(N { k: K::NumF, s: (b >> 32) as u32, l: b as u32, ..Z })
    }
    /// A string from already-escaped JSON string content.
    pub fn lit(&mut self, escaped: &str) -> V {
        let s = self.buf.len();
        self.buf.extend_from_slice(escaped.as_bytes());
        self.node(N { k: K::Str, s: s as u32, l: escaped.len() as u32, ..Z })
    }
    pub fn new_str(&mut self, s: &str) -> V {
        let off = self.buf.len();
        escape_into(s, &mut self.buf);
        let l = self.buf.len() - off;
        self.node(N { k: K::Str, s: off as u32, l: l as u32, ..Z })
    }
    pub fn obj(&mut self) -> V {
        self.node(N { k: K::Obj, ..Z })
    }
    pub fn arr(&mut self) -> V {
        self.node(N { k: K::Arr, ..Z })
    }
    fn copy_as(&mut self, v: V, ks: u32, kl: u32) -> V {
        let x = self.n[v as usize];
        self.node(N { ks, kl, next: 0, ..x })
    }
    /// Sets (or, for absent, deletes) a member in place. Only for objects this code created.
    pub fn set(&mut self, o: V, k: &str, v: V) {
        // an undefined array element (js.rs) assigned to a member deletes it, as JSON.stringify omits it
        let v = if self.kind(v) == K::Absent { ABSENT } else { v };
        let ks = self.buf.len() as u32;
        escape_into(k, &mut self.buf);
        let kl = self.buf.len() as u32 - ks;
        self.set_key(o, ks, kl, k, v)
    }
    /// Like JS assignment: an existing key keeps its position (later duplicates are dropped), a new
    /// one goes last; absent deletes.
    fn set_key(&mut self, o: V, ks: u32, kl: u32, k: &str, v: V) {
        self.expand(o);
        let m = if v != ABSENT { self.copy_as(v, ks, kl) } else { ABSENT };
        let (mut prev, mut c, mut placed) = (0u32, self.n[o as usize].first, false);
        while c != 0 {
            let nx = self.n[c as usize].next;
            if self.key_eq(c, k) {
                let repl = if !placed && m != ABSENT { m } else { 0 };
                placed = true;
                if repl != 0 {
                    self.n[repl as usize].next = nx;
                }
                let link = if repl != 0 { repl } else { nx };
                if prev == 0 {
                    self.n[o as usize].first = link;
                } else {
                    self.n[prev as usize].next = link;
                }
                if self.n[o as usize].last == c {
                    self.n[o as usize].last = if repl != 0 { repl } else { prev };
                }
                if repl != 0 {
                    prev = repl;
                }
            } else {
                prev = c;
            }
            c = nx;
        }
        if !placed && m != ABSENT {
            self.append(o, m);
        }
    }
    /// Sets a member even to absent, recorded as JSON null (bid overrides tell the Host to clear it).
    pub fn set_or_null(&mut self, o: V, k: &str, v: V) {
        self.set(o, k, if v == ABSENT { NULL } else { v })
    }
    pub fn push(&mut self, a: V, v: V) {
        if v != ABSENT {
            let m = self.copy_as(v, 0, 0);
            self.append(a, m);
        }
    }
    pub fn extend(&mut self, a: V, src: V) {
        let mut c = self.first_item(src);
        while c != 0 {
            self.push(a, c);
            c = self.next_item(c);
        }
    }
    fn clone_container(&mut self, v: V) -> V {
        self.expand(v);
        let r = if self.kind(v) == K::Arr { self.arr() } else { self.obj() };
        for c in self.children(v) {
            let x = self.n[c as usize];
            let m = self.copy_as(c, x.ks, x.kl);
            self.append(r, m);
        }
        r
    }
    pub fn get_path(&mut self, o: V, path: &[&str]) -> V {
        path.iter().fold(o, |o, k| self.get(o, k))
    }
    /// A fresh top-level copy this call owns, for `put_mut`.
    pub fn own(&mut self, o: V) -> V {
        self.expand(o);
        if matches!(self.kind(o), K::Obj | K::Arr) { self.clone_container(o) } else { self.obj() }
    }
    /// Set along a path on an owned root: the root is changed in place, nested containers are
    /// still copied on write (they can share children with the input or with `let` values).
    pub fn put_mut(&mut self, o: V, path: &[&str], v: V) {
        if path.len() == 1 {
            return self.set(o, path[0], v);
        }
        let child = self.get(o, path[0]);
        if v == ABSENT && !matches!(self.kind(child), K::Obj | K::RawObj) {
            return;
        }
        let nv = if matches!(self.kind(child), K::Obj | K::RawObj) { self.put(child, &path[1..], v) } else {
            let e = self.obj();
            self.put(e, &path[1..], v)
        };
        self.set(o, path[0], nv)
    }
    /// Copy-on-write set along a path; absent deletes. Returns the new root.
    pub fn put(&mut self, o: V, path: &[&str], v: V) -> V {
        self.expand(o);
        if path.len() > 1 && v == ABSENT {
            let c = self.get(o, path[0]);
            if !matches!(self.kind(c), K::Obj | K::RawObj) {
                return o;
            }
        }
        let r = if self.kind(o) == K::Obj { self.clone_container(o) } else { self.obj() };
        let nv = if path.len() == 1 {
            v
        } else {
            let child = self.get(r, path[0]);
            let child = if matches!(self.kind(child), K::Obj | K::RawObj) { child } else { self.obj() };
            self.put(child, &path[1..], v)
        };
        self.set(r, path[0], nv);
        r
    }

    // ---------- builtins (names match the EL) ----------
    pub fn eq(&mut self, a: V, b: V) -> bool {
        match (self.kind(a), self.kind(b)) {
            (K::Num | K::NumF, K::Num | K::NumF) => self.f64(a) == self.f64(b),
            (K::Str, K::Str) => self.span(a) == self.span(b) || self.string(a) == self.string(b),
            (ka, kb) if matches!(ka, K::Obj | K::Arr | K::RawObj | K::RawArr) => ka == kb && a == b,
            (ka, kb) => ka == kb,
        }
    }
    fn n_(&self, v: V) -> f64 {
        self.f64(v).unwrap_or(f64::NAN)
    }
    pub fn lt(&mut self, a: V, b: V) -> bool {
        self.n_(a) < self.n_(b)
    }
    pub fn gt(&mut self, a: V, b: V) -> bool {
        self.n_(a) > self.n_(b)
    }
    pub fn le(&mut self, a: V, b: V) -> bool {
        self.n_(a) <= self.n_(b)
    }
    pub fn ge(&mut self, a: V, b: V) -> bool {
        self.n_(a) >= self.n_(b)
    }
    /// JS String() of a scalar, or None.
    fn scalar_string(&self, v: V) -> Option<String> {
        match self.kind(v) {
            K::Str => Some(self.string(v)?.into_owned()),
            K::Num | K::NumF => Some(js_num(self.f64(v)?)),
            K::True => Some("true".into()),
            K::False => Some("false".into()),
            _ => None,
        }
    }
    pub fn str_(&mut self, v: V) -> V {
        match self.kind(v) {
            K::Str => v,
            _ => match self.scalar_string(v) {
                Some(s) => self.new_str(&s),
                None => ABSENT,
            },
        }
    }
    /// Template interpolation: absent, null and non-scalars render as "".
    pub fn tmpl(&self, out: &mut String, v: V) {
        if let Some(s) = self.scalar_string(v) {
            out.push_str(&s)
        }
    }
    pub fn num_(&mut self, v: V) -> V {
        match self.kind(v) {
            K::Num | K::NumF => v,
            K::Str => {
                let s = self.string(v).unwrap();
                if is_decimal(&s) {
                    let f = s.parse::<f64>().unwrap_or(f64::NAN);
                    self.num(f)
                } else {
                    ABSENT
                }
            }
            _ => ABSENT,
        }
    }
    pub fn int(&mut self, v: V) -> V {
        match self.kind(v) {
            K::Num | K::NumF => {
                let f = self.f64(v).unwrap();
                if f.is_finite() && f.fract() == 0.0 { v } else { ABSENT }
            }
            K::Str => {
                let s = self.string(v).unwrap();
                let d = s.strip_prefix(['+', '-']).unwrap_or(&s);
                if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) {
                    let f = s.parse::<f64>().unwrap();
                    self.num(f)
                } else {
                    ABSENT
                }
            }
            _ => ABSENT,
        }
    }
    pub fn nonempty(&mut self, v: V) -> V {
        self.expand(v);
        let empty = match self.kind(v) {
            K::Str => self.n[v as usize].l == 0,
            K::Obj | K::Arr => self.n[v as usize].first == 0,
            K::Absent => true,
            _ => false,
        };
        if empty { ABSENT } else { v }
    }
    pub fn without(&mut self, o: V, ks: &[&str]) -> V {
        self.expand(o);
        if self.kind(o) != K::Obj {
            return ABSENT;
        }
        let r = self.clone_container(o);
        for k in ks {
            self.set(r, k, ABSENT);
        }
        r
    }
    pub fn merge(&mut self, os: &[V]) -> V {
        let r = self.obj();
        for &o in os {
            self.expand(o);
            if self.kind(o) != K::Obj {
                continue;
            }
            for c in self.children(o) {
                let (ks, kl) = (self.n[c as usize].ks, self.n[c as usize].kl);
                let k = unescape(self.key(c)).into_owned();
                self.set_key(r, ks, kl, &k, c);
            }
        }
        r
    }
    pub fn first(&mut self, l: V) -> V {
        let mut c = self.first_item(l);
        while c != 0 {
            if self.truthy(c) {
                return c;
            }
            c = self.next_item(c);
        }
        ABSENT
    }
    pub fn trim(&mut self, v: V) -> V {
        match self.string(v) {
            Some(s) => {
                let t = s.trim_matches(js_ws);
                if t.len() == s.len() {
                    v
                } else {
                    let t = t.to_owned();
                    self.new_str(&t)
                }
            }
            None => ABSENT,
        }
    }
    pub fn lower(&mut self, v: V) -> V {
        match self.string(v) {
            Some(s) => {
                let t = s.to_lowercase();
                self.new_str(&t)
            }
            None => ABSENT,
        }
    }
    pub fn split(&mut self, v: V, sep: V) -> V {
        let a = self.arr();
        if let (Some(s), Some(sep)) = (self.string(v).map(|s| s.into_owned()), self.string(sep).map(|s| s.into_owned())) {
            for part in s.split(sep.as_str()) {
                let p = self.new_str(part);
                self.push(a, p);
            }
        }
        a
    }
    pub fn join(&mut self, l: V, sep: V) -> V {
        let sep = self.string(sep).map(|s| s.into_owned()).unwrap_or_default();
        let mut out = String::new();
        let mut firstp = true;
        for c in self.items(l) {
            if let Some(s) = self.scalar_string(c) {
                if !firstp {
                    out.push_str(&sep);
                }
                out.push_str(&s);
                firstp = false;
            }
        }
        self.new_str(&out)
    }
    pub fn contains(&mut self, v: V, sub: V) -> V {
        let r = match (self.string(v), self.string(sub)) {
            (Some(s), Some(t)) => s.contains(t.as_ref()),
            _ => false,
        };
        self.bool(r)
    }
    pub fn len(&mut self, v: V) -> V {
        self.expand(v);
        match self.kind(v) {
            K::Arr => {
                let (mut n, mut c) = (0, self.n[v as usize].first);
                while c != 0 {
                    n += 1;
                    c = self.next_item(c);
                }
                self.num(n as f64)
            }
            K::Obj => {
                let n = self.members(v).len();
                self.num(n as f64)
            }
            _ => ABSENT,
        }
    }
    pub fn max(&mut self, a: V, b: V) -> V {
        match (self.f64(a), self.f64(b)) {
            (Some(x), Some(y)) => {
                // JS Math.max: NaN wins, and +0 beats -0
                let m = if x.is_nan() || y.is_nan() { f64::NAN } else if x == y { if x.is_sign_negative() { y } else { x } } else { x.max(y) };
                self.num(m)
            }
            _ => ABSENT,
        }
    }
    pub fn keys(&mut self, o: V) -> V {
        let a = self.arr();
        for (k, _) in self.members(o) {
            let s = self.new_str(&k);
            self.push(a, s);
        }
        a
    }
    pub fn entries(&mut self, o: V) -> V {
        let a = self.arr();
        for (k, v) in self.members(o) {
            let e = self.obj();
            let ks = self.new_str(&k);
            self.set(e, "k", ks);
            self.set(e, "v", v);
            self.push(a, e);
        }
        a
    }
    pub fn from_entries(&mut self, l: V) -> V {
        let r = self.obj();
        for e in self.items(l) {
            let k = self.get(e, "k");
            let v = self.get(e, "v");
            if let (Some(k), true) = (self.string(k).map(|s| s.into_owned()), v != ABSENT) {
                self.set(r, &k, v);
            }
        }
        r
    }
    pub fn type_(&mut self, v: V) -> V {
        let t = match self.kind(v) {
            K::Absent => return ABSENT,
            K::Null => "null",
            K::True | K::False => "bool",
            K::Num | K::NumF => "number",
            K::Str => "string",
            K::Obj | K::RawObj => "object",
            K::Arr | K::RawArr => "array",
        };
        self.lit(t)
    }
    /// JSON.parse: strict; absent when the string isn't valid JSON.
    pub fn json(&mut self, v: V) -> V {
        let Some(s) = self.string(v).map(|s| s.into_owned()) else { return ABSENT };
        if !valid_json(s.as_bytes()) {
            return ABSENT;
        }
        self.parse(s.as_bytes())
    }
    /// JSON.stringify: canonical, whatever the input's formatting.
    pub fn stringify(&mut self, v: V) -> V {
        if v == ABSENT {
            return ABSENT;
        }
        let mut out = Vec::new();
        self.emit_canonical(v, &mut out);
        let s = String::from_utf8(out).unwrap();
        self.new_str(&s)
    }
    pub fn lookup(&mut self, k: V, table: &[(&str, &str)]) -> V {
        let Some(ks) = (match self.kind(k) {
            K::Str | K::Num | K::NumF => self.scalar_string(k),
            _ => None,
        }) else {
            return ABSENT;
        };
        match table.iter().find(|(tk, _)| *tk == ks) {
            Some((_, tv)) => self.lit(tv),
            None => ABSENT,
        }
    }

    // ---------- emitting ----------
    /// Wire output: raw spans are copied as they came, so untouched subtrees cost a memcpy.
    pub fn emit(&self, v: V, out: &mut Vec<u8>) {
        let x = self.n[v as usize];
        match x.k {
            K::Null | K::Absent => out.extend_from_slice(b"null"),
            K::True => out.extend_from_slice(b"true"),
            K::False => out.extend_from_slice(b"false"),
            K::Num | K::RawObj | K::RawArr => out.extend_from_slice(self.span(v)),
            K::NumF => out.extend_from_slice(js_json_num(self.f64(v).unwrap()).as_bytes()),
            K::Str => {
                out.push(b'"');
                out.extend_from_slice(self.span(v));
                out.push(b'"');
            }
            K::Obj | K::Arr if x.pristine => out.extend_from_slice(self.span(v)),
            K::Obj | K::Arr => {
                out.push(if x.k == K::Obj { b'{' } else { b'[' });
                let mut c = x.first;
                while c != 0 {
                    if c != x.first {
                        out.push(b',');
                    }
                    if x.k == K::Obj {
                        out.push(b'"');
                        out.extend_from_slice(self.key(c));
                        out.extend_from_slice(b"\":");
                    }
                    self.emit(c, out);
                    c = self.n[c as usize].next;
                }
                out.push(if x.k == K::Obj { b'}' } else { b']' });
            }
        }
    }
    fn emit_canonical(&mut self, v: V, out: &mut Vec<u8>) {
        self.expand(v);
        match self.kind(v) {
            K::Str => {
                let s = unescape_utf16(self.span(v));
                canonical_string(&s, out);
            }
            K::Num | K::NumF => out.extend_from_slice(js_json_num(self.f64(v).unwrap()).as_bytes()),
            K::Obj => {
                out.push(b'{');
                for (i, (k, c)) in self.members(v).into_iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    canonical_string(&k.encode_utf16().collect::<Vec<_>>(), out);
                    out.push(b':');
                    self.emit_canonical(c, out);
                }
                out.push(b'}');
            }
            K::Arr => {
                out.push(b'[');
                for (i, c) in self.items(v).into_iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    self.emit_canonical(c, out);
                }
                out.push(b']');
            }
            _ => self.emit(v, out),
        }
    }
    pub fn to_json(&self, v: V) -> Vec<u8> {
        let mut out = Vec::new();
        self.emit(v, &mut out);
        out
    }
    pub fn to_string(&self, v: V) -> String {
        self.string(v).map(|s| s.into_owned()).unwrap_or_default()
    }
}

impl Default for Doc {
    fn default() -> Self {
        Doc::new()
    }
}

// ---------- string helpers ----------
/// JS String.prototype.trim's whitespace: WhiteSpace + LineTerminator (includes U+FEFF, not U+0085).
fn js_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn is_decimal(s: &str) -> bool {
    let b = s.strip_prefix(['+', '-']).unwrap_or(s).as_bytes();
    let (mant, exp) = match b.iter().position(|&c| c == b'e' || c == b'E') {
        Some(i) => (&b[..i], Some(&b[i + 1..])),
        None => (b, None),
    };
    let digits = mant.iter().filter(|c| c.is_ascii_digit()).count();
    let dots = mant.iter().filter(|&&c| c == b'.').count();
    let mant_ok = digits > 0 && dots <= 1 && mant.iter().all(|c| c.is_ascii_digit() || *c == b'.');
    let exp_ok = exp.map_or(true, |e| {
        let e = e.strip_prefix(b"+").or_else(|| e.strip_prefix(b"-")).unwrap_or(e);
        !e.is_empty() && e.iter().all(|c| c.is_ascii_digit())
    });
    mant_ok && exp_ok
}
fn unescape_utf16(raw: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(raw.len());
    let s = std::str::from_utf8(raw).unwrap_or("");
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            let mut b = [0u16; 2];
            out.extend_from_slice(c.encode_utf16(&mut b));
            continue;
        }
        match it.next() {
            Some('n') => out.push(10),
            Some('t') => out.push(9),
            Some('r') => out.push(13),
            Some('b') => out.push(8),
            Some('f') => out.push(12),
            Some('u') => {
                let h: String = it.by_ref().take(4).collect();
                out.push(u16::from_str_radix(&h, 16).unwrap_or(0xfffd));
            }
            Some(c) => out.push(c as u16),
            None => {}
        }
    }
    out
}
pub fn unescape(raw: &[u8]) -> Cow<'_, str> {
    if !raw.contains(&b'\\') {
        return match std::str::from_utf8(raw) {
            Ok(s) => Cow::Borrowed(s),
            Err(_) => String::from_utf8_lossy(raw),
        };
    }
    Cow::Owned(String::from_utf16_lossy(&unescape_utf16(raw)))
}
fn escape_into(s: &str, out: &mut Vec<u8>) {
    if s.bytes().all(|b| b >= 0x20 && b != b'"' && b != b'\\') {
        out.extend_from_slice(s.as_bytes());
        return;
    }
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            c if (c as u32) < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => {
                let mut b = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut b).as_bytes())
            }
        }
    }
}
/// JSON.stringify's string form, from UTF-16 (lone surrogates become \uXXXX, as since ES2019).
fn canonical_string(s: &[u16], out: &mut Vec<u8>) {
    out.push(b'"');
    let mut i = 0;
    while i < s.len() {
        let u = s[i];
        if (0xd800..0xdc00).contains(&u) && i + 1 < s.len() && (0xdc00..0xe000).contains(&s[i + 1]) {
            let c = char::decode_utf16([u, s[i + 1]]).next().unwrap().unwrap();
            let mut b = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut b).as_bytes());
            i += 2;
            continue;
        }
        if (0xd800..0xe000).contains(&u) {
            out.extend_from_slice(format!("\\u{:04x}", u).as_bytes());
        } else {
            let c = char::from_u32(u as u32).unwrap();
            let mut tmp = Vec::new();
            escape_into(c.encode_utf8(&mut [0u8; 4]), &mut tmp);
            out.extend_from_slice(&tmp);
        }
        i += 1;
    }
    out.push(b'"');
}
/// JS Number.prototype.toString.
pub fn js_num(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let mut b = ryu_js::Buffer::new();
    b.format(f).to_owned()
}
/// JSON.stringify of a number: non-finite becomes null.
fn js_json_num(f: f64) -> String {
    if f.is_finite() { js_num(f) } else { "null".into() }
}

// ---------- strict JSON validation (for json()) ----------
fn valid_json(b: &[u8]) -> bool {
    let mut p = 0;
    let ws = |p: &mut usize| {
        while *p < b.len() && matches!(b[*p], b' ' | b'\n' | b'\r' | b'\t') {
            *p += 1
        }
    };
    fn val(b: &[u8], p: &mut usize, depth: u32) -> bool {
        let ws = |p: &mut usize| {
            while *p < b.len() && matches!(b[*p], b' ' | b'\n' | b'\r' | b'\t') {
                *p += 1
            }
        };
        if depth > 512 {
            return false;
        }
        ws(p);
        if *p >= b.len() {
            return false;
        }
        match b[*p] {
            b'{' | b'[' => {
                let obj = b[*p] == b'{';
                let close = if obj { b'}' } else { b']' };
                *p += 1;
                ws(p);
                if *p < b.len() && b[*p] == close {
                    *p += 1;
                    return true;
                }
                loop {
                    if obj {
                        ws(p);
                        if *p >= b.len() || b[*p] != b'"' || !string(b, p) {
                            return false;
                        }
                        ws(p);
                        if *p >= b.len() || b[*p] != b':' {
                            return false;
                        }
                        *p += 1;
                    }
                    if !val(b, p, depth + 1) {
                        return false;
                    }
                    ws(p);
                    if *p >= b.len() {
                        return false;
                    }
                    if b[*p] == b',' {
                        *p += 1;
                        continue;
                    }
                    if b[*p] == close {
                        *p += 1;
                        return true;
                    }
                    return false;
                }
            }
            b'"' => string(b, p),
            b't' => lit(b, p, b"true"),
            b'f' => lit(b, p, b"false"),
            b'n' => lit(b, p, b"null"),
            _ => number(b, p),
        }
    }
    fn lit(b: &[u8], p: &mut usize, l: &[u8]) -> bool {
        if b[*p..].starts_with(l) {
            *p += l.len();
            true
        } else {
            false
        }
    }
    fn string(b: &[u8], p: &mut usize) -> bool {
        *p += 1;
        while *p < b.len() {
            match b[*p] {
                b'"' => {
                    *p += 1;
                    return true;
                }
                b'\\' => {
                    *p += 1;
                    match b.get(*p) {
                        Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => *p += 1,
                        Some(b'u') if b.len() >= *p + 5 && b[*p + 1..*p + 5].iter().all(|c| c.is_ascii_hexdigit()) => *p += 5,
                        _ => return false,
                    }
                }
                c if c < 0x20 => return false,
                _ => *p += 1,
            }
        }
        false
    }
    fn number(b: &[u8], p: &mut usize) -> bool {
        let digits = |p: &mut usize| {
            let s = *p;
            while *p < b.len() && b[*p].is_ascii_digit() {
                *p += 1
            }
            *p > s
        };
        if b.get(*p) == Some(&b'-') {
            *p += 1;
        }
        if b.get(*p) == Some(&b'0') {
            *p += 1;
        } else if !digits(p) {
            return false;
        }
        if b.get(*p) == Some(&b'.') {
            *p += 1;
            if !digits(p) {
                return false;
            }
        }
        if matches!(b.get(*p), Some(b'e' | b'E')) {
            *p += 1;
            if matches!(b.get(*p), Some(b'+' | b'-')) {
                *p += 1;
            }
            if !digits(p) {
                return false;
            }
        }
        true
    }
    if !val(b, &mut p, 0) {
        return false;
    }
    ws(&mut p);
    p == b.len()
}

// ---------- guest output framing (read by hostgo/host/shared.go) ----------
/// Little-endian length-prefixed records: u32 len + bytes.
pub struct Frame(pub Vec<u8>);
impl Frame {
    pub fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(&(b.len() as u32).to_le_bytes());
        self.0.extend_from_slice(b);
    }
    pub fn u32(&mut self, n: u32) {
        self.0.extend_from_slice(&n.to_le_bytes());
    }
}

/// What generated code returns; the guest frames it for the Host.
pub struct ReqOut {
    pub body: Option<Vec<u8>>,
    pub imp_ids: Vec<String>,
    pub errs: Vec<String>,
}
pub struct BidAnnot {
    pub keep: bool,
    pub typ: String,
    pub seat: String,
    pub deal_priority: f64,
    pub video: Vec<u8>,
    pub meta: Vec<u8>,
    pub overrides: Vec<u8>,
}
pub struct BidsOut {
    pub bids: Vec<BidAnnot>,
    pub currency: String,
    pub paapi: Vec<u8>,
    pub errs: Vec<String>,
    /// the response Phase rejected the response: no bids at all
    pub rejected: bool,
}
/// Several outgoing requests (one per group), each with its imp ids.
pub struct Reqs {
    pub reqs: Vec<(Vec<u8>, Vec<String>)>,
    pub errs: Vec<String>,
}
impl Doc {
    /// An object's members as key/value frames the Host can read without a JSON decoder:
    /// u32 count, then per member: key bytes, u8 kind (0 string content, 1 number text, 2 JSON), value bytes.
    pub fn kv_slot(&mut self, v: V) -> Vec<u8> {
        self.expand(v);
        let mut f = Frame(Vec::new());
        if self.kind(v) != K::Obj {
            return f.0; // absent (or not an object): an empty slot
        }
        if self.n[v as usize].first == 0 {
            f.u32(0); // an object with no members: present, but empty
            return f.0;
        }
        let ms = self.members(v);
        f.u32(ms.len() as u32);
        for (k, c) in ms {
            f.bytes(k.as_bytes());
            match self.kind(c) {
                K::Str => {
                    f.0.push(0);
                    let s = self.string(c).unwrap().into_owned();
                    f.bytes(s.as_bytes());
                }
                K::Num | K::NumF => {
                    f.0.push(1);
                    let t = if self.kind(c) == K::Num { self.span(c).to_vec() } else { js_json_num(self.f64(c).unwrap()).into_bytes() };
                    f.bytes(&t);
                }
                _ => {
                    f.0.push(2);
                    let j = self.to_json(c);
                    f.bytes(&j);
                }
            }
        }
        f.0
    }
    /// JSON of a value for an annotation slot; absent and empty objects become an empty slot.
    pub fn slot(&mut self, v: V) -> Vec<u8> {
        if self.nonempty(v) == ABSENT || self.nullish(v) { Vec::new() } else { self.to_json(v) }
    }
}
