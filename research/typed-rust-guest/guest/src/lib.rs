//! OpenX Adapter guest in two styles (serde_json::Value vs typed borrowing structs) behind two
//! ABIs (#3's alloc/adapt/dealloc single call vs a lean split MakeRequests/MakeBids pair over a
//! reused guest-owned buffer). See ../../typed-rust-guest.md.
pub mod typed;
pub mod value;

/// Imp table the Host sends with MakeBids so the guest can resolve bids without `mtype`
/// (getMediaTypeForImp): (imp id, media bits 1 banner | 2 video | 4 native).
pub type Imps<'a> = Vec<(&'a str, u8)>;

pub fn imp_type(mtype: Option<i64>, impid: &str, imps: &Imps) -> &'static str {
    match mtype {
        Some(1) => "banner",
        Some(2) => "video",
        Some(4) => "native",
        _ => match imps.iter().find(|(id, _)| *id == impid) {
            Some((_, m)) if m & 1 == 0 && m & 2 != 0 => "video",
            Some((_, m)) if m & 1 == 0 && m & 4 != 0 => "native",
            _ => "banner",
        },
    }
}

/// MakeBids input: u32 n, then n × (u8 media, u16 len, id bytes), then the response body.
pub fn split_bids_input(b: &[u8]) -> (Imps<'_>, &[u8]) {
    let n = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
    let mut imps = Vec::with_capacity(n);
    let mut i = 4;
    for _ in 0..n {
        let m = b[i];
        let l = u16::from_le_bytes(b[i + 1..i + 3].try_into().unwrap()) as usize;
        imps.push((std::str::from_utf8(&b[i + 3..i + 3 + l]).unwrap(), m));
        i += 3 + l;
    }
    (imps, &b[i..])
}

// ---- lean ABI: one reused input buffer, one reused output buffer, one call per hook ----
static mut IN: Vec<u8> = Vec::new();
static mut OUT: Vec<u8> = Vec::new();

/// Returns a guest buffer of at least `n` bytes for the Host to write the next input into.
/// Hosts cache (ptr, cap) and only call this again when an input outgrows it.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn in_buf(n: u32) -> u32 {
    IN.clear();
    IN.reserve(n as usize);
    IN.set_len(n as usize);
    IN.as_mut_ptr() as usize as u32
}

#[allow(static_mut_refs)]
unsafe fn with_io(n: u32, f: impl FnOnce(&[u8], &mut Vec<u8>)) -> u64 {
    OUT.clear();
    f(&IN[..n as usize], &mut OUT);
    ((OUT.as_ptr() as usize as u64) << 32) | OUT.len() as u64
}

#[no_mangle]
pub unsafe extern "C" fn mr_value(n: u32) -> u64 { with_io(n, value::make_requests) }
#[no_mangle]
pub unsafe extern "C" fn mr_typed(n: u32) -> u64 { with_io(n, typed::make_requests) }
#[no_mangle]
pub unsafe extern "C" fn mb_value(n: u32) -> u64 {
    with_io(n, |i, o| { let (imps, r) = split_bids_input(i); value::make_bids(&imps, r, o) })
}
#[no_mangle]
pub unsafe extern "C" fn mb_typed_json(n: u32) -> u64 {
    with_io(n, |i, o| { let (imps, r) = split_bids_input(i); typed::make_bids_json(&imps, r, o) })
}
#[no_mangle]
pub unsafe extern "C" fn mb_typed_annot(n: u32) -> u64 {
    with_io(n, |i, o| { let (imps, r) = split_bids_input(i); typed::make_bids_annot(&imps, r, o) })
}

// ---- #3's ABI, unchanged ----
static mut LAST: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(n: u32) -> u32 {
    let mut v = Vec::<u8>::with_capacity(n as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: u32, n: u32) { drop(Vec::from_raw_parts(p as usize as *mut u8, 0, n as usize)); }
#[no_mangle]
pub unsafe extern "C" fn adapt(rp: u32, rl: u32, sp: u32, sl: u32) -> u64 {
    let req = std::slice::from_raw_parts(rp as usize as *const u8, rl as usize);
    let resp = std::slice::from_raw_parts(sp as usize as *const u8, sl as usize);
    let out = value::run_legacy(req, resp);
    let r = ((out.as_ptr() as usize as u64) << 32) | out.len() as u64;
    #[allow(static_mut_refs)]
    { LAST = out; }
    r
}
#[no_mangle]
pub extern "C" fn noop(x: u32) -> u32 { x + 1 }
