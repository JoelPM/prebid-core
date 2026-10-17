//! Field-by-field backend: JS owns the objects. Values are indices into a JS handle table
//! (0 = undefined); keys and literals are strings in wasm's data segment, which the
//! generic glue decodes (and caches). No JSON in wasm at all.
//! (Packing ptr|len into one u32 was tried: -190 B raw but +3 B gzip, and rustc places data
//! above the 1 MiB stack, so it needs more than 32 bits anyway. Not worth it.)
use crate::{Doc, Kind};

#[link(wasm_import_module = "h")]
extern "C" {
    fn k(v: u32) -> u32;
    fn g(o: u32, kp: *const u8, kl: usize) -> u32;
    fn n(v: u32) -> u32;
    fn a(v: u32, i: u32) -> u32;
    fn ka(o: u32, i: u32) -> u32;
    fn eq(v: u32, sp: *const u8, sl: usize) -> u32;
    fn se(a: u32, b: u32) -> u32;
    fn t(v: u32) -> u32;
    fn pn(v: u32) -> u32;
    fn tn(v: u32) -> u32;
    fn ts(v: u32) -> u32;
    fn o() -> u32;
    fn r() -> u32;
    fn l(sp: *const u8, sl: usize) -> u32;
    fn i(v: u32) -> u32;
    fn s(o: u32, kp: *const u8, kl: usize, v: u32);
    fn sd(o: u32, kv: u32, v: u32);
    fn d(o: u32, kp: *const u8, kl: usize);
    fn p(a: u32, v: u32);
    fn c(o: u32) -> u32;
}

pub struct Imp;

impl Doc for Imp {
    type V = u32;
    fn kind(&mut self, v: u32) -> Kind {
        unsafe { core::mem::transmute(k(v) as u8) }
    }
    fn get(&mut self, ob: u32, key: &'static str) -> u32 {
        unsafe { g(ob, key.as_ptr(), key.len()) }
    }
    fn len(&mut self, v: u32) -> u32 {
        unsafe { n(v) }
    }
    fn at(&mut self, v: u32, ix: u32) -> u32 {
        unsafe { a(v, ix) }
    }
    fn key_at(&mut self, ob: u32, ix: u32) -> u32 {
        unsafe { ka(ob, ix) }
    }
    fn str_eq(&mut self, v: u32, st: &'static str) -> bool {
        unsafe { eq(v, st.as_ptr(), st.len()) != 0 }
    }
    fn same_str(&mut self, x: u32, y: u32) -> bool {
        unsafe { se(x, y) != 0 }
    }
    fn truthy(&mut self, v: u32) -> bool {
        unsafe { t(v) != 0 }
    }
    fn pos_num(&mut self, v: u32) -> bool {
        unsafe { pn(v) != 0 }
    }
    fn to_num(&mut self, v: u32) -> u32 {
        unsafe { tn(v) }
    }
    fn to_str(&mut self, v: u32) -> u32 {
        unsafe { ts(v) }
    }
    fn obj(&mut self) -> u32 {
        unsafe { o() }
    }
    fn arr(&mut self) -> u32 {
        unsafe { r() }
    }
    fn lit(&mut self, st: &'static str) -> u32 {
        unsafe { l(st.as_ptr(), st.len()) }
    }
    fn int(&mut self, v: u32) -> u32 {
        unsafe { i(v) }
    }
    fn set(&mut self, ob: u32, key: &'static str, v: u32) {
        unsafe { s(ob, key.as_ptr(), key.len(), v) }
    }
    fn set_dyn(&mut self, ob: u32, kv: u32, v: u32) {
        unsafe { sd(ob, kv, v) }
    }
    fn del(&mut self, ob: u32, key: &'static str) {
        unsafe { d(ob, key.as_ptr(), key.len()) }
    }
    fn push(&mut self, ar: u32, v: u32) {
        unsafe { p(ar, v) }
    }
    fn clone_obj(&mut self, ob: u32) -> u32 {
        unsafe { c(ob) }
    }
}

#[cfg(not(feature = "floor"))]
#[no_mangle]
pub extern "C" fn make_requests(req: u32, client: u32) -> u32 {
    crate::openx::make_requests(&mut Imp, req, client != 0)
}
#[cfg(not(feature = "floor"))]
#[no_mangle]
pub extern "C" fn make_bids(req: u32, resp: u32) -> u32 {
    crate::openx::make_bids(&mut Imp, req, resp)
}
#[cfg(not(feature = "floor"))]
#[no_mangle]
pub extern "C" fn is_valid(bid: u32) -> u32 {
    crate::openx::is_valid(&mut Imp, bid) as u32
}
