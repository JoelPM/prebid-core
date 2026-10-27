//! PROTOTYPE guest: generated Shared Adapters (gen/rs) behind the ABI hostgo/host/shared.go speaks.
//! The Host writes input into the buffer from `in_buf`, calls `<bidder>_mr` / `<bidder>_mb`, then
//! reads `out_len` bytes at `out_ptr`. Output is framed (prebid_core_rt::Frame): length-prefixed
//! records, no JSON envelope to re-scan.
//!
//! #20 (Smaato): MakeRequests takes [host context JSON][request JSON] and returns any number of
//! requests; MakeBids takes [host context][request][response][http: {status, headers}] and says
//! whether the response Phase rejected the response. The Host provides `prebid.now_ms` and
//! `prebid.convert_currency` as imports.
use prebid_core_rt::{BidsOut, Doc, Frame, Reqs};
use std::cell::RefCell;

#[cfg(feature = "openx")]
#[path = "../../gen/rs/openx_server.rs"]
pub mod openx;
#[cfg(feature = "pubmatic")]
#[path = "../../gen/rs/pubmatic_server.rs"]
pub mod pubmatic;
#[cfg(feature = "smaato")]
#[path = "../../gen/rs/smaato_server.rs"]
pub mod smaato;

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

pub fn frame_req(r: Reqs) -> Vec<u8> {
    let mut f = Frame(Vec::with_capacity(256));
    f.u32(r.reqs.len() as u32);
    for (body, ids) in &r.reqs {
        f.bytes(body);
        f.u32(ids.len() as u32);
        ids.iter().for_each(|i| f.bytes(i.as_bytes()));
    }
    f.u32(r.errs.len() as u32);
    r.errs.iter().for_each(|e| f.bytes(e.as_bytes()));
    f.0
}
pub fn frame_bids(r: BidsOut) -> Vec<u8> {
    let mut f = Frame(Vec::with_capacity(256));
    f.u32(r.rejected as u32);
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

type Mr = fn(&mut Doc, u32, u32) -> Reqs;
type Mb = fn(&mut Doc, u32, u32, u32, u32) -> BidsOut;

/// Runs make_requests over [host context (ctx_len bytes)][request (req_len bytes)].
pub fn run_mr(ctx_len: u32, req_len: u32, mr: Mr) -> u32 {
    DOC.with(|d| {
        let mut d = d.borrow_mut();
        d.reset();
        let (c, r) = IN.with(|b| {
            let b = b.borrow();
            let c = d.parse(&b[..ctx_len as usize]);
            (c, d.parse(&b[ctx_len as usize..(ctx_len + req_len) as usize]))
        });
        let out = frame_req(mr(&mut d, c, r));
        OUT.with(|o| {
            *o.borrow_mut() = out;
            o.borrow().len() as u32
        })
    })
}
/// Runs make_bids over [host context][request][response][http].
pub fn run_mb(lens: [u32; 4], mb: Mb) -> u32 {
    DOC.with(|d| {
        let mut d = d.borrow_mut();
        d.reset();
        let v = IN.with(|b| {
            let b = b.borrow();
            let mut at = 0usize;
            lens.map(|n| {
                let x = d.parse(&b[at..at + n as usize]);
                at += n as usize;
                x
            })
        });
        let out = frame_bids(mb(&mut d, v[0], v[1], v[2], v[3]));
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
        pub extern "C" fn $mr(ctx_len: u32, req_len: u32) -> u32 {
            run_mr(ctx_len, req_len, $m::make_requests)
        }
        #[cfg(feature = $feat)]
        #[no_mangle]
        pub extern "C" fn $mb(ctx_len: u32, req_len: u32, resp_len: u32, http_len: u32) -> u32 {
            run_mb([ctx_len, req_len, resp_len, http_len], $m::make_bids)
        }
    };
}
exports!("openx", openx, openx_mr, openx_mb);
exports!("pubmatic", pubmatic, pubmatic_mr, pubmatic_mb);
exports!("smaato", smaato, smaato_mr, smaato_mb);
