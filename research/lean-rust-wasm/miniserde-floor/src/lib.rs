//! Floor for a miniserde-based Adapter: parse + re-serialize JSON over the same raw ABI as the
//! serde_json toy in research/prebidjs-bundle-budget. std + default (dlmalloc) allocator.
use miniserde::json;

static mut BUF: Vec<u8> = Vec::new();
static mut OUT: String = String::new();

#[no_mangle]
pub extern "C" fn alloc_in(len: usize) -> *mut u8 {
    unsafe {
        let b = &mut *std::ptr::addr_of_mut!(BUF);
        b.clear();
        b.resize(len, 0);
        b.as_mut_ptr()
    }
}
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    unsafe { (&*std::ptr::addr_of!(OUT)).as_ptr() }
}

#[cfg(not(feature = "derive"))]
#[no_mangle]
pub extern "C" fn roundtrip(len: usize) -> usize {
    unsafe {
        let s = std::str::from_utf8(&(&*std::ptr::addr_of!(BUF))[..len]).unwrap_or("null");
        let v: json::Value = json::from_str(s).unwrap_or(json::Value::Null);
        OUT = json::to_string(&v);
        (&*std::ptr::addr_of!(OUT)).len()
    }
}

#[cfg(feature = "derive")]
mod typed {
    use miniserde::{json, Deserialize, Serialize};
    #[derive(Serialize, Deserialize)]
    pub struct Imp { pub id: String, pub tagid: Option<String>, pub bidfloor: Option<f64>, pub ext: Option<json::Value>, pub banner: Option<json::Value>, pub video: Option<json::Value>, pub native: Option<json::Value> }
    #[derive(Serialize, Deserialize)]
    pub struct Req { pub id: String, pub imp: Vec<Imp>, pub ext: Option<json::Value> }
    #[no_mangle]
    pub extern "C" fn roundtrip(len: usize) -> usize {
        unsafe {
            let s = std::str::from_utf8(&(&*std::ptr::addr_of!(super::BUF))[..len]).unwrap_or("null");
            super::OUT = match json::from_str::<Req>(s) { Ok(r) => json::to_string(&r), Err(_) => String::new() };
            (&*std::ptr::addr_of!(super::OUT)).len()
        }
    }
}
