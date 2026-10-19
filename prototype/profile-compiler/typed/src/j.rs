//! What typed generated code calls: a borrowing JSON reader, a streaming JSON writer, and the
//! JavaScript semantics the profile-compiler runtime pinned (README "Semantics that had to be
//! pinned"), restated over `&str` and raw spans instead of arena nodes.
//!
//! A `Raw` is the exact text of one JSON value in the input. Generated decoders read only the fields
//! a rule reads; everything else stays a `Raw` and is written back with one copy. Strings stay in
//! their escaped form (`JStr`) until an expression needs their content.
use std::borrow::Cow;

pub type Raw<'a> = &'a [u8];
/// The escaped content of a JSON string, without its quotes.
#[derive(Clone, Copy)]
pub struct JStr<'a>(pub &'a [u8]);
/// A string expression's value: borrowed from the input whenever no operation had to build it.
pub type S<'a> = Cow<'a, str>;

/// `abl_owned` reverts views to owned Strings: every string expression allocates, as `new_str` did.
#[inline]
pub fn view(s: &str) -> S<'_> {
    if cfg!(feature = "abl_owned") { Cow::Owned(s.to_owned()) } else { Cow::Borrowed(s) }
}
#[inline]
pub fn view_cow(s: S<'_>) -> S<'_> {
    if cfg!(feature = "abl_owned") { Cow::Owned(s.into_owned()) } else { s }
}

impl<'a> JStr<'a> {
    #[inline]
    pub fn cow(self) -> S<'a> {
        view_cow(prebid_core_rt::unescape(self.0))
    }
    #[inline]
    pub fn is_empty(self) -> bool {
        self.0.is_empty()
    }
}

// ---------- reading ----------

