//! PROTOTYPE Prebid Core runtime for the typed Rust back end (#17): what Rust generated from an
//! Adapter Definition calls. Values are spans of the input, not arena nodes:
//!
//! - Decoding is shape-driven. The Definition Compiler derives, per Phase, which input paths it reads
//!   (a `Shape`). `index` scans the input once, indexing those paths and keeping everything else as
//!   raw spans. An indexed object remembers its own span, so emitting it unchanged is one copy.
//! - Output is spread-plus-overrides (`O`, built by `spread` / `set`), written straight into the
//!   guest's output buffer by `emit`. Key order is free (ADR 0001): overrides of existing keys stay
//!   in place, new keys go last.
//! - Strings follow ADR 0001 / #23: JS strings (UTF-16 code units). A string is its escaped span
//!   until read; cooked, it is `str` (fast path) unless it holds a lone surrogate (`U16`).
use prebid_core_rt::{js_json_num, js_num, js_ws, valid_json};
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub type Raw<'a> = &'a [u8];

// ================================================================ reading

/// A cursor over one JSON text. Lenient: it trusts its input (the Host's serializer, validated UTF-8).
pub struct P<'a> {
    b: &'a [u8],
    pub i: usize,
}
impl<'a> P<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        P { b, i: 0 }
    }
    #[inline]
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    #[inline]
    fn peek(&mut self) -> u8 {
        self.ws();
        *self.b.get(self.i).unwrap_or(&0)
    }
    #[inline]
    fn str_end(&self, mut i: usize) -> usize {
        let b = self.b;
        loop {
            let Some(t) = b.get(i..) else { return b.len() };
            match t.iter().position(|&c| c == b'"' || c == b'\\') {
                None => return b.len(),
                Some(o) if b[i + o] == b'"' => return i + o,
                Some(o) => i += o + 2,
            }
        }
    }
    /// Like str_end, also saying whether the string holds an escape.
    #[inline]
    fn str_end_x(&self, mut i: usize) -> (usize, bool) {
        let b = self.b;
        let mut x = false;
        loop {
            let Some(t) = b.get(i..) else { return (b.len(), x) };
            match t.iter().position(|&c| c == b'"' || c == b'\\') {
                None => return (b.len(), x),
                Some(o) if b[i + o] == b'"' => return (i + o, x),
                Some(o) => {
                    x = true;
                    i += o + 2
                }
            }
        }
    }
    fn skip(&mut self) {
        let b = self.b;
        match self.peek() {
            b'"' => self.i = self.str_end(self.i + 1) + 1,
            c @ (b'{' | b'[') => {
                let close = if c == b'{' { b'}' } else { b']' };
                let (mut depth, mut i) = (0u32, self.i);
                loop {
                    let Some(t) = b.get(i..) else { break };
                    let Some(o) = t.iter().position(|&x| x == b'"' || x == c || x == close) else {
                        i = b.len();
                        break;
                    };
                    i += o;
                    let x = b[i];
                    if x == b'"' {
                        i = self.str_end(i + 1) + 1;
                        continue;
                    }
                    i += 1;
                    if x == c {
                        depth += 1;
                    } else {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
                self.i = i.min(b.len());
            }
            _ => {
                let t = &b[self.i..];
                self.i += t.iter().position(|&c| matches!(c, b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t')).unwrap_or(t.len());
            }
        }
    }
    fn raw(&mut self) -> Raw<'a> {
        self.ws();
        let s = self.i;
        self.skip();
        &self.b[s..self.i]
    }
}

// ================================================================ strings

/// A JS string. `Esc` is the escaped content of a JSON string in the input (or a compile-time
/// literal), `Own` a computed string with no lone surrogate, `U16` anything holding one.
#[derive(Clone)]
pub enum Js<'a> {
    /// input text with no escape (valid UTF-8, used as is)
    Esc(&'a [u8]),
    /// escaped content holding at least one `\` (decoded on read); the scanner knows which it saw
    EscX(&'a [u8]),
    Own(Rc<str>),
    U16(Rc<[u16]>),
}
/// A cooked string: `str` on the fast path, UTF-16 when a lone surrogate is present.
pub enum Ck<'x> {
    S(Cow<'x, str>),
    W(Rc<[u16]>),
}
impl<'a> Js<'a> {
    pub const EMPTY: Js<'static> = Js::Esc(b"");
    /// A string from computed text (never holds a lone surrogate).
    pub fn own(s: String) -> Js<'a> {
        Js::Own(s.into())
    }
    /// From UTF-16: back to `Own` when well-formed (an adjacent high + low fuse, as JS joins them).
    pub fn from_u16(w: Vec<u16>) -> Js<'a> {
        match String::from_utf16(&w) {
            Ok(s) => Js::own(s),
            Err(_) => Js::U16(w.into()),
        }
    }
    pub fn ck(&self) -> Ck<'_> {
        match self {
            Js::Esc(b) => Ck::S(Cow::Borrowed(unsafe { std::str::from_utf8_unchecked(b) })),
            Js::EscX(b) => unescape(b),
            Js::Own(s) => Ck::S(Cow::Borrowed(s)),
            Js::U16(w) => Ck::W(w.clone()),
        }
    }
    /// Borrowed from the input when nothing had to be decoded.
    pub fn ck_a(&self) -> Ck<'a> {
        match self {
            Js::Esc(b) => Ck::S(Cow::Borrowed(unsafe { std::str::from_utf8_unchecked(b) })),
            Js::EscX(b) => unescape(b),
            Js::Own(s) => Ck::S(Cow::Owned(s.to_string())),
            Js::U16(w) => Ck::W(w.clone()),
        }
    }
    pub fn u16(&self) -> Vec<u16> {
        match self.ck() {
            Ck::S(s) => s.encode_utf16().collect(),
            Ck::W(w) => w.to_vec(),
        }
    }
    /// For Host-side string slots (errors, type, seat): lone surrogates become U+FFFD (ABI fog).
    pub fn lossy(&self) -> String {
        match self.ck() {
            Ck::S(s) => s.into_owned(),
            Ck::W(w) => String::from_utf16_lossy(&w),
        }
    }
    pub fn is_empty(&self) -> bool {
        match self {
            Js::Esc(b) | Js::EscX(b) => b.is_empty(),
            Js::Own(s) => s.is_empty(),
            Js::U16(w) => w.is_empty(),
        }
    }
    pub fn eq(&self, o: &Js) -> bool {
        match (self, o) {
            (Js::Esc(a), Js::Esc(b)) => return bytes_eq(a, b),
            (Js::EscX(a), Js::EscX(b)) if bytes_eq(a, b) => return true,
            _ => {}
        }
        match (self.ck(), o.ck()) {
            (Ck::S(a), Ck::S(b)) => a == b,
            (Ck::W(a), Ck::W(b)) => a == b,
            _ => false, // only one holds a lone surrogate
        }
    }
    /// Compare with a literal (compile-time keys and strings are always well-formed).
    #[inline]
    pub fn is(&self, lit: &str) -> bool {
        match self {
            Js::Esc(b) => bytes_eq(b, lit.as_bytes()),
            Js::EscX(b) => b.len() > lit.len() && matches!(unescape(b), Ck::S(s) if s == lit),
            Js::Own(s) => &**s == lit,
            Js::U16(_) => false,
        }
    }
}

#[inline(always)]
fn bytes_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}
/// Object keys never hold escapes (resolved when indexed), so they compare as bytes.
#[inline]
pub fn key_is(k: &Js, lit: &str) -> bool {
    match k {
        Js::Esc(b) => bytes_eq(b, lit.as_bytes()),
        Js::Own(s) => bytes_eq(s.as_bytes(), lit.as_bytes()),
        Js::EscX(_) | Js::U16(_) => k.is(lit),
    }
}
#[inline]
pub fn key_eq(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Esc(x), Js::Esc(y)) => bytes_eq(x, y),
        (Js::Esc(x), Js::Own(y)) | (Js::Own(y), Js::Esc(x)) => bytes_eq(x, y.as_bytes()),
        (Js::Own(x), Js::Own(y)) => x == y,
        (Js::U16(x), Js::U16(y)) => x == y,
        _ => a.eq(b),
    }
}
/// Escaped JSON string content -> JS string. Pairs fuse; a lone surrogate switches to UTF-16.
pub fn unescape(b: &[u8]) -> Ck<'_> {
    if !b.contains(&b'\\') {
        // validated UTF-8 at the guest boundary
        return Ck::S(Cow::Borrowed(unsafe { std::str::from_utf8_unchecked(b) }));
    }
    let mut w: Vec<u16> = Vec::with_capacity(b.len());
    let mut lone = false;
    let mut i = 0;
    let s = unsafe { std::str::from_utf8_unchecked(b) };
    while i < b.len() {
        if b[i] != b'\\' {
            let n = b[i..].iter().position(|&c| c == b'\\').unwrap_or(b.len() - i);
            w.extend(s[i..i + n].encode_utf16());
            i += n;
            continue;
        }
        let c = *b.get(i + 1).unwrap_or(&b'\\');
        i += 2;
        match c {
            b'n' => w.push(10),
            b't' => w.push(9),
            b'r' => w.push(13),
            b'b' => w.push(8),
            b'f' => w.push(12),
            b'u' => {
                let h = b.get(i..i + 4).and_then(|x| u16::from_str_radix(std::str::from_utf8(x).ok()?, 16).ok()).unwrap_or(0xfffd);
                i += 4;
                w.push(h);
            }
            c => w.push(c as u16),
        }
    }
    // pairs are well-formed; only an unpaired surrogate needs UTF-16
    let mut k = 0;
    while k < w.len() {
        let u = w[k];
        if (0xd800..0xdc00).contains(&u) && k + 1 < w.len() && (0xdc00..0xe000).contains(&w[k + 1]) {
            k += 2;
            continue;
        }
        if (0xd800..0xe000).contains(&u) {
            lone = true;
            break;
        }
        k += 1;
    }
    if lone {
        Ck::W(w.into())
    } else {
        Ck::S(Cow::Owned(String::from_utf16(&w).unwrap()))
    }
}

