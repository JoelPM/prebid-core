/// 1 if `b` is valid UTF-8 (the guest-boundary check; `from_utf8_lossy` only runs when it fails).
pub fn valid(b: &[u8]) -> bool {
    std::str::from_utf8(b).is_ok()
}
/// Number of `\uD800`–`\uDFFF` escapes: what tells a string's `&str` fast path from its WTF-8 path.
pub fn surrogate_escapes(b: &[u8]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while let Some(j) = memchr_bs(&b[i..]) {
        let k = i + j;
        if b.get(k + 1) == Some(&b'u') && matches!(b.get(k + 2), Some(b'd' | b'D')) && matches!(b.get(k + 3), Some(b'8'..=b'9' | b'a'..=b'f' | b'A'..=b'F')) {
            n += 1;
        }
        i = k + 2;
        if i >= b.len() {
            break;
        }
    }
    n
}
fn memchr_bs(b: &[u8]) -> Option<usize> {
    b.iter().position(|&c| c == b'\\')
}

static mut BUF: [u8; 65536] = [0; 65536];
#[no_mangle]
pub extern "C" fn buf() -> *mut u8 {
    std::ptr::addr_of_mut!(BUF) as *mut u8
}
#[no_mangle]
pub extern "C" fn w_valid(len: usize) -> u32 {
    valid(unsafe { std::slice::from_raw_parts(std::ptr::addr_of!(BUF) as *const u8, len) }) as u32
}
#[no_mangle]
pub extern "C" fn w_scan(len: usize) -> u32 {
    surrogate_escapes(unsafe { std::slice::from_raw_parts(std::ptr::addr_of!(BUF) as *const u8, len) }) as u32
}