/// A cursor over one JSON text. Lenient like the profile-compiler runtime: it trusts its input (the
/// Host's own serializer, or a body the Host already parsed); `valid_json` is the strict path.
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
    pub fn peek(&mut self) -> u8 {
        self.ws();
        *self.b.get(self.i).unwrap_or(&0)
    }
    /// Index of the closing quote of a string whose content starts at `i`. Iterator scans, not
    /// indexed loops: under wazero the bounds checks of `b[i]` cost more than the scan itself.
    #[inline]
    fn str_end(&self, mut i: usize) -> usize {
        let b = self.b;
        loop {
            let t = match b.get(i..) {
                Some(t) => t,
                None => return b.len(),
            };
            match t.iter().position(|&c| c == b'"' || c == b'\\') {
                None => return b.len(),
                Some(o) if b[i + o] == b'"' => return i + o,
                Some(o) => i += o + 2,
            }
        }
    }
    fn skip(&mut self) {
        let b = self.b;
        match self.peek() {
            b'"' => self.i = self.str_end(self.i + 1) + 1,
            c @ (b'{' | b'[') => {
                // Only this container's own bracket pair and quotes matter for finding its end.
                let close = if c == b'{' { b'}' } else { b']' };
                let mut depth = 0u32;
                let mut i = self.i;
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
    /// Skips the next value (a member no rule reads).
    #[inline]
    pub fn ignore(&mut self) {
        self.skip()
    }
    /// The next value's exact text.
    #[inline]
    pub fn raw(&mut self) -> Raw<'a> {
        self.ws();
        let s = self.i;
        self.skip();
        &self.b[s..self.i]
    }
    /// Walks an object: `f(cursor, escaped key)` must consume the member's value. Returns false
    /// (having skipped the value) when it isn't an object.
    #[inline]
    pub fn obj(&mut self, mut f: impl FnMut(&mut Self, &'a [u8])) -> bool {
        if self.peek() != b'{' {
            self.skip();
            return false;
        }
        let b = self.b;
        self.i += 1;
        loop {
            match self.peek() {
                b'}' => {
                    self.i += 1;
                    return true;
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                0 => return true,
                _ => {}
            }
            let s = self.i + 1;
            let e = self.str_end(s);
            self.i = e + 1;
            self.ws();
            self.i += 1; // ':'
            self.ws();
            let before = self.i;
            f(self, &b[s..e]);
            if self.i == before {
                self.skip();
            }
        }
    }
    /// Walks an array: `f(cursor)` must consume the element.
    #[inline]
    pub fn arr(&mut self, mut f: impl FnMut(&mut Self)) -> bool {
        if self.peek() != b'[' {
            self.skip();
            return false;
        }
        self.i += 1;
        loop {
            match self.peek() {
                b']' => {
                    self.i += 1;
                    return true;
                }
                b',' => {
                    self.i += 1;
                    continue;
                }
                0 => return true,
                _ => {}
            }
            let before = self.i;
            f(self);
            if self.i == before {
                self.skip();
            }
        }
    }
    #[inline]
    pub fn str(&mut self) -> Option<JStr<'a>> {
        if self.peek() == b'"' {
            let s = self.i + 1;
            let e = self.str_end(s);
            self.i = e + 1;
            Some(JStr(&self.b[s..e]))
        } else {
            self.skip();
            None
        }
    }
}

/// Decodes the next value with `f`, in place. `abl_rescan` instead takes its span first and
/// decodes that with a fresh cursor, a second scan, as decoding from held spans does.
#[inline]
pub fn with<'a, R>(p: &mut P<'a>, f: impl FnOnce(&mut P<'a>) -> R) -> R {
    if cfg!(feature = "abl_rescan") {
        let r = p.raw();
        f(&mut P::new(r))
    } else {
        f(p)
    }
}

/// Key compare against a literal: keys are compared escaped; only a key that contains an escape
/// is unescaped first.
#[inline]
pub fn key_is(k: &[u8], lit: &str) -> bool {
    k == lit.as_bytes() || (k.len() > lit.len() && k.contains(&b'\\') && prebid_core_rt::unescape(k) == lit)
}
/// Escaped key → the bytes a `match` on literal keys sees.
#[inline]
pub fn key(k: &[u8]) -> Cow<'_, [u8]> {
    if k.contains(&b'\\') {
        Cow::Owned(prebid_core_rt::unescape(k).into_owned().into_bytes())
    } else {
        Cow::Borrowed(k)
    }
}

// ---------- JS semantics over raw values ----------

#[inline]
pub fn is_null(r: Raw) -> bool {
    r == b"null"
}
/// `x != null` for an optional raw value.
#[inline]
pub fn present(r: Option<Raw>) -> bool {
    matches!(r, Some(r) if !is_null(r))
}
#[inline]
pub fn truthy(r: Option<Raw>) -> bool {
    match r {
        None => false,
        Some(r) => match r.first() {
            None => false,
            Some(b'"') => r.len() > 2,
            Some(b't') | Some(b'{') | Some(b'[') => true,
            Some(b'f') | Some(b'n') => false,
            _ => num(r).map_or(false, |f| f != 0.0 && !f.is_nan()),
        },
    }
}
#[inline]
pub fn num(r: Raw) -> Option<f64> {
    match r.first() {
        Some(b'-' | b'0'..=b'9') => std::str::from_utf8(r).ok()?.parse().ok(),
        _ => None,
    }
}
#[inline]
pub fn jstr(r: Raw) -> Option<JStr> {
    if r.len() >= 2 && r[0] == b'"' { Some(JStr(&r[1..r.len() - 1])) } else { None }
}
/// JS `String(x)` of a scalar (templates, `join`, `str`).
pub fn scalar(r: Raw) -> Option<S> {
    match r.first()? {
        b'"' => jstr(r).map(|s| s.cow()),
        b't' => Some(view("true")),
        b'f' => Some(view("false")),
        b'n' | b'{' | b'[' => None,
        _ => num(r).map(|f| Cow::Owned(js_num(f))),
    }
}
/// `type(x)`.
pub fn type_of(r: Raw) -> &'static str {
    match r.first() {
        Some(b'"') => "string",
        Some(b'{') => "object",
        Some(b'[') => "array",
        Some(b't' | b'f') => "bool",
        Some(b'n') => "null",
        _ => "number",
    }
}
/// Object member, last one wins (JSON.parse).
pub fn get<'a>(o: Option<Raw<'a>>, k: &str) -> Option<Raw<'a>> {
    let mut hit = None;
    P::new(o?).obj(|p, kk| {
        let v = p.raw();
        if key_is(kk, k) {
            hit = Some(v);
        }
    });
    hit
}
pub fn nth(a: Option<Raw>, i: usize) -> Option<Raw> {
    let mut n = 0;
    let mut hit = None;
    P::new(a?).arr(|p| {
        let v = p.raw();
        if n == i {
            hit = Some(v);
        }
        n += 1;
    });
    hit
}
/// `len(x)`: array length, or an object's (deduplicated) member count.
pub fn len(r: Option<Raw>) -> Option<usize> {
    let r = r?;
    match r.first()? {
        b'[' => {
            let mut n = 0;
            P::new(r).arr(|p| {
                p.raw();
                n += 1;
            });
            Some(n)
        }
        b'{' => Some(members(r).len()),
        _ => None,
    }
}
/// Object members as JS sees them: deduplicated (first position, last value), integer-like keys
/// first in ascending order.
pub fn members(r: Raw) -> Vec<(S, Raw)> {
    let mut out: Vec<(S, Raw)> = Vec::new();
    P::new(r).obj(|p, k| {
        let v = p.raw();
        let k = JStr(k).cow();
        match out.iter_mut().find(|(x, _)| *x == k) {
            Some(e) => e.1 = v,
            None => out.push((k, v)),
        }
    });
    if out.iter().any(|(k, _)| index_key(k).is_some()) {
        out.sort_by_key(|(k, _)| index_key(k).map_or((1, 0), |n| (0, n)));
    }
    out
}
/// `keys(o)[0]` without building the list.
pub fn first_key(r: Option<Raw>) -> Option<S> {
    let mut best: Option<(u64, S)> = None;
    let mut first: Option<S> = None;
    P::new(r?).obj(|p, k| {
        p.raw();
        let k = JStr(k).cow();
        match index_key(&k) {
            Some(n) if best.as_ref().map_or(true, |(b, _)| n < *b) => best = Some((n, k)),
            Some(_) => {}
            None if first.is_none() => first = Some(k),
            None => {}
        }
    });
    best.map(|(_, k)| k).or(first)
}
fn index_key(k: &str) -> Option<u64> {
    if k == "0" || (!k.is_empty() && !k.starts_with('0') && k.len() <= 10 && k.bytes().all(|b| b.is_ascii_digit())) {
        k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64)
    } else {
        None
    }
}