// ================================================================ values

/// A JS value. `Raw` is an input object or array nobody indexed; `Num` keeps its input text so it
/// passes through exactly.
#[derive(Clone)]
pub enum V<'a> {
    U,
    Null,
    T,
    F,
    Num(f64, Option<Raw<'a>>),
    /// a number from the input, not yet parsed
    NumR(Raw<'a>),
    Str(Js<'a>),
    Obj(Rc<O<'a>>),
    Arr(Rc<Vec<V<'a>>>),
    Raw(Raw<'a>),
    /// `s.split(sep)`, not materialized: `[i]` and `.length` read it in place
    Split(Js<'a>, &'static str),
}
/// An object: members in order, unique keys unless `dup` (only an indexed input can have them).
/// `raw` is the input span while the object is unchanged.
#[derive(Clone, Default)]
pub struct O<'a> {
    pub m: Vec<(Js<'a>, V<'a>)>,
    pub dup: bool,
    pub raw: Option<Raw<'a>>,
}
pub use V::U;

/// Which input paths a Phase reads: listed members are indexed recursively, everything else
/// stays a span. `All` indexes every member's value with one shape (Object.entries, callbacks).
pub enum Shape {
    Leaf,
    Obj(&'static [(&'static str, &'static Shape)]),
    All(&'static Shape),
    Arr(&'static Shape),
}
pub static LEAF: Shape = Shape::Leaf;
pub static SHALLOW: Shape = Shape::Obj(&[]);

thread_local! {
    /// reads that hit a span the shape didn't index (each re-scans it); reported by the bench
    pub static OFF_SHAPE: Cell<u64> = const { Cell::new(0) };
}

pub fn parse<'a>(b: &'a [u8], sh: &Shape) -> V<'a> {
    let mut p = P::new(b);
    val(&mut p, sh)
}
fn val<'a>(p: &mut P<'a>, sh: &Shape) -> V<'a> {
    match p.peek() {
        b'"' => {
            let s = p.i + 1;
            let (e, x) = p.str_end_x(s);
            p.i = e + 1;
            V::Str(if x { Js::EscX(&p.b[s..e]) } else { Js::Esc(&p.b[s..e]) })
        }
        b'{' => match sh {
            Shape::Obj(_) | Shape::All(_) => V::Obj(Rc::new(obj(p, sh))),
            _ => V::Raw(p.raw()),
        },
        b'[' => match sh {
            Shape::Arr(el) => {
                p.i += 1;
                let mut v = Vec::new();
                loop {
                    match p.peek() {
                        b']' => {
                            p.i += 1;
                            break;
                        }
                        b',' => p.i += 1,
                        0 => break,
                        _ => v.push(val(p, el)),
                    }
                }
                V::Arr(Rc::new(v))
            }
            _ => V::Raw(p.raw()),
        },
        b't' => {
            p.i += 4;
            V::T
        }
        b'f' => {
            p.i += 5;
            V::F
        }
        b'n' => {
            p.i += 4;
            V::Null
        }
        _ => {
            let r = p.raw();
            V::NumR(r)
        }
    }
}
fn obj<'a>(p: &mut P<'a>, sh: &Shape) -> O<'a> {
    p.ws();
    let start = p.i;
    p.i += 1;
    let mut o = O { m: Vec::with_capacity(8), dup: false, raw: None };
    let mut seen = 0u64;
    loop {
        match p.peek() {
            b'}' => {
                p.i += 1;
                break;
            }
            b',' => {
                p.i += 1;
                continue;
            }
            0 => break,
            _ => {}
        }
        let s = p.i + 1;
        let (e, x) = p.str_end_x(s);
        p.i = e + 1;
        p.ws();
        p.i += 1;
        let kb = &p.b[s..e];
        let k = if x {
            match unescape(kb) {
                Ck::S(t) => Js::own(t.into_owned()),
                Ck::W(w) => Js::U16(w),
            }
        } else {
            Js::Esc(kb)
        };
        let child = match sh {
            Shape::Obj(cs) => cs.iter().find(|(n, _)| key_is(&k, n)).map(|(_, c)| *c).unwrap_or(&LEAF),
            Shape::All(c) => c,
            _ => &LEAF,
        };
        let v = val(p, child);
        let bit = 1u64 << ((kb.len() as u64 * 31 + *kb.first().unwrap_or(&0) as u64 * 7 + *kb.last().unwrap_or(&0) as u64) % 64);
        if seen & bit != 0 && !o.dup && o.m.iter().any(|(x, _)| key_eq(x, &k)) {
            o.dup = true;
        }
        seen |= bit;
        o.m.push((k, v));
    }
    o.raw = Some(&p.b[start..p.i]);
    o
}
/// A number's value, parsing input text on first use.
#[inline]
pub fn fnum(v: &V) -> Option<f64> {
    match v {
        V::Num(f, _) => Some(*f),
        V::NumR(r) => Some(parse_num(r)),
        _ => None,
    }
}
fn parse_num(r: &[u8]) -> f64 {
    std::str::from_utf8(r).ok().and_then(|s| s.parse().ok()).unwrap_or(f64::NAN)
}
/// An object this code reads: indexed (shape miss counted) or the object itself.
fn as_obj<'x, 'a>(v: &'x V<'a>) -> Option<Cow<'x, O<'a>>> {
    match v {
        V::Obj(o) => Some(Cow::Borrowed(&**o)),
        V::Raw(r) if r.first() == Some(&b'{') => {
            OFF_SHAPE.with(|c| c.set(c.get() + 1));
            Some(Cow::Owned(obj(&mut P::new(r), &SHALLOW)))
        }
        _ => None,
    }
}
fn as_arr<'x, 'a>(v: &'x V<'a>) -> Option<Cow<'x, Vec<V<'a>>>> {
    match v {
        V::Split(s, sep) => match split_now(&V::Str(s.clone()), sep) {
            V::Arr(a) => Some(Cow::Owned((*a).clone())),
            _ => None,
        },
        V::Arr(a) => Some(Cow::Borrowed(&**a)),
        V::Raw(r) if r.first() == Some(&b'[') => {
            OFF_SHAPE.with(|c| c.set(c.get() + 1));
            match parse(r, &Shape::Arr(&LEAF)) {
                V::Arr(a) => Some(Cow::Owned(Rc::try_unwrap(a).unwrap_or_else(|a| (*a).clone()))),
                _ => None,
            }
        }
        _ => None,
    }
}

impl<'a> O<'a> {
    /// The value of a member, last duplicate winning (JSON.parse).
    pub fn get(&self, k: &str) -> V<'a> {
        self.m.iter().rev().find(|(x, _)| key_is(x, k)).map(|(_, v)| v.clone()).unwrap_or(U)
    }
    /// Members as JS sees them: deduplicated (first position, last value), integer-like keys first.
    pub fn members(&self) -> Vec<(Js<'a>, V<'a>)> {
        let mut out: Vec<(Js<'a>, V<'a>)> = Vec::with_capacity(self.m.len());
        if self.dup {
            for (k, v) in &self.m {
                match out.iter_mut().find(|(x, _)| key_eq(x, k)) {
                    Some(e) => e.1 = v.clone(),
                    None => out.push((k.clone(), v.clone())),
                }
            }
        } else {
            out.extend(self.m.iter().cloned());
        }
        let idx = |k: &Js| -> Option<u64> {
            let Ck::S(s) = k.ck() else { return None };
            let s: &str = &s;
            if s == "0" || (!s.is_empty() && !s.starts_with('0') && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit())) {
                s.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64)
            } else {
                None
            }
        };
        if out.iter().any(|(k, _)| idx(k).is_some()) {
            let mut ints: Vec<_> = out.iter().filter(|(k, _)| idx(k).is_some()).cloned().collect();
            ints.sort_by_key(|(k, _)| idx(k));
            ints.extend(out.into_iter().filter(|(k, _)| idx(k).is_none()));
            return ints;
        }
        out
    }
    /// Assignment: an existing key keeps its position; undefined deletes.
    pub fn set(&mut self, k: Js<'a>, v: V<'a>) {
        self.raw = None;
        let undef = matches!(v, V::U);
        match self.m.iter().position(|(x, _)| key_eq(x, &k)) {
            Some(i) if undef => {
                self.m.retain(|(x, _)| !key_eq(x, &k));
                let _ = i;
            }
            Some(i) => self.m[i].1 = v,
            None if undef => {}
            None => self.m.push((k, v)),
        }
    }
}

