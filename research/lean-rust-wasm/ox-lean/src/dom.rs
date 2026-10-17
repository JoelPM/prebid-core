//! Bytes-in / bytes-out backend: hand-written JSON scanner -> node arena -> emitter.
//! No allocator: one bump pointer over linear memory, reset on every call.
//! Strings and numbers stay as spans of the input (escapes untouched, numbers never parsed),
//! so there is no float parsing/printing, no UTF-8 validation and no core::fmt.
use crate::{Doc, Kind};
use core::arch::wasm32::{memory_grow, memory_size};

extern "C" {
    static __heap_base: u8;
}

static mut TOP: usize = 0;
static mut CAP: usize = 0;
static mut IN: usize = 0;
static mut OUT: usize = 0;
static mut P: usize = 0;
static mut END: usize = 0;

#[derive(Clone, Copy)]
#[repr(C)]
struct N {
    kind: u8,
    s: u32,
    l: u32,
    ks: u32,
    kl: u32,
    first: u32,
    last: u32,
    next: u32,
    cnt: u32,
}

unsafe fn ensure(end: usize) {
    if end > CAP {
        let have = memory_size(0) * 65536;
        if end > have {
            memory_grow(0, (end - have + 65535) / 65536);
        }
        CAP = memory_size(0) * 65536;
    }
}
unsafe fn bump(n: usize) -> usize {
    let p = TOP;
    TOP = (p + n + 3) & !3;
    ensure(TOP);
    p
}
#[inline(always)]
unsafe fn n(v: u32) -> &'static mut N {
    &mut *(v as *mut N)
}
unsafe fn node(kind: Kind, s: usize, l: usize) -> u32 {
    let a = bump(core::mem::size_of::<N>());
    *(a as *mut N) = N { kind: kind as u8, s: s as u32, l: l as u32, ks: 0, kl: 0, first: 0, last: 0, next: 0, cnt: 0 };
    a as u32
}
unsafe fn copy(v: u32, ks: u32, kl: u32) -> u32 {
    let a = bump(core::mem::size_of::<N>()) as u32;
    *n(a) = N { ks, kl, next: 0, ..*n(v) };
    a
}
unsafe fn append(p: u32, c: u32) {
    let pp = n(p);
    if pp.last == 0 {
        pp.first = c;
    } else {
        n(pp.last).next = c;
    }
    pp.last = c;
    pp.cnt += 1;
}
unsafe fn bytes(s: u32, l: u32) -> &'static [u8] {
    core::slice::from_raw_parts(s as *const u8, l as usize)
}

// ---- scanner ----
#[inline(always)]
unsafe fn b() -> u8 {
    if P < END { *(P as *const u8) } else { 0 }
}
unsafe fn ws() {
    while matches!(b(), b' ' | b'\n' | b'\r' | b'\t') {
        P += 1;
    }
}
unsafe fn string() -> (usize, usize) {
    P += 1;
    let s = P;
    while P < END {
        match b() {
            b'"' => break,
            b'\\' => P += 2,
            _ => P += 1,
        }
    }
    let l = P - s;
    P += 1;
    (s, l)
}
unsafe fn val() -> u32 {
    ws();
    let c = b();
    match c {
        b'{' | b'[' => {
            P += 1;
            let close = c + 2; // '{'+2 = '}', '['+2 = ']'
            let o = node(if c == b'{' { Kind::Obj } else { Kind::Arr }, 0, 0);
            loop {
                ws();
                let d = b();
                if d == close || d == 0 {
                    P += 1;
                    break;
                }
                if d == b',' {
                    P += 1;
                    continue;
                }
                let (mut ks, mut kl) = (0, 0);
                if c == b'{' {
                    (ks, kl) = string();
                    ws();
                    P += 1; // ':'
                }
                let v = val();
                n(v).ks = ks as u32;
                n(v).kl = kl as u32;
                append(o, v);
            }
            o
        }
        b'"' => {
            let (s, l) = string();
            node(Kind::Str, s, l)
        }
        b't' => {
            P += 4;
            node(Kind::True, 0, 0)
        }
        b'f' => {
            P += 5;
            node(Kind::False, 0, 0)
        }
        b'n' => {
            P += 4;
            node(Kind::Null, 0, 0)
        }
        _ => {
            let s = P;
            while matches!(b(), b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                P += 1;
            }
            if P == s {
                P = END; // malformed: stop
                return node(Kind::Null, 0, 0);
            }
            node(Kind::Num, s, P - s)
        }
    }
}