// ---------- JS semantics over strings ----------

/// JS String.prototype.trim's whitespace (includes U+FEFF, not U+0085).
fn js_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
/// `trim`: a view into its argument unless `abl_owned`.
#[inline]
pub fn trim<'a>(s: &S<'a>) -> S<'a> {
    match s {
        Cow::Borrowed(b) => view(b.trim_matches(js_ws)),
        Cow::Owned(o) => Cow::Owned(o.trim_matches(js_ws).to_owned()),
    }
}
#[inline]
pub fn trim_str(s: &str) -> &str {
    s.trim_matches(js_ws)
}
/// `lower`: borrowed when already lower-case ASCII.
#[inline]
pub fn lower<'a>(s: &S<'a>) -> S<'a> {
    if !cfg!(feature = "abl_owned") && s.bytes().all(|b| b.is_ascii() && !b.is_ascii_uppercase()) {
        s.clone()
    } else {
        Cow::Owned(s.to_lowercase())
    }
}
/// `int(s)`: /^[+-]?\d+$/ → number.
pub fn int_str(s: &str) -> Option<f64> {
    let d = s.strip_prefix(['+', '-']).unwrap_or(s);
    if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) { s.parse().ok() } else { None }
}
/// `num(s)`: /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/ → number.
pub fn num_str(s: &str) -> Option<f64> {
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
    if mant_ok && exp_ok { Some(s.parse().unwrap_or(f64::NAN)) } else { None }
}
/// JS Math.max on two numbers (NaN wins, +0 beats -0).
pub fn js_max(x: f64, y: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        f64::NAN
    } else if x == y {
        if x.is_sign_negative() { y } else { x }
    } else {
        x.max(y)
    }
}
pub use prebid_core_rt::js_num;

// ---------- writing ----------

/// A JSON writer that appends to one buffer. Commas are implied by the previous byte, so generated
/// code writes members in any order without tracking "first".
pub struct W<'o> {
    pub b: &'o mut Vec<u8>,
}