// ---------- constructing ----------

/// `{ ...src }`: src's members in JS order, deduplicated. Not an object: `{}`.
pub fn spread<'a>(src: &V<'a>) -> O<'a> {
    match as_obj(src) {
        Some(o) if !o.dup => {
            let mut r = o.into_owned();
            r.raw = None;
            r
        }
        Some(o) => O { m: o.members(), dup: false, raw: None },
        None => O::default(),
    }
}
/// `{ ...a, ...src }` after the first spread.
pub fn assign<'a>(o: &mut O<'a>, src: &V<'a>) {
    if let Some(s) = as_obj(src) {
        for (k, v) in s.members() {
            o.set(k, v);
        }
    }
}
/// `local.k = v` on an object this function created (fresh, so the Rc is unique).
pub fn set_v<'a>(o: &mut V<'a>, k: Js<'a>, v: V<'a>) {
    if let V::Obj(rc) = o {
        Rc::make_mut(rc).set(k, v);
    }
}
pub fn obj_v<'a>(o: O<'a>) -> V<'a> {
    V::Obj(Rc::new(o))
}
/// Array literal / map element: undefined is kept (JS keeps it; it prints as null).
pub fn arr_v<'a>(v: Vec<V<'a>>) -> V<'a> {
    if v.is_empty() {
        return empty_arr();
    }
    V::Arr(Rc::new(v))
}
thread_local! {
    static EMPTY: Rc<Vec<V<'static>>> = Rc::new(Vec::new());
}
/// `[]`: one shared empty array (arrays are never mutated in place).
pub fn empty_arr<'a>() -> V<'a> {
    V::Arr(EMPTY.with(|e| e.clone()))
}
pub fn s<'a>(s: String) -> V<'a> {
    V::Str(Js::own(s))
}
/// A string literal: the compiler passes its JSON-escaped text and whether it holds an escape.
#[inline]
pub fn lit(s: &'static [u8]) -> V<'static> {
    V::Str(Js::Esc(s))
}
#[inline]
pub fn litx(s: &'static [u8]) -> V<'static> {
    V::Str(Js::EscX(s))
}
#[inline]
pub fn num(f: f64) -> V<'static> {
    V::Num(f, None)
}
#[inline]
pub fn bool_(b: bool) -> V<'static> {
    if b { V::T } else { V::F }
}

// ---------- reading ----------

pub fn get<'a>(o: &V<'a>, k: &str) -> V<'a> {
    match o {
        V::Obj(o) => o.get(k),
        V::Raw(_) => as_obj(o).map_or(U, |o| o.get(k)),
        _ => U,
    }
}
pub fn at<'a>(a: &V<'a>, i: usize) -> V<'a> {
    match a {
        V::Split(s, sep) => split_part(s, sep, i).unwrap_or(U),
        V::Arr(a) => a.get(i).cloned().unwrap_or(U),
        V::Raw(_) => as_arr(a).and_then(|a| a.get(i).cloned()).unwrap_or(U),
        _ => U,
    }
}
/// `o[k]` for a non-literal key.
pub fn index<'a>(o: &V<'a>, k: &V<'a>) -> V<'a> {
    match (o, k) {
        (V::Arr(_) | V::Raw(_) | V::Split(..), k) if fnum(k).map_or(false, |f| f >= 0.0 && f.fract() == 0.0) && !matches!(o, V::Raw(r) if r.first() == Some(&b'{')) => at(o, fnum(k).unwrap() as usize),
        _ => match scalar(k) {
            Some(s) => get(o, &s),
            None => U,
        },
    }
}
/// For `for..of`, map, filter, ...: the elements (not an array: none).
pub fn items<'a>(a: &V<'a>) -> Rc<Vec<V<'a>>> {
    match a {
        V::Arr(r) => r.clone(),
        _ => Rc::new(as_arr(a).map(|a| a.into_owned()).unwrap_or_default()),
    }
}
pub fn truthy(v: &V) -> bool {
    match v {
        V::U | V::Null | V::F => false,
        V::T | V::Obj(_) | V::Arr(_) | V::Raw(_) | V::Split(..) => true,
        V::Num(..) | V::NumR(_) => {
            let f = fnum(v).unwrap();
            f != 0.0 && !f.is_nan()
        }
        V::Str(s) => !s.is_empty(),
    }
}
pub fn nullish(v: &V) -> bool {
    matches!(v, V::U | V::Null)
}
pub fn is_undef(v: &V) -> bool {
    matches!(v, V::U)
}
pub fn is_array(v: &V) -> bool {
    matches!(v, V::Arr(_) | V::Split(..)) || matches!(v, V::Raw(r) if r.first() == Some(&b'['))
}
pub fn typeof_(v: &V) -> &'static str {
    match v {
        V::U => "undefined",
        V::T | V::F => "boolean",
        V::Num(..) | V::NumR(_) => "number",
        V::Str(_) => "string",
        _ => "object",
    }
}
/// `===`
pub fn eq(a: &V, b: &V) -> bool {
    match (a, b) {
        (V::U, V::U) | (V::Null, V::Null) | (V::T, V::T) | (V::F, V::F) => true,
        (V::Num(..) | V::NumR(_), V::Num(..) | V::NumR(_)) => fnum(a) == fnum(b),
        (V::Str(x), V::Str(y)) => x.eq(y),
        (V::Obj(x), V::Obj(y)) => Rc::ptr_eq(x, y),
        (V::Arr(x), V::Arr(y)) => Rc::ptr_eq(x, y),
        (V::Raw(x), V::Raw(y)) => std::ptr::eq(x.as_ptr(), y.as_ptr()),
        _ => false,
    }
}
#[inline]
pub fn is_lit(v: &V, lit: &str) -> bool {
    matches!(v, V::Str(s) if s.is(lit))
}
pub fn f64_(v: &V) -> f64 {
    match v {
        V::Num(..) | V::NumR(_) => fnum(v).unwrap(),
        _ => f64::NAN,
    }
}
pub fn lt(a: &V, b: &V) -> bool {
    f64_(a) < f64_(b)
}
pub fn gt(a: &V, b: &V) -> bool {
    f64_(a) > f64_(b)
}
pub fn le(a: &V, b: &V) -> bool {
    f64_(a) <= f64_(b)
}
pub fn ge(a: &V, b: &V) -> bool {
    f64_(a) >= f64_(b)
}
pub fn arith(a: &V, b: &V, op: u8) -> V<'static> {
    let (x, y) = (f64_(a), f64_(b));
    num(match op {
        b'+' => x + y,
        b'-' => x - y,
        b'*' => x * y,
        b'/' => x / y,
        _ => x % y,
    })
}

// ---------- Prebid Core helpers ----------

fn scalar(v: &V) -> Option<String> {
    match v {
        V::Str(s) => Some(s.lossy()),
        V::Num(..) | V::NumR(_) => Some(js_num(fnum(v).unwrap())),
        V::T => Some("true".into()),
        V::F => Some("false".into()),
        _ => None,
    }
}
pub fn str_<'a>(v: &V<'a>) -> V<'a> {
    match v {
        V::Str(_) => v.clone(),
        V::Num(..) | V::NumR(_) => s(js_num(fnum(v).unwrap())),
        V::T => lit(b"true"),
        V::F => lit(b"false"),
        _ => U,
    }
}
fn is_decimal(s: &str) -> bool {
    let b = s.strip_prefix(['+', '-']).unwrap_or(s).as_bytes();
    let (mut i, mut digits) = (0, 0);
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let s0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s0 {
            return false;
        }
    }
    i == b.len()
}
pub fn num_<'a>(v: &V<'a>) -> V<'a> {
    match v {
        V::Num(..) | V::NumR(_) => v.clone(),
        V::Str(js) => match js.ck() {
            Ck::S(t) if is_decimal(&t) => num(t.parse().unwrap_or(f64::NAN)),
            _ => U,
        },
        _ => U,
    }
}
pub fn int<'a>(v: &V<'a>) -> V<'a> {
    match v {
        V::Num(..) | V::NumR(_) if fnum(v).map_or(false, |f| f.is_finite() && f.fract() == 0.0) => v.clone(),
        V::Str(js) => match js.ck() {
            Ck::S(t) => {
                let d = t.strip_prefix(['+', '-']).unwrap_or(&t);
                if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) { num(t.parse().unwrap()) } else { U }
            }
            _ => U,
        },
        _ => U,
    }
}
pub fn nonempty<'a>(v: V<'a>) -> V<'a> {
    let empty = match &v {
        V::Str(s) => s.is_empty(),
        V::Obj(o) => o.m.iter().all(|(_, x)| matches!(x, V::U)),
        V::Arr(a) => a.is_empty(),
        V::Split(..) => false,
        V::Raw(r) => r.iter().skip(1).find(|c| !c.is_ascii_whitespace()).map_or(true, |c| *c == b'}' || *c == b']'),
        _ => false,
    };
    if empty { U } else { v }
}
pub fn obj_<'a>(v: &V<'a>) -> V<'a> {
    match v {
        V::Obj(_) => v.clone(),
        V::Raw(r) if r.first() == Some(&b'{') => v.clone(),
        _ => U,
    }
}
pub fn without<'a>(o: &V<'a>, ks: &[&str]) -> V<'a> {
    if as_obj(o).is_none() {
        return U;
    }
    let mut r = spread(o);
    r.m.retain(|(k, _)| !ks.iter().any(|x| key_is(k, x)));
    obj_v(r)
}