// ---- emitter ----
unsafe fn w(c: u8) {
    ensure(TOP + 1);
    *(TOP as *mut u8) = c;
    TOP += 1;
}
unsafe fn ws_(s: &[u8]) {
    for &c in s {
        w(c);
    }
}
unsafe fn emit(v: u32) {
    let x = *n(v);
    match x.kind {
        2 => ws_(b"true"),
        3 => ws_(b"false"),
        4 => ws_(bytes(x.s, x.l)),
        5 => {
            w(b'"');
            ws_(bytes(x.s, x.l));
            w(b'"');
        }
        6 | 7 => {
            w(if x.kind == 6 { b'[' } else { b'{' });
            let mut c = x.first;
            while c != 0 {
                if c != x.first {
                    w(b',');
                }
                if x.kind == 7 {
                    w(b'"');
                    ws_(bytes(n(c).ks, n(c).kl));
                    w(b'"');
                    w(b':');
                }
                emit(c);
                c = n(c).next;
            }
            w(if x.kind == 6 { b']' } else { b'}' });
        }
        _ => ws_(b"null"),
    }
}

// ---- number-ish span tests (no float parsing) ----
unsafe fn numeric(x: &N) -> bool {
    let s = bytes(x.s, x.l);
    !s.is_empty() && s.iter().all(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')) && s[0] != b'e' && s[0] != b'E'
}
unsafe fn nonzero(x: &N) -> bool {
    for &c in bytes(x.s, x.l) {
        if c == b'e' || c == b'E' {
            break;
        }
        if matches!(c, b'1'..=b'9') {
            return true;
        }
    }
    false
}

pub struct Dom;

impl Doc for Dom {
    type V = u32;
    fn kind(&mut self, v: u32) -> Kind {
        if v == 0 { Kind::None } else { unsafe { core::mem::transmute(n(v).kind) } }
    }
    fn get(&mut self, o: u32, k: &'static str) -> u32 {
        if self.kind(o) != Kind::Obj {
            return 0;
        }
        unsafe {
            let mut c = n(o).first;
            while c != 0 {
                if bytes(n(c).ks, n(c).kl) == k.as_bytes() {
                    return c;
                }
                c = n(c).next;
            }
        }
        0
    }
    fn len(&mut self, v: u32) -> u32 {
        match self.kind(v) {
            Kind::Arr | Kind::Obj => unsafe { n(v).cnt },
            _ => 0,
        }
    }
    fn at(&mut self, v: u32, i: u32) -> u32 {
        if i >= self.len(v) {
            return 0;
        }
        unsafe {
            let mut c = n(v).first;
            for _ in 0..i {
                c = n(c).next;
            }
            c
        }
    }
    fn key_at(&mut self, o: u32, i: u32) -> u32 {
        let c = self.at(o, i);
        if c == 0 { 0 } else { unsafe { node(Kind::Str, n(c).ks as usize, n(c).kl as usize) } }
    }
    fn str_eq(&mut self, v: u32, s: &'static str) -> bool {
        matches!(self.kind(v), Kind::Str | Kind::Num) && unsafe { bytes(n(v).s, n(v).l) == s.as_bytes() }
    }
    fn same_str(&mut self, a: u32, b: u32) -> bool {
        self.kind(a) == Kind::Str && self.kind(b) == Kind::Str && unsafe { bytes(n(a).s, n(a).l) == bytes(n(b).s, n(b).l) }
    }
    fn truthy(&mut self, v: u32) -> bool {
        match self.kind(v) {
            Kind::None | Kind::Null | Kind::False => false,
            Kind::Num => unsafe { nonzero(n(v)) },
            Kind::Str => unsafe { n(v).l > 0 },
            _ => true,
        }
    }
    fn pos_num(&mut self, v: u32) -> bool {
        matches!(self.kind(v), Kind::Num | Kind::Str) && unsafe { numeric(n(v)) && n(v).l > 0 && *(n(v).s as *const u8) != b'-' && nonzero(n(v)) }
    }
    fn to_num(&mut self, v: u32) -> u32 {
        match self.kind(v) {
            Kind::Num => v,
            Kind::Str if unsafe { numeric(n(v)) } => unsafe { node(Kind::Num, n(v).s as usize, n(v).l as usize) },
            _ => 0,
        }
    }
    fn to_str(&mut self, v: u32) -> u32 {
        match self.kind(v) {
            Kind::Str => v,
            Kind::Num => unsafe { node(Kind::Str, n(v).s as usize, n(v).l as usize) },
            _ => 0,
        }
    }
    fn obj(&mut self) -> u32 {
        unsafe { node(Kind::Obj, 0, 0) }
    }
    fn arr(&mut self) -> u32 {
        unsafe { node(Kind::Arr, 0, 0) }
    }
    fn lit(&mut self, s: &'static str) -> u32 {
        unsafe { node(Kind::Str, s.as_ptr() as usize, s.len()) }
    }
    fn int(&mut self, mut v: u32) -> u32 {
        unsafe {
            let mut buf = [0u8; 10];
            let mut i = 10;
            loop {
                i -= 1;
                buf[i] = b'0' + (v % 10) as u8;
                v /= 10;
                if v == 0 {
                    break;
                }
            }
            let l = 10 - i;
            let p = bump(l);
            core::ptr::copy_nonoverlapping(buf.as_ptr().add(i), p as *mut u8, l);
            node(Kind::Num, p, l)
        }
    }
    fn set(&mut self, o: u32, k: &'static str, v: u32) {
        set_key(o, k.as_ptr() as u32, k.len() as u32, v)
    }
    fn set_dyn(&mut self, o: u32, k: u32, v: u32) {
        if k != 0 {
            unsafe { set_key(o, n(k).s, n(k).l, v) }
        }
    }
    fn del(&mut self, o: u32, k: &'static str) {
        if self.kind(o) != Kind::Obj {
            return;
        }
        unsafe {
            let (mut prev, mut c) = (0u32, n(o).first);
            while c != 0 {
                if bytes(n(c).ks, n(c).kl) == k.as_bytes() {
                    let nx = n(c).next;
                    if prev == 0 { n(o).first = nx } else { n(prev).next = nx }
                    if n(o).last == c {
                        n(o).last = prev;
                    }
                    n(o).cnt -= 1;
                    return;
                }
                prev = c;
                c = n(c).next;
            }
        }
    }
    fn push(&mut self, a: u32, v: u32) {
        if v != 0 && self.kind(a) == Kind::Arr {
            unsafe { append(a, copy(v, 0, 0)) }
        }
    }
    fn clone_obj(&mut self, o: u32) -> u32 {
        let r = self.obj();
        if self.kind(o) == Kind::Obj {
            unsafe {
                let mut c = n(o).first;
                while c != 0 {
                    append(r, copy(c, n(c).ks, n(c).kl));
                    c = n(c).next;
                }
            }
        }
        r
    }
}

fn set_key(o: u32, ks: u32, kl: u32, v: u32) {
    if o == 0 || v == 0 {
        return;
    }
    unsafe {
        if n(o).kind != Kind::Obj as u8 {
            return;
        }
        let mut c = n(o).first;
        while c != 0 {
            if bytes(n(c).ks, n(c).kl) == bytes(ks, kl) {
                let nx = n(c).next;
                *n(c) = N { ks, kl, next: nx, ..*n(v) };
                return;
            }
            c = n(c).next;
        }
        append(o, copy(v, ks, kl));
    }
}

// ---- exports: JS writes UTF-8 JSON at alloc_in(), calls, reads out_ptr()/len ----
#[no_mangle]
pub unsafe extern "C" fn alloc_in(len: usize) -> usize {
    TOP = &__heap_base as *const u8 as usize;
    IN = bump(len);
    IN
}
#[no_mangle]
pub unsafe extern "C" fn out_ptr() -> usize {
    OUT
}
unsafe fn parse_at(off: usize, len: usize) -> u32 {
    P = IN + off;
    END = P + len;
    val()
}
unsafe fn finish(v: u32) -> usize {
    OUT = TOP;
    emit(v);
    TOP - OUT
}

#[cfg(feature = "floor")]
#[no_mangle]
pub unsafe extern "C" fn roundtrip(len: usize) -> usize {
    finish(parse_at(0, len))
}

#[cfg(not(feature = "floor"))]
#[no_mangle]
pub unsafe extern "C" fn make_requests(len: usize, client: u32) -> usize {
    let r = parse_at(0, len);
    finish(crate::openx::make_requests(&mut Dom, r, client != 0))
}
#[cfg(not(feature = "floor"))]
#[no_mangle]
pub unsafe extern "C" fn make_bids(req_len: usize, resp_len: usize) -> usize {
    let rq = parse_at(0, req_len);
    let rs = parse_at(req_len, resp_len);
    finish(crate::openx::make_bids(&mut Dom, rq, rs))
}
#[cfg(not(feature = "floor"))]
#[no_mangle]
pub unsafe extern "C" fn is_valid(len: usize) -> u32 {
    let b = parse_at(0, len);
    crate::openx::is_valid(&mut Dom, b) as u32
}