/// Output key as pre-quoted bytes, `"name":`, baked into the binary (interned). `abl_nointern`
/// builds it at run time on every write instead.
#[macro_export]
macro_rules! key {
    ($w:expr, $k:literal) => {
        if cfg!(feature = "abl_nointern") { $w.key_rt($k) } else { $w.key(concat!("\"", $k, "\":").as_bytes()) }
    };
}
/// A string literal used in an expression; `abl_nointern` allocates it per use, as `d.lit` did.
#[macro_export]
macro_rules! lit {
    ($s:literal) => {
        $crate::j::lit_rt($s)
    };
}
#[inline]
pub fn lit_rt(s: &'static str) -> S<'static> {
    if cfg!(feature = "abl_nointern") { Cow::Owned(s.to_owned()) } else { Cow::Borrowed(s) }
}

impl<'o> W<'o> {
    #[inline]
    fn sep(&mut self) {
        if !matches!(self.b.last(), Some(b'{' | b'[' | b':')) {
            self.b.push(b',');
        }
    }
    #[inline]
    pub fn key(&mut self, quoted: &[u8]) {
        self.sep();
        self.b.extend_from_slice(quoted);
    }
    pub fn key_rt(&mut self, k: &str) {
        let mut q = String::with_capacity(k.len() + 3);
        q.push('"');
        let mut e = Vec::new();
        escape_into(k, &mut e);
        q.push_str(std::str::from_utf8(&e).unwrap());
        q.push_str("\":");
        self.key(q.as_bytes());
    }
    /// A key from runtime data (already escaped, as read from the input).
    #[inline]
    pub fn key_esc(&mut self, k: &[u8]) {
        self.sep();
        self.b.push(b'"');
        self.b.extend_from_slice(k);
        self.b.extend_from_slice(b"\":");
    }
    #[inline]
    pub fn key_str(&mut self, k: &str) {
        self.sep();
        self.str_(k);
    }
    /// A pass-through member: escaped key and raw value, copied.
    #[inline]
    pub fn member(&mut self, k: &[u8], v: Raw) {
        self.key_esc(k);
        self.raw(v);
    }
    #[inline]
    pub fn elem(&mut self) {
        self.sep();
    }
    #[inline]
    pub fn raw(&mut self, v: Raw) {
        if cfg!(feature = "abl_passthru") {
            reserialize(v, self.b);
        } else {
            self.b.extend_from_slice(v);
        }
    }
    #[inline]
    pub fn open(&mut self, c: u8) -> usize {
        self.b.push(c);
        self.b.len()
    }
    #[inline]
    pub fn close(&mut self, c: u8) {
        self.b.push(c);
    }
    /// Closes an object opened at `body` (the index after its `{`); if nothing was written into it,
    /// removes everything from `mark` (the key) instead. That is `nonempty` on an output object.
    #[inline]
    pub fn close_nonempty(&mut self, mark: usize, body: usize) -> bool {
        if self.b.len() == body {
            self.b.truncate(mark);
            false
        } else {
            self.b.push(b'}');
            true
        }
    }
    #[inline]
    pub fn mark(&self) -> usize {
        self.b.len()
    }
    #[inline]
    pub fn str_(&mut self, s: &str) {
        self.b.push(b'"');
        escape_into(s, self.b);
        self.b.push(b'"');
    }
    /// An escaped string as read from the input, re-quoted.
    #[inline]
    pub fn jstr(&mut self, s: JStr) {
        if cfg!(feature = "abl_passthru") {
            return self.str_(&s.cow());
        }
        self.b.push(b'"');
        self.b.extend_from_slice(s.0);
        self.b.push(b'"');
    }
    /// JSON.stringify of a number: like String(n); non-finite becomes null.
    #[inline]
    pub fn num(&mut self, f: f64) {
        if f.fract() == 0.0 && f.abs() < 1e15 && !(f == 0.0 && f.is_sign_negative()) {
            // integers (every `int()` result) print without the float formatter
            let mut n = f as i64;
            if n < 0 {
                self.b.push(b'-');
                n = -n;
            }
            let mut d = [0u8; 20];
            let mut k = d.len();
            loop {
                k -= 1;
                d[k] = b'0' + (n % 10) as u8;
                n /= 10;
                if n == 0 {
                    break;
                }
            }
            self.b.extend_from_slice(&d[k..]);
        } else if f.is_finite() {
            let mut buf = ryu_js::Buffer::new();
            self.b.extend_from_slice(buf.format_finite(f).as_bytes());
        } else {
            self.b.extend_from_slice(b"null");
        }
    }
}

pub fn escape_into(s: &str, out: &mut Vec<u8>) {
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

// ---------- abl_passthru: what full typed decoding of untouched subtrees costs ----------

/// A generic owned JSON value, as full serde-style decoding of every OpenRTB field would build.
enum Val<'a> {
    Null,
    Bool(bool),
    Num(f64),
    Str(S<'a>),
    Arr(Vec<Val<'a>>),
    Obj(Vec<(S<'a>, Val<'a>)>),
}
fn decode(p: &mut P<'_>) -> Val<'static> {
    match p.peek() {
        b'{' => {
            let mut m = Vec::new();
            p.obj(|p, k| m.push((Cow::Owned(JStr(k).cow().into_owned()), decode(p))));
            Val::Obj(m)
        }
        b'[' => {
            let mut a = Vec::new();
            p.arr(|p| a.push(decode(p)));
            Val::Arr(a)
        }
        b'"' => Val::Str(Cow::Owned(p.str().unwrap().cow().into_owned())),
        b't' => {
            p.raw();
            Val::Bool(true)
        }
        b'f' => {
            p.raw();
            Val::Bool(false)
        }
        b'n' => {
            p.raw();
            Val::Null
        }
        _ => Val::Num(num(p.raw()).unwrap_or(0.0)),
    }
}
fn encode(v: &Val, out: &mut Vec<u8>) {
    let mut w = W { b: out };
    match v {
        Val::Null => w.b.extend_from_slice(b"null"),
        Val::Bool(b) => w.b.extend_from_slice(if *b { b"true" } else { b"false" }),
        Val::Num(f) => w.num(*f),
        Val::Str(s) => w.str_(s),
        Val::Arr(a) => {
            w.open(b'[');
            for x in a {
                w.elem();
                encode(x, w.b);
            }
            w.close(b']');
        }
        Val::Obj(m) => {
            w.open(b'{');
            for (k, x) in m {
                w.key_str(k);
                w.b.push(b':');
                encode(x, w.b);
            }
            w.close(b'}');
        }
    }
}
fn reserialize(v: Raw, out: &mut Vec<u8>) {
    let val = decode(&mut P::new(v));
    encode(&val, out);
}

// ---------- list builtins without lists ----------

/// `split(s, sep)` on a one-character literal: a lazy view (`nth`/`len` re-split the borrowed
/// string) unless `abl_owned`, which materializes owned parts as the dynamic runtime's `split` did
/// (`abl_nointern` also searches for the separator as an allocated string, as `d.lit` + `split` did).
pub enum Parts<'s> {
    Lazy(Option<&'s str>, char),
    Owned(Vec<String>),
}
pub fn split(s: Option<&str>, sep: char) -> Parts<'_> {
    if cfg!(feature = "abl_owned") || cfg!(feature = "abl_nointern") {
        let sep = sep.to_string();
        Parts::Owned(s.map_or(Vec::new(), |s| s.split(sep.as_str()).map(str::to_owned).collect()))
    } else {
        Parts::Lazy(s, sep)
    }
}
impl<'s> Parts<'s> {
    pub fn nth(&self, i: usize) -> Option<&str> {
        match self {
            Parts::Lazy(s, sep) => s.and_then(|s| s.split(*sep).nth(i)),
            Parts::Owned(v) => v.get(i).map(String::as_str),
        }
    }
    pub fn len(&self) -> usize {
        match self {
            Parts::Lazy(s, sep) => s.map_or(0, |s| s.split(*sep).count()),
            Parts::Owned(v) => v.len(),
        }
    }
}
/// `join(list, sep)` over a raw list, appended to `out`: scalars as String(x), others skipped.
pub fn join(l: Option<Raw>, sep: &str, out: &mut String) {
    let Some(l) = l else { return };
    let mut first = true;
    P::new(l).arr(|p| {
        if let Some(s) = scalar(p.raw()) {
            if !first {
                out.push_str(sep);
            }
            out.push_str(&s);
            first = false;
        }
    });
}