// ---------- strings ----------

pub fn len<'a>(v: &V<'a>) -> V<'a> {
    match v {
        V::Str(s) => num(match s.ck() {
            Ck::S(t) => t.encode_utf16().count() as f64,
            Ck::W(w) => w.len() as f64,
        }),
        V::Split(s, sep) => num(split_len(s, sep) as f64),
        V::Arr(_) | V::Raw(_) if is_array(v) => num(items(v).len() as f64),
        _ => U,
    }
}
fn js_ws16(u: u16) -> bool {
    char::from_u32(u as u32).map_or(false, js_ws)
}
pub fn trim<'a>(v: &V<'a>) -> V<'a> {
    let V::Str(s) = v else { return U };
    match s {
        Js::Esc(b) => {
            let t = unsafe { std::str::from_utf8_unchecked(b) }.trim_matches(js_ws);
            V::Str(Js::Esc(t.as_bytes()))
        }
        _ => match s.ck() {
            Ck::S(t) => {
                let r = t.trim_matches(js_ws);
                if r.len() == t.len() { v.clone() } else { V::Str(Js::own(r.to_string())) }
            }
            Ck::W(w) => {
                let a = w.iter().position(|u| !js_ws16(*u)).unwrap_or(w.len());
                let z = w.iter().rposition(|u| !js_ws16(*u)).map_or(a, |z| z + 1);
                V::Str(Js::from_u16(w[a..z].to_vec()))
            }
        },
    }
}
pub fn lower<'a>(v: &V<'a>) -> V<'a> {
    let V::Str(s) = v else { return U };
    match s.ck() {
        Ck::S(t) if !t.bytes().any(|b| b.is_ascii_uppercase() || b >= 0x80) => v.clone(),
        Ck::S(t) => V::Str(Js::own(t.to_lowercase())),
        Ck::W(w) => {
            // lowercase every well-formed run; lone surrogates stay as they are
            let mut out: Vec<u16> = Vec::with_capacity(w.len());
            for r in char::decode_utf16(w.iter().copied()) {
                match r {
                    Ok(c) => c.to_lowercase().for_each(|l| out.extend(l.encode_utf16(&mut [0; 2]).iter())),
                    Err(e) => out.push(e.unpaired_surrogate()),
                }
            }
            V::Str(Js::from_u16(out))
        }
    }
}
/// `s.split(sep)`, sep a non-empty literal (the subset rejects others).
pub fn split<'a>(v: &V<'a>, sep: &'static str) -> V<'a> {
    match v {
        V::Str(s @ (Js::Esc(_) | Js::Own(_))) => V::Split(s.clone(), sep),
        _ => split_now(v, sep),
    }
}
fn split_part<'a>(s: &Js<'a>, sep: &str, i: usize) -> Option<V<'a>> {
    match s {
        Js::Esc(b) => unsafe { std::str::from_utf8_unchecked(b) }.split(sep).nth(i).map(|p| V::Str(Js::Esc(p.as_bytes()))),
        Js::Own(t) => t.split(sep).nth(i).map(|p| V::Str(Js::own(p.to_string()))),
        _ => None,
    }
}
fn split_len(s: &Js, sep: &str) -> usize {
    match s {
        Js::Esc(b) => unsafe { std::str::from_utf8_unchecked(b) }.split(sep).count(),
        Js::Own(t) => t.split(sep).count(),
        _ => 0,
    }
}
fn split_now<'a>(v: &V<'a>, sep: &str) -> V<'a> {
    let V::Str(s) = v else { return U };
    let parts: Vec<V<'a>> = match s {
        Js::Esc(b) => {
            unsafe { std::str::from_utf8_unchecked(b) }.split(sep).map(|p| V::Str(Js::Esc(p.as_bytes()))).collect()
        }
        _ => match s.ck() {
            Ck::S(t) => t.split(sep).map(|p| V::Str(Js::own(p.to_string()))).collect(),
            Ck::W(w) => {
                let sp: Vec<u16> = sep.encode_utf16().collect();
                let mut out = Vec::new();
                let mut st = 0;
                let mut i = 0;
                while i + sp.len() <= w.len() {
                    if w[i..i + sp.len()] == sp[..] {
                        out.push(V::Str(Js::from_u16(w[st..i].to_vec())));
                        i += sp.len();
                        st = i;
                    } else {
                        i += 1;
                    }
                }
                out.push(V::Str(Js::from_u16(w[st..].to_vec())));
                out
            }
        },
    };
    arr_v(parts)
}
pub fn includes<'a>(v: &V<'a>, sub: &V<'a>) -> V<'a> {
    match (v, sub) {
        (V::Str(a), V::Str(b)) => bool_(match (a.ck(), b.ck()) {
            (Ck::S(x), Ck::S(y)) => x.contains(&*y),
            _ => {
                let (x, y) = (a.u16(), b.u16());
                y.is_empty() || x.windows(y.len()).any(|w| w == &y[..])
            }
        }),
        _ => U,
    }
}
/// Appends `v` the way a template or `join` prints it.
fn print(v: &V, out: &mut Vec<u16>, in_join: bool) {
    match v {
        V::U => {
            if !in_join {
                out.extend("undefined".encode_utf16())
            }
        }
        V::Null => {
            if !in_join {
                out.extend("null".encode_utf16())
            }
        }
        V::Str(s) => match s.ck() {
            Ck::S(t) => out.extend(t.encode_utf16()),
            Ck::W(w) => out.extend_from_slice(&w),
        },
        V::Arr(_) | V::Raw(_) | V::Split(..) if is_array(v) => {
            for (i, x) in items(v).iter().enumerate() {
                if i > 0 {
                    out.push(b',' as u16);
                }
                print(x, out, true);
            }
        }
        V::Obj(_) | V::Raw(_) => out.extend("[object Object]".encode_utf16()),
        _ => out.extend(scalar(v).unwrap_or_default().encode_utf16()),
    }
}
/// A template literal: literal parts and interpolated values.
pub struct Tmpl(String, Option<Vec<u16>>);
impl Tmpl {
    pub fn new() -> Self {
        Tmpl(String::with_capacity(32), None)
    }
    pub fn lit(&mut self, s: &str) {
        match &mut self.1 {
            None => self.0.push_str(s),
            Some(w) => w.extend(s.encode_utf16()),
        }
    }
    pub fn val(&mut self, v: &V) {
        if self.1.is_none() && print_s(v, &mut self.0, false) {
            return;
        }
        let w = self.1.get_or_insert_with(|| self.0.encode_utf16().collect());
        print(v, w, false)
    }
    pub fn done<'a>(self) -> V<'a> {
        match self.1 {
            None => V::Str(Js::own(self.0)),
            Some(w) => V::Str(Js::from_u16(w)),
        }
    }
}
/// `print` into UTF-8; false (having written nothing) if `v` holds a lone surrogate.
fn print_s(v: &V, out: &mut String, in_join: bool) -> bool {
    match v {
        V::U => {
            if !in_join {
                out.push_str("undefined")
            }
        }
        V::Null => {
            if !in_join {
                out.push_str("null")
            }
        }
        V::Str(s) => match s.ck() {
            Ck::S(t) => out.push_str(&t),
            Ck::W(_) => return false,
        },
        V::Arr(_) | V::Raw(_) | V::Split(..) if is_array(v) => {
            let mark = out.len();
            for (i, x) in items(v).iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !print_s(x, out, true) {
                    out.truncate(mark);
                    return false;
                }
            }
        }
        V::Obj(_) | V::Raw(_) => out.push_str("[object Object]"),
        _ => out.push_str(&scalar(v).unwrap_or_default()),
    }
    true
}
impl Default for Tmpl {
    fn default() -> Self {
        Self::new()
    }
}
pub fn join<'a>(l: &V<'a>, sep: &str) -> V<'a> {
    if !is_array(l) {
        return U;
    }
    let it = items(l);
    let mut s = String::new();
    let mut ok = true;
    for (i, x) in it.iter().enumerate() {
        if i > 0 {
            s.push_str(sep);
        }
        if !print_s(x, &mut s, true) {
            ok = false;
            break;
        }
    }
    if ok {
        return V::Str(Js::own(s));
    }
    let mut out: Vec<u16> = Vec::new();
    for (i, x) in it.iter().enumerate() {
        if i > 0 {
            out.extend(sep.encode_utf16());
        }
        print(x, &mut out, true);
    }
    V::Str(Js::from_u16(out))
}

