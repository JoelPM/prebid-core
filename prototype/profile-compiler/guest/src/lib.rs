//! PROTOTYPE guest: generated Shared Adapters (gen/rs) behind the ABI hostgo/host/shared.go speaks.
//! The Host writes input into the buffer from `in_buf`, calls `<bidder>_mr` / `<bidder>_mb`, then
//! reads `out_len` bytes at `out_ptr`. Output is framed (prebid_core_rt::Frame): length-prefixed
//! records, no JSON envelope to re-scan.
use prebid_core_rt::{BidsOut, Doc, Frame, ReqOut};
use std::cell::RefCell;

#[cfg(feature = "openx")]
#[path = "../../gen/rs/openx_server.rs"]
pub mod openx;
#[cfg(feature = "pubmatic")]
#[path = "../../gen/rs/pubmatic_server.rs"]
pub mod pubmatic;

thread_local! {
    static IN: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static DOC: RefCell<Doc> = RefCell::new(Doc::new());
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

pub fn frame_req(r: ReqOut) -> Vec<u8> {
    let mut f = Frame(Vec::with_capacity(r.body.as_ref().map_or(64, |b| b.len() + 64)));
    match &r.body {
        Some(b) => {
            f.u32(1);
            f.bytes(b)
        }
        None => f.u32(0),
    }
    f.u32(r.imp_ids.len() as u32);
    r.imp_ids.iter().for_each(|i| f.bytes(i.as_bytes()));
    f.u32(r.errs.len() as u32);
    r.errs.iter().for_each(|e| f.bytes(e.as_bytes()));
    f.0
}
pub fn frame_bids(r: BidsOut) -> Vec<u8> {
    let mut f = Frame(Vec::with_capacity(256));
    f.u32(r.bids.len() as u32);
    for b in &r.bids {
        f.u32(b.keep as u32);
        f.bytes(b.typ.as_bytes());
        f.bytes(b.seat.as_bytes());
        f.u32(b.deal_priority as i32 as u32);
        f.bytes(&b.video);
        f.bytes(&b.meta);
        f.bytes(&b.overrides);
    }
    f.bytes(r.currency.as_bytes());
    f.bytes(&r.paapi);
    f.u32(r.errs.len() as u32);
    r.errs.iter().for_each(|e| f.bytes(e.as_bytes()));
    f.0
}

/// Runs make_requests over the first `len` input bytes (the Host-serialized OpenRTB request).
pub fn run_mr(len: u32, mr: fn(&mut Doc, u32) -> ReqOut) -> u32 {
    DOC.with(|d| {
        let mut d = d.borrow_mut();
        d.reset();
        let root = IN.with(|b| d.parse(&b.borrow()[..len as usize]));
        let out = frame_req(mr(&mut d, root));
        OUT.with(|o| {
            *o.borrow_mut() = out;
            o.borrow().len() as u32
        })
    })
}
/// Runs make_bids over [request JSON (req_len bytes)][response JSON (resp_len bytes)].
pub fn run_mb(req_len: u32, resp_len: u32, mb: fn(&mut Doc, u32, u32) -> BidsOut) -> u32 {
    DOC.with(|d| {
        let mut d = d.borrow_mut();
        d.reset();
        let (rq, rs) = IN.with(|b| {
            let b = b.borrow();
            let rq = d.parse(&b[..req_len as usize]);
            let rs = d.parse(&b[req_len as usize..(req_len + resp_len) as usize]);
            (rq, rs)
        });
        let out = frame_bids(mb(&mut d, rq, rs));
        OUT.with(|o| {
            *o.borrow_mut() = out;
            o.borrow().len() as u32
        })
    })
}

macro_rules! exports {
    ($feat:literal, $m:ident, $mr:ident, $mb:ident) => {
        #[cfg(feature = $feat)]
        #[no_mangle]
        pub extern "C" fn $mr(len: u32) -> u32 {
            run_mr(len, $m::make_requests)
        }
        #[cfg(feature = $feat)]
        #[no_mangle]
        pub extern "C" fn $mb(req_len: u32, resp_len: u32) -> u32 {
            run_mb(req_len, resp_len, $m::make_bids)
        }
    };
}
exports!("openx", openx, openx_mr, openx_mb);
exports!("pubmatic", pubmatic, pubmatic_mr, pubmatic_mb);
