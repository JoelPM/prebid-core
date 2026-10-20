//! RESEARCH guest for #16: PubMatic and OpenX hand-written in the shape a typed E' back end would
//! emit, behind exactly the ABI guest/src/lib.rs exports and hostgo/host/shared.go speaks:
//! in_buf(n) -> ptr; <bidder>_mr(len) / <bidder>_mb(reqLen, respLen) -> outLen; out_ptr() -> ptr.
//! Output is the same length-prefixed frames (prebid_core_rt::Frame layout).
//!
//! Generated code writes its frame straight into the guest's output buffer: the request body is
//! streamed into place behind a length placeholder, so nothing is built and then copied.
use std::cell::RefCell;

#[macro_use]
pub mod j;
#[cfg(feature = "openx")]
pub mod openx;
#[cfg(feature = "pubmatic")]
pub mod pubmatic;

#[cfg(feature = "bump")]
mod bump;

thread_local! {
    static IN: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Returns a pointer to an input buffer of at least `n` bytes (reused across calls).
#[no_mangle]
pub extern "C" fn in_buf(n: u32) -> *mut u8 {
    IN.with(|b| {
        let mut b = b.borrow_mut();
        b.resize(n as usize, 0);
        b.as_mut_ptr()
    })
}
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|b| b.borrow().as_ptr())
}

/// Frame writing on the output buffer: little-endian u32s and u32-length-prefixed byte strings.
pub trait Fr {
    fn u32(&mut self, n: u32);
    fn bytes(&mut self, b: &[u8]);
    /// Starts a length-prefixed record whose bytes are written in place; returns its position.
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

fn run(f: impl FnOnce(&[u8], &mut Vec<u8>)) -> u32 {
    IN.with(|i| {
        OUT.with(|o| {
            let i = i.borrow();
            let mut o = o.borrow_mut();
            #[cfg(feature = "bump")]
            {
                // Per-call arena: build the frame in it, copy out with the arena off, then reset.
                bump::begin();
                let mut scratch = Vec::with_capacity(4096);
                f(&i, &mut scratch);
                bump::pause();
                o.clear();
                o.extend_from_slice(&scratch);
                drop(scratch);
                bump::reset();
            }
            #[cfg(not(feature = "bump"))]
            {
                if cfg!(feature = "abl_freshout") {
                    *o = Vec::new();
                } else {
                    o.clear();
                }
                f(&i, &mut o);
            }
            o.len() as u32
        })
    })
}

macro_rules! exports {
    ($feat:literal, $m:ident, $mr:ident, $mb:ident) => {
        #[cfg(feature = $feat)]
        #[no_mangle]
        pub extern "C" fn $mr(len: u32) -> u32 {
            run(|i, o| $m::make_requests(&i[..len as usize], o))
        }
        #[cfg(feature = $feat)]
        #[no_mangle]
        pub extern "C" fn $mb(req_len: u32, resp_len: u32) -> u32 {
            let (q, s) = (req_len as usize, resp_len as usize);
            run(|i, o| $m::make_bids(&i[..q], &i[q..q + s], o))
        }
    };
}
exports!("openx", openx, openx_mr, openx_mb);
exports!("pubmatic", pubmatic, pubmatic_mr, pubmatic_mb);

// ---------- bid annotation slots (read by hostgo/host/shared.go's kvs) ----------

/// A key/value slot with one member taken from a raw value: kind 0 string content, 1 number text,
/// 2 JSON. `None` is an empty slot.
pub fn kv1(out: &mut Vec<u8>, k: &str, v: Option<j::Raw>) {
    let Some(v) = v else { return out.u32(0) };
    let at = out.begin();
    out.u32(1);
    out.bytes(k.as_bytes());
    match v.first() {
        Some(b'"') => {
            out.push(0);
            let s = j::jstr(v).unwrap().cow();
            out.bytes(s.as_bytes());
        }
        Some(b'-' | b'0'..=b'9') => {
            out.push(1);
            out.bytes(v);
        }
        _ => {
            out.push(2);
            out.bytes(v);
        }
    }
    out.end(at);
}
/// Starts a key/value slot of up to `n` members; returns (slot position, count position).
pub fn kv_begin(out: &mut Vec<u8>) -> (usize, usize) {
    let at = out.begin();
    let n = out.begin();
    (at, n)
}
pub fn kv_member(out: &mut Vec<u8>, k: &str, kind: u8, v: &[u8]) {
    out.bytes(k.as_bytes());
    out.push(kind);
    out.bytes(v);
}
/// Closes a slot with `count` members; an empty one becomes an empty slot.
pub fn kv_end(out: &mut Vec<u8>, (at, n): (usize, usize), count: u32) {
    if count == 0 {
        out.truncate(at);
        out.u32(0);
    } else {
        out.patch(n, count);
        out.end(at);
    }
}

/// paapi: entries(resp.ext.fledge_auction_configs).map(e, {impid: e.k, config: e.v}), as a JSON slot.
pub fn paapi(out: &mut Vec<u8>, cfgs: Option<j::Raw>) {
    let ms = match cfgs {
        Some(c) if c.first() == Some(&b'{') => j::members(c),
        _ => Vec::new(),
    };
    if ms.is_empty() {
        return out.u32(0);
    }
    let at = out.begin();
    let mut w = j::W { b: &mut *out };
    w.open(b'[');
    for (k, v) in &ms {
        w.elem();
        w.open(b'{');
        key!(w, "impid");
        w.str_(k);
        key!(w, "config");
        w.raw(v);
        w.close(b'}');
    }
    w.close(b']');
    out.end(at);
}

/// Research hook, not part of the Adapter ABI: scans the first `len` input bytes as one JSON value
/// and does nothing else. The bench uses it for the floor any guest that reads its input pays.
#[no_mangle]
pub extern "C" fn scan(len: u32) -> u32 {
    IN.with(|i| {
        let i = i.borrow();
        let mut p = j::P::new(&i[..len as usize]);
        p.raw().len() as u32
    })
}