// ---------- objects, JSON, numbers ----------

pub fn entries<'a>(o: &V<'a>) -> V<'a> {
    match as_obj(o) {
        Some(o) => arr_v(o.members().into_iter().map(|(k, v)| arr_v(vec![V::Str(k), v])).collect()),
        None => arr_v(vec![]),
    }
}
pub fn keys<'a>(o: &V<'a>) -> V<'a> {
    match as_obj(o) {
        Some(o) => arr_v(o.members().into_iter().map(|(k, _)| V::Str(k)).collect()),
        None => arr_v(vec![]),
    }
}
/// One `[k, v]` of a fused `Object.fromEntries(... .map(x => [k, v]))`.
pub fn from_entry<'a>(r: &mut O<'a>, k: V<'a>, v: V<'a>) {
    let k = match k {
        V::Str(s) => s,
        V::U => Js::Esc(b"undefined"),
        V::Null => Js::Esc(b"null"),
        k => match scalar(&k) {
            Some(s) => Js::own(s),
            None => return,
        },
    };
    r.set(k, v);
}
pub fn from_entries<'a>(l: &V<'a>) -> V<'a> {
    let mut r = O::default();
    for e in items(l).iter() {
        let k = match at(e, 0) {
            V::Str(s) => s,
            V::U => Js::Esc(b"undefined"),
            V::Null => Js::Esc(b"null"),
            k => match scalar(&k) {
                Some(s) => Js::own(s),
                None => continue,
            },
        };
        r.set(k, at(e, 1));
    }
    obj_v(r)
}
pub fn max<'a>(a: &V<'a>, b: &V<'a>) -> V<'a> {
    match (fnum(a), fnum(b)) {
        (Some(x), Some(y)) => num(if x.is_nan() || y.is_nan() {
            f64::NAN
        } else if x == y {
            if x.is_sign_negative() { y } else { x }
        } else {
            x.max(y)
        }),
        _ => U,
    }
}

/// Owned bytes that must live as long as the input (parsed `json()` documents).
pub struct Cx {
    bufs: RefCell<Vec<Box<[u8]>>>,
}
impl Cx {
    pub fn new() -> Self {
        Cx { bufs: RefCell::new(Vec::new()) }
    }
    pub fn keep<'a>(&'a self, b: Vec<u8>) -> &'a [u8] {
        let bx = b.into_boxed_slice();
        let p: *const [u8] = &*bx;
        self.bufs.borrow_mut().push(bx);
        unsafe { &*p } // boxed contents never move; freed with the Cx
    }
}
impl Default for Cx {
    fn default() -> Self {
        Self::new()
    }
}
/// Core `parseJson`: strict like JSON.parse; undefined if the string isn't JSON. The parsed value
/// is untyped, so it is indexed on read.
pub fn json<'a>(cx: &'a Cx, v: &V<'a>) -> V<'a> {
    let V::Str(js) = v else { return U };
    let bytes: Vec<u8> = match js.ck() {
        Ck::S(t) => t.into_owned().into_bytes(),
        Ck::W(w) => {
            // a lone surrogate in the text: keep it as an escape inside the parsed document
            let mut b = String::new();
            for r in char::decode_utf16(w.iter().copied()) {
                match r {
                    Ok(c) => b.push(c),
                    Err(e) => b.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                }
            }
            b.into_bytes()
        }
    };
    if !valid_json(&bytes) {
        return U;
    }
    let b = cx.keep(bytes);
    parse(b, &LEAF)
}
/// `JSON.stringify(x)`: canonical, whatever the input's formatting.
pub fn stringify<'a>(v: &V<'a>) -> V<'a> {
    if matches!(v, V::U) {
        return U;
    }
    let mut out: Vec<u16> = Vec::new();
    canon(v, &mut out);
    V::Str(Js::from_u16(out))
}
fn canon_str(w: &[u16], out: &mut Vec<u16>) {
    out.push(b'"' as u16);
    let mut i = 0;
    while i < w.len() {
        let u = w[i];
        let pair = (0xd800..0xdc00).contains(&u) && i + 1 < w.len() && (0xdc00..0xe000).contains(&w[i + 1]);
        match u {
            0x22 => out.extend("\\\"".encode_utf16()),
            0x5c => out.extend("\\\\".encode_utf16()),
            0x08 => out.extend("\\b".encode_utf16()),
            0x0c => out.extend("\\f".encode_utf16()),
            0x0a => out.extend("\\n".encode_utf16()),
            0x0d => out.extend("\\r".encode_utf16()),
            0x09 => out.extend("\\t".encode_utf16()),
            u if u < 0x20 => out.extend(format!("\\u{:04x}", u).encode_utf16()),
            u if pair => {
                out.push(u);
                out.push(w[i + 1]);
                i += 1;
            }
            u if (0xd800..0xe000).contains(&u) => out.extend(format!("\\u{:04x}", u).encode_utf16()),
            u => out.push(u),
        }
        i += 1;
    }
    out.push(b'"' as u16);
}
fn canon(v: &V, out: &mut Vec<u16>) {
    match v {
        V::U | V::Null => out.extend("null".encode_utf16()),
        V::T => out.extend("true".encode_utf16()),
        V::F => out.extend("false".encode_utf16()),
        V::Num(..) | V::NumR(_) => out.extend(js_json_num(fnum(v).unwrap()).encode_utf16()),
        V::Str(s) => canon_str(&s.u16(), out),
        _ if is_array(v) => {
            out.push(b'[' as u16);
            for (i, x) in items(v).iter().enumerate() {
                if i > 0 {
                    out.push(b',' as u16);
                }
                canon(x, out);
            }
            out.push(b']' as u16);
        }
        _ => {
            out.push(b'{' as u16);
            let ms = as_obj(v).map(|o| o.members()).unwrap_or_default();
            let mut first = true;
            for (k, x) in ms.iter().filter(|(_, x)| !matches!(x, V::U)) {
                if !first {
                    out.push(b',' as u16);
                }
                first = false;
                canon_str(&k.u16(), out);
                out.push(b':' as u16);
                canon(x, out);
            }
            out.push(b'}' as u16);
        }
    }
}

/// Add-only Extension patch: fills members `o` lacks, recursing into objects both have.
pub fn fill<'a>(o: V<'a>, patch: &V<'a>) -> V<'a> {
    let Some(p) = as_obj(patch) else { return o };
    let mut r: Option<O<'a>> = None;
    for (k, v) in p.members() {
        if matches!(v, V::U) {
            continue;
        }
        let cur = r.as_ref().map_or_else(|| get(&o, &k.lossy()), |x| x.get(&k.lossy()));
        let nv = if matches!(cur, V::U) {
            v
        } else if as_obj(&cur).is_some() && as_obj(&v).is_some() {
            fill(cur, &v)
        } else {
            continue;
        };
        r.get_or_insert_with(|| spread(&o)).set(k, nv);
    }
    match r {
        Some(x) => obj_v(x),
        None => o,
    }
}

// ================================================================ writing

/// Writes a value as JSON. Spans and unchanged indexed objects are copied as they came.
pub fn emit(v: &V, out: &mut Vec<u8>) {
    match v {
        V::U | V::Null => out.extend_from_slice(b"null"),
        V::T => out.extend_from_slice(b"true"),
        V::F => out.extend_from_slice(b"false"),
        V::Num(_, Some(r)) | V::NumR(r) => out.extend_from_slice(r),
        V::Num(f, None) => num_into(*f, out),
        V::Str(s) => emit_str(s, out),
        V::Raw(r) => out.extend_from_slice(r),
        V::Obj(o) => match o.raw {
            Some(r) => out.extend_from_slice(r),
            None => {
                out.push(b'{');
                let mut first = true;
                for (k, x) in o.m.iter().filter(|(_, x)| !matches!(x, V::U)) {
                    if !first {
                        out.push(b',');
                    }
                    first = false;
                    emit_str(k, out);
                    out.push(b':');
                    emit(x, out);
                }
                out.push(b'}');
            }
        },
        V::Arr(a) => {
            out.push(b'[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                emit(x, out);
            }
            out.push(b']');
        }
        V::Split(..) => emit(&arr_v(items(v).to_vec()), out),
    }
}
#[inline]
fn num_into(f: f64, out: &mut Vec<u8>) {
    if f.fract() == 0.0 && f.abs() < 1e15 && !(f == 0.0 && f.is_sign_negative()) {
        let mut b = [0u8; 20];
        let (mut i, neg, mut n) = (20, f < 0.0, f.abs() as u64);
        loop {
            i -= 1;
            b[i] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        if neg {
            out.push(b'-');
        }
        out.extend_from_slice(&b[i..]);
    } else {
        out.extend_from_slice(js_json_num(f).as_bytes())
    }
}
fn emit_str(s: &Js, out: &mut Vec<u8>) {
    out.push(b'"');
    match s {
        Js::Esc(b) | Js::EscX(b) => out.extend_from_slice(b),
        Js::Own(t) => esc_into(t, out),
        Js::U16(w) => {
            for r in char::decode_utf16(w.iter().copied()) {
                match r {
                    Ok(c) => esc_into(c.encode_utf8(&mut [0; 4]), out),
                    Err(e) => out.extend_from_slice(format!("\\u{:04x}", e.unpaired_surrogate()).as_bytes()),
                }
            }
        }
    }
    out.push(b'"');
}
fn esc_into(s: &str, out: &mut Vec<u8>) {
    for &c in s.as_bytes() {
        match c {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            c if c < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c).as_bytes()),
            c => out.push(c),
        }
    }
}

// ---------- guest frames (hostgo/host/shared.go) ----------

pub trait Fr {
    fn u32(&mut self, n: u32);
    fn bytes(&mut self, b: &[u8]);
    fn begin(&mut self) -> usize;
    fn end(&mut self, at: usize);
    fn patch(&mut self, at: usize, n: u32);
}
impl Fr for Vec<u8> {
    #[inline]
    fn u32(&mut self, n: u32) {
        self.extend_from_slice(&n.to_le_bytes());
    }
    #[inline]
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.extend_from_slice(b);
    }
    #[inline]
    fn begin(&mut self) -> usize {
        let at = self.len();
        self.u32(0);
        at
    }
    #[inline]
    fn end(&mut self, at: usize) {
        let n = (self.len() - at - 4) as u32;
        self.patch(at, n);
    }
    #[inline]
    fn patch(&mut self, at: usize, n: u32) {
        self[at..at + 4].copy_from_slice(&n.to_le_bytes());
    }
}
/// An object's members as key/value frames: string content (0), number text (1) or JSON (2).
/// Not an object, or no defined member: an empty slot.
pub fn kv_slot(v: &V, out: &mut Vec<u8>) {
    let Some(o) = as_obj(v) else { return out.u32(0) };
    let ms: Vec<_> = o.members().into_iter().filter(|(_, x)| !matches!(x, V::U)).collect();
    if ms.is_empty() {
        return out.u32(0);
    }
    let at = out.begin();
    out.u32(ms.len() as u32);
    for (k, x) in &ms {
        out.bytes(k.lossy().as_bytes());
        match x {
            V::Str(s) => {
                out.push(0);
                out.bytes(s.lossy().as_bytes());
            }
            V::Num(..) | V::NumR(_) => {
                out.push(1);
                let mut t = Vec::new();
                emit(x, &mut t);
                out.bytes(&t);
            }
            _ => {
                out.push(2);
                let mut t = Vec::new();
                emit(x, &mut t);
                out.bytes(&t);
            }
        }
    }
    out.end(at);
}
/// A JSON annotation slot: undefined, null and empty values are an empty slot.
pub fn json_slot(v: &V, out: &mut Vec<u8>) {
    if nullish(v) || matches!(nonempty(v.clone()), V::U) {
        return out.u32(0);
    }
    let at = out.begin();
    emit(v, out);
    out.end(at);
}
/// A Host string slot: a string's content; undefined is "".
pub fn str_slot(v: &V, out: &mut Vec<u8>) {
    match v {
        V::Str(s) => out.bytes(s.lossy().as_bytes()),
        V::U | V::Null => out.u32(0),
        _ => {
            let mut t = Vec::new();
            emit(v, &mut t);
            out.bytes(&t);
        }
    }
}
/// Bid overrides: top-level members of `out` that differ from the bidder's bid (by span identity:
/// untouched members are the input's own spans), and null for members `out` dropped.
pub fn overrides<'a>(orig: &V<'a>, out: &V<'a>, buf: &mut Vec<u8>) {
    if matches!(out, V::U) || eq(orig, out) || matches!(out, V::Obj(o) if o.raw.is_some()) {
        return buf.u32(0);
    }
    let (Some(a), Some(b)) = (as_obj(orig), as_obj(out)) else { return buf.u32(0) };
    let same = |x: &V, y: &V| match (x, y) {
        (V::Raw(p), V::Raw(q)) => std::ptr::eq(p.as_ptr(), q.as_ptr()),
        (V::Num(_, Some(p)) | V::NumR(p), V::Num(_, Some(q)) | V::NumR(q)) => std::ptr::eq(p.as_ptr(), q.as_ptr()),
        (V::Str(Js::Esc(p) | Js::EscX(p)), V::Str(Js::Esc(q) | Js::EscX(q))) => std::ptr::eq(p.as_ptr(), q.as_ptr()) && p.len() == q.len(),
        (V::Obj(p), V::Obj(q)) => Rc::ptr_eq(p, q) || (p.raw.is_some() && p.raw.map(|r| r.as_ptr()) == q.raw.map(|r| r.as_ptr())),
        _ => eq(x, y),
    };
    let mut ov = O::default();
    for (k, v) in &b.m {
        if matches!(v, V::U) {
            continue;
        }
        if !a.m.iter().any(|(x, y)| key_eq(x, k) && same(y, v)) {
            ov.set(k.clone(), v.clone());
        }
    }
    for (k, _) in &a.m {
        if !b.m.iter().any(|(x, y)| key_eq(x, k) && !matches!(y, V::U)) {
            ov.set(k.clone(), V::Null);
        }
    }
    if ov.m.is_empty() {
        return buf.u32(0);
    }
    let at = buf.begin();
    emit(&obj_v(ov), buf);
    buf.end(at);
}
/// The guest boundary: input must be UTF-8; invalid bytes become U+FFFD as browsers do (#23).
pub fn utf8_input(b: &[u8]) -> Cow<'_, [u8]> {
    match std::str::from_utf8(b) {
        Ok(_) => Cow::Borrowed(b),
        Err(_) => Cow::Owned(String::from_utf8_lossy(b).into_owned().into_bytes()),
    }
}

/// A module-level lookup table of string literals, indexed by `String(k)`.
pub fn table<'a>(k: &V<'a>, t: &[(&str, &'static [u8])]) -> V<'a> {
    let key = match k {
        V::Str(_) | V::Num(..) | V::NumR(_) => scalar(k),
        _ => None,
    };
    match key.and_then(|s| t.iter().find(|(x, _)| *x == s)) {
        Some((_, v)) => V::Str(if v.contains(&b'\\') { Js::EscX(v) } else { Js::Esc(v) }),
        None => U,
    }
}
/// What the Host gets for a string it stores natively (ids, errors): content, or "" for undefined.
pub fn to_string(v: &V) -> String {
    match v {
        V::Str(s) => s.lossy(),
        V::U | V::Null => String::new(),
        _ => {
            let mut t = Vec::new();
            emit(v, &mut t);
            String::from_utf8(t).unwrap_or_default()
        }
    }
}
/// Research hook: the scan floor (one pass over the input, nothing else).
pub fn scan(b: &[u8]) -> usize {
    P::new(b).raw().len()
}

// ================================================================ Level 1: views, member arena, plans
//
// Generated code decodes each shape node into a struct (one field per path read) with a `match` on
// key bytes. Objects a Phase copies (spreads) also record their members, as spans, in one arena per
// call: members of one object are a linked list, and a member's own members hang off `kids`. A
// `Plan` is "copy this object, with these slots overridden": emitted straight into the output.

pub const NONE: u32 = u32::MAX;
#[derive(Clone, Copy)]
pub struct Mem<'a> {
    pub k: &'a [u8],
    pub kx: bool,
    pub v: &'a [u8],
    pub kids: u32,
    pub kdup: bool,
    /// the value was itself recorded as a copy source (`kids` may be NONE: an empty object)
    pub kc: bool,
    pub next: u32,
}
pub type Ar<'a> = Vec<Mem<'a>>;

impl Default for V<'_> {
    fn default() -> Self {
        U
    }
}

impl<'a> P<'a> {
    #[inline]
    pub fn start(&mut self) -> usize {
        self.ws();
        self.i
    }
    #[inline]
    pub fn since(&self, s: usize) -> &'a [u8] {
        &self.b[s..self.i]
    }
    #[inline]
    pub fn is_obj(&mut self) -> bool {
        self.peek() == b'{'
    }
    #[inline]
    pub fn is_arr(&mut self) -> bool {
        self.peek() == b'['
    }
    #[inline]
    pub fn skip_val(&mut self) {
        self.skip()
    }
    /// The next value as a leaf: strings and numbers as spans, containers as raw spans.
    #[inline]
    pub fn leaf(&mut self) -> V<'a> {
        val(self, &LEAF)
    }
    /// An array of leaves (one vector); anything else as a leaf.
    pub fn leaf_arr(&mut self) -> V<'a> {
        val(self, &Shape::Arr(&LEAF))
    }
    /// Walks an object: `f(cursor, key bytes, key has escapes)` consumes each member's value.
    #[inline]
    pub fn obj_each(&mut self, mut f: impl FnMut(&mut Self, &'a [u8], bool)) {
        self.i += 1;
        loop {
            match self.peek() {
                b'}' => {
                    self.i += 1;
                    return;
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                0 => return,
                _ => {}
            }
            let s = self.i + 1;
            let (e, x) = self.str_end_x(s);
            self.i = e + 1;
            self.ws();
            self.i += 1;
            self.ws();
            let k = &self.b[s..e];
            let before = self.i;
            f(self, k, x);
            if self.i == before {
                self.skip();
            }
        }
    }
    #[inline]
    pub fn arr_each(&mut self, mut f: impl FnMut(&mut Self)) {
        self.i += 1;
        loop {
            match self.peek() {
                b']' => {
                    self.i += 1;
                    return;
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                0 => return,
                _ => {}
            }
            let before = self.i;
            f(self);
            if self.i == before {
                self.skip();
            }
        }
    }
}
/// A key as the bytes a `match` on literal keys sees (escapes resolved; rare).
#[inline]
pub fn key(k: &[u8], kx: bool) -> Cow<'_, [u8]> {
    if !kx {
        return Cow::Borrowed(k);
    }
    match unescape(k) {
        Ck::S(s) => Cow::Owned(s.into_owned().into_bytes()),
        Ck::W(_) => Cow::Owned(Vec::new()),
    }
}
#[inline]
fn mem_key_is(m: &Mem, lit: &str) -> bool {
    if m.kx { matches!(unescape(m.k), Ck::S(s) if s == lit) } else { bytes_eq(m.k, lit.as_bytes()) }
}
#[inline]
fn kbit(k: &[u8]) -> u64 {
    1u64 << ((k.len() as u64 * 31 + *k.first().unwrap_or(&0) as u64 * 7 + *k.last().unwrap_or(&0) as u64) % 64)
}
/// Records one member of a copied object. `seen`/`dup` detect duplicate keys cheaply.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn link<'a>(ar: &mut Ar<'a>, first: &mut u32, last: &mut u32, seen: &mut u64, dup: &mut bool, k: &'a [u8], kx: bool, v: &'a [u8], (kids, kdup, kc): (u32, bool, bool)) {
    let bit = kbit(k);
    if *seen & bit != 0 && !*dup {
        let mut c = *first;
        while c != NONE {
            if ar[c as usize].k == k {
                *dup = true;
                break;
            }
            c = ar[c as usize].next;
        }
    }
    *seen |= bit;
    let idx = ar.len() as u32;
    ar.push(Mem { k, kx, v, kids, kdup, kc, next: NONE });
    if *last != NONE {
        ar[*last as usize].next = idx;
    } else {
        *first = idx;
    }
    *last = idx;
}
fn mem_val<'a>(m: &Mem<'a>) -> V<'a> {
    P::new(m.v).leaf()
}
fn mems<'x, 'a>(ar: &'x Ar<'a>, first: u32) -> impl Iterator<Item = &'x Mem<'a>> {
    let mut c = first;
    std::iter::from_fn(move || {
        if c == NONE {
            return None;
        }
        let m = &ar[c as usize];
        c = m.next;
        Some(m)
    })
}
fn mem_key(m: &Mem<'_>) -> Js<'static> {
    // owned: keys from the arena outlive nothing they don't need to
    match if m.kx { unescape(m.k) } else { Ck::S(Cow::Borrowed(unsafe { std::str::from_utf8_unchecked(m.k) })) } {
        Ck::S(s) => Js::own(s.into_owned()),
        Ck::W(w) => Js::U16(w),
    }
}
/// The recorded members of a copied object as a Level 0 object (JS order on demand).
fn mem_obj<'a>(ar: &Ar<'a>, first: u32, raw: &V<'a>) -> O<'a> {
    if first == NONE {
        return as_obj(raw).map(|o| o.into_owned()).unwrap_or_default();
    }
    let mut o = O::default();
    for m in mems(ar, first) {
        let k = if m.kx { mem_key(m) } else { Js::Esc(m.k) };
        o.m.push((k, mem_val(m)));
    }
    o.dup = true; // let members() dedupe if needed
    o
}
pub fn entries_mem<'a>(ar: &Ar<'a>, first: u32, raw: &V<'a>) -> V<'a> {
    if as_obj(raw).is_none() {
        return arr_v(vec![]);
    }
    entries(&obj_v(mem_obj(ar, first, raw)))
}
pub fn keys_mem<'a>(ar: &Ar<'a>, first: u32, raw: &V<'a>) -> V<'a> {
    if as_obj(raw).is_none() {
        return arr_v(vec![]);
    }
    keys(&obj_v(mem_obj(ar, first, raw)))
}

/// What a Phase produces for output: a value, a plan, a plan that disappears when empty, or a list.
#[derive(Clone)]
pub enum Out<'a> {
    V(V<'a>),
    P(Box<Plan<'a>>),
    NonEmpty(Box<Plan<'a>>),
    List(Rc<Vec<Out<'a>>>),
    /// the accepted imps, with their index in the input's imp array (for edits)
    IdxList(Rc<Vec<Out<'a>>>, Rc<Vec<u32>>),
    /// an Extension's add-only patch over Phase output (applied by the Host when it applies edits)
    Fill(Box<Out<'a>>, V<'a>),
}
#[derive(Clone, Default)]
pub enum Src<'a> {
    #[default]
    None,
    /// an object in the input, with its members in the arena (or `NONE`: read them from `raw`)
    Mem { raw: Raw<'a>, first: u32, dup: bool },
    /// a computed object
    Val(V<'a>),
}
/// `{ ...src, k: v, ... }`: the source's members, with `ov` overriding (undefined deletes).
#[derive(Clone, Default)]
pub struct Plan<'a> {
    pub src: Src<'a>,
    pub ov: Vec<(Cow<'a, str>, Out<'a>)>,
}
impl<'a> Plan<'a> {
    /// A plan over an input view (`v` its value, `first` its recorded members).
    pub fn of(v: &V<'a>, first: u32, dup: bool) -> Plan<'a> {
        let src = match v {
            V::Raw(r) if r.first() == Some(&b'{') => Src::Mem { raw: r, first, dup },
            V::Obj(_) => Src::Val(v.clone()),
            _ => Src::None,
        };
        Plan { src, ov: Vec::with_capacity(4) }
    }
    pub fn from_out(o: Out<'a>, ar: &Ar<'a>) -> Plan<'a> {
        match o {
            Out::P(p) | Out::NonEmpty(p) => *p,
            o => {
                let v = o.to_v(ar);
                if as_obj(&v).is_some() { Plan { src: Src::Val(v), ov: Vec::with_capacity(4) } } else { Plan::default() }
            }
        }
    }
    pub fn set(&mut self, k: impl Into<Cow<'a, str>>, v: Out<'a>) {
        let k = k.into();
        match self.ov.iter_mut().find(|(x, _)| *x == k) {
            Some(e) => e.1 = v,
            None => self.ov.push((k, v)),
        }
    }
    pub fn with(mut self, k: &'a str, v: Out<'a>) -> Self {
        self.set(k, v);
        self
    }
    pub fn del(mut self, ks: &[&'a str]) -> Self {
        for k in ks {
            self.set(*k, Out::V(U));
        }
        self
    }
    fn src_mem<'x>(&self, ar: &'x Ar<'a>, k: &str) -> Option<&'x Mem<'a>> {
        match &self.src {
            Src::Mem { first, .. } if *first != NONE => mems(ar, *first).filter(|m| mem_key_is(m, k)).last(),
            _ => None,
        }
    }
    /// `plan.k`
    pub fn get(&self, ar: &Ar<'a>, k: &str) -> V<'a> {
        if let Some((_, o)) = self.ov.iter().find(|(x, _)| x == k) {
            return o.to_v(ar);
        }
        match &self.src {
            Src::Mem { raw, first, .. } => match self.src_mem(ar, k) {
                Some(m) => mem_val(m),
                None if *first == NONE => get(&V::Raw(raw), k),
                None => U,
            },
            Src::Val(v) => get(v, k),
            Src::None => U,
        }
    }
    /// `plan.k` as something to spread or emit: a slot, or the source member (as a plan when its
    /// own members were recorded).
    pub fn member_out(&self, ar: &Ar<'a>, k: &str) -> Out<'a> {
        if let Some((_, o)) = self.ov.iter().find(|(x, _)| x == k) {
            return o.clone();
        }
        if let Some(m) = self.src_mem(ar, k) {
            if m.kc {
                return Out::P(Box::new(Plan { src: Src::Mem { raw: m.v, first: m.kids, dup: m.kdup }, ov: Vec::new() }));
            }
            return Out::V(mem_val(m));
        }
        Out::V(self.get(ar, k))
    }
    pub fn to_v(&self, ar: &Ar<'a>) -> V<'a> {
        let mut o = match &self.src {
            Src::Mem { raw, first, .. } => spread(&obj_v(mem_obj(ar, *first, &V::Raw(raw)))),
            Src::Val(v) => spread(v),
            Src::None => O::default(),
        };
        for (k, x) in &self.ov {
            let key = match k {
                Cow::Borrowed(t) if !t.bytes().any(|b| b == b'"' || b == b'\\' || b < 0x20) => Js::Esc(t.as_bytes()),
                k => Js::own(k.to_string()),
            };
            o.set(key, x.to_v(ar));
        }
        obj_v(o)
    }
}
impl<'a> Out<'a> {
    /// `nonempty(x)` on Phase output: a plan becomes undefined when it emits no member.
    pub fn nonempty(self) -> Out<'a> {
        match self {
            Out::P(p) => Out::NonEmpty(p),
            Out::V(v) => Out::V(nonempty(v)),
            o => o,
        }
    }
    pub fn to_v(&self, ar: &Ar<'a>) -> V<'a> {
        match self {
            Out::V(v) => v.clone(),
            Out::P(p) => p.to_v(ar),
            Out::NonEmpty(p) => nonempty(p.to_v(ar)),
            Out::List(l) | Out::IdxList(l, _) => arr_v(l.iter().map(|x| x.to_v(ar)).collect()),
            Out::Fill(o, p) => fill(o.to_v(ar), p),
        }
    }
    pub fn get(&self, ar: &Ar<'a>, k: &str) -> V<'a> {
        match self {
            Out::P(p) | Out::NonEmpty(p) => p.get(ar, k),
            o => get(&o.to_v(ar), k),
        }
    }
}
/// A member `key: out` (key already escaped). Undefined writes nothing; an empty NonEmpty plan is
/// rolled back.
fn emit_member(key: &[u8], raw_key: bool, o: &Out, ar: &Ar, out: &mut Vec<u8>, first: &mut bool) {
    if matches!(o, Out::V(V::U)) {
        return;
    }
    let mark = out.len();
    if !*first {
        out.push(b',');
    }
    out.push(b'"');
    if raw_key {
        out.extend_from_slice(key);
    } else {
        esc_into(unsafe { std::str::from_utf8_unchecked(key) }, out);
    }
    out.extend_from_slice(b"\":");
    let body = out.len();
    emit_out(o, ar, out);
    if matches!(o, Out::NonEmpty(_)) && out.len() == body + 2 {
        out.truncate(mark); // {} : nonempty() made it undefined
        return;
    }
    if matches!(o, Out::NonEmpty(_)) && &out[body..] == b"null" {
        out.truncate(mark);
        return;
    }
    *first = false;
}
pub fn emit_out(o: &Out, ar: &Ar, out: &mut Vec<u8>) {
    match o {
        Out::V(v) => emit(v, out),
        Out::P(p) | Out::NonEmpty(p) => emit_plan(p, ar, out),
        Out::List(l) | Out::IdxList(l, _) => {
            out.push(b'[');
            for (i, x) in l.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                emit_out(x, ar, out);
            }
            out.push(b']');
        }
        Out::Fill(..) => emit(&o.to_v(ar), out),
    }
}

// ---------- edits (ABI #24): Phase output as edits to the Host's own copy of the input ----------
//   ["v", value]  replace          ["d"]  delete
//   ["p", {k: edit}, nonempty]     patch the input object at this position (nonempty: drop it if empty)
//   ["l", [[i, edit], ...]]        the input array's elements i, edited, in this order
//   ["f", value]                   add-only fill (an Extension patch)   ["s", [e1, e2]]  e1 then e2
/// Writes `o` as an edit of the input value at its position. `at` is that input value's span (so a
/// plan can be checked to be over the same input object; projected inputs hold only what is read).
pub fn emit_edit(o: &Out, ar: &Ar, at: Option<Raw>, out: &mut Vec<u8>) {
    match o {
        Out::V(V::U) => out.extend_from_slice(b"[\"d\"]"),
        Out::V(v) => {
            out.extend_from_slice(b"[\"v\",");
            emit(v, out);
            out.push(b']');
        }
        Out::P(p) | Out::NonEmpty(p) => match &p.src {
            Src::Mem { raw, first, .. } => {
                // a plan over a different input object can't be an edit here: the guest only holds
                // the projected part of it (the prototype's adapters never do this)
                if let Some(a) = at {
                    assert!(std::ptr::eq(a.as_ptr(), raw.as_ptr()), "plan source moved: not expressible as an edit");
                }
                out.extend_from_slice(b"[\"p\",{");
                for (i, (k, x)) in p.ov.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.push(b'"');
                    esc_into(k, out);
                    out.extend_from_slice(b"\":");
                    let child = if *first != NONE {
                        mems(ar, *first).filter(|m| mem_key_is(m, k)).last().map(|m| m.v)
                    } else {
                        None
                    };
                    emit_edit(x, ar, child, out);
                }
                out.extend_from_slice(if matches!(o, Out::NonEmpty(_)) { b"},1]" } else { b"},0]" });
            }
            _ => {
                let v = o.to_v(ar);
                emit_edit(&Out::V(v), ar, None, out)
            }
        },
        Out::IdxList(l, ix) => {
            out.extend_from_slice(b"[\"l\",[");
            for (i, (x, j)) in l.iter().zip(ix.iter()).enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.push(b'[');
                out.extend_from_slice(j.to_string().as_bytes());
                out.push(b',');
                emit_edit(x, ar, None, out);
                out.push(b']');
            }
            out.extend_from_slice(b"]]");
        }
        Out::List(_) => emit_edit(&Out::V(o.to_v(ar)), ar, None, out),
        Out::Fill(x, p) => {
            out.extend_from_slice(b"[\"s\",[");
            emit_edit(x, ar, at, out);
            out.extend_from_slice(b",[\"f\",");
            emit(p, out);
            out.extend_from_slice(b"]]]");
        }
    }
}
fn emit_plan(p: &Plan, ar: &Ar, out: &mut Vec<u8>) {
    let (raw, first) = match &p.src {
        Src::Mem { dup: true, .. } | Src::Val(_) => return emit(&p.to_v(ar), out),
        Src::Mem { raw, first, .. } if *first == NONE => {
            // members weren't recorded (not a copy source in the shape): fall back
            let _ = raw;
            return emit(&p.to_v(ar), out);
        }
        Src::Mem { raw, first, .. } => (Some(*raw), *first),
        Src::None => (None, NONE),
    };
    let _ = raw;
    out.push(b'{');
    let mut done = 0u64; // which slots were emitted in place (up to 64)
    let mut firstm = true;
    for m in mems(ar, first) {
        match p.ov.iter().position(|(k, _)| mem_key_is(m, k)) {
            Some(i) => {
                if done & (1 << i) == 0 {
                    done |= 1 << i;
                    emit_member(m.k, true, &p.ov[i].1, ar, out, &mut firstm);
                }
            }
            None => {
                if !firstm {
                    out.push(b',');
                }
                firstm = false;
                out.push(b'"');
                out.extend_from_slice(m.k);
                out.extend_from_slice(b"\":");
                out.extend_from_slice(m.v);
            }
        }
    }
    for (i, (k, o)) in p.ov.iter().enumerate() {
        if done & (1 << i) == 0 {
            emit_member(k.as_bytes(), false, o, ar, out, &mut firstm);
        }
    }
    out.push(b'}');
}
/// Add-only Extension patch on Phase output.
pub fn fill_out<'a>(o: Out<'a>, patch: &V<'a>, ar: &Ar<'a>) -> Out<'a> {
    let Out::P(mut p) = o else { return Out::V(fill(o.to_v(ar), patch)) };
    let Some(po) = as_obj(patch) else { return Out::P(p) };
    for (k, pv) in po.members() {
        if matches!(pv, V::U) {
            continue;
        }
        let ks = k.lossy();
        let cur = p.get(ar, &ks);
        if matches!(cur, V::U) {
            p.set(ks, Out::V(pv));
        } else if as_obj(&cur).is_some() && as_obj(&pv).is_some() {
            p.set(ks, Out::V(fill(cur, &pv)));
        }
    }
    Out::P(p)
}
/// Bid overrides straight from the bid Phase's plan over the bidder's bid: its slots.
pub fn plan_overrides<'a>(bid: &V<'a>, o: &Out<'a>, ar: &Ar<'a>, buf: &mut Vec<u8>) {
    let p = match o {
        Out::P(p) if matches!((&p.src, bid), (Src::Mem { raw, .. }, V::Raw(b)) if std::ptr::eq(raw.as_ptr(), b.as_ptr())) => p,
        o => return overrides(bid, &o.to_v(ar), buf),
    };
    if p.ov.is_empty() {
        return buf.u32(0);
    }
    let at = buf.begin();
    buf.push(b'{');
    let mut first = true;
    for (k, o) in &p.ov {
        let o = if matches!(o, Out::V(V::U)) {
            if p.src_mem(ar, k).is_none() {
                continue;
            }
            Out::V(V::Null)
        } else {
            o.clone()
        };
        emit_member(k.as_bytes(), false, &o, ar, buf, &mut first);
    }
    buf.push(b'}');
    if first {
        buf.truncate(at);
        return buf.u32(0);
    }
    buf.end(at);
}
