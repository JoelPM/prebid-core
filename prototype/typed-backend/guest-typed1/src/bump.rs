//! `bump` feature: a per-call bump arena as the global allocator. While a call runs, allocations
//! come from a static arena and frees are no-ops; the arena resets after the frame is copied out.
//! Anything allocated outside a call (the guest's input/output buffers) uses the system allocator.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;

const SIZE: usize = 1 << 20;
struct Arena(UnsafeCell<[u8; SIZE]>);
unsafe impl Sync for Arena {}
static ARENA: Arena = Arena(UnsafeCell::new([0; SIZE]));
static mut TOP: usize = 0;
static mut ON: bool = false;

fn base() -> usize {
    ARENA.0.get() as usize
}
fn ours(p: *mut u8) -> bool {
    let p = p as usize;
    p >= base() && p < base() + SIZE
}

pub fn begin() {
    unsafe { ON = true }
}
pub fn pause() {
    unsafe { ON = false }
}
pub fn reset() {
    unsafe { TOP = 0 }
}

struct Bump;
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ON {
            let p = (base() + TOP + l.align() - 1) & !(l.align() - 1);
            if p + l.size() <= base() + SIZE {
                TOP = p + l.size() - base();
                return p as *mut u8;
            }
        }
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if !ours(p) {
            System.dealloc(p, l)
        }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if !ours(p) {
            return System.realloc(p, l, n);
        }
        // grow in place when it is the last allocation
        if ON && p as usize + l.size() == base() + TOP && p as usize + n <= base() + SIZE {
            TOP = p as usize + n - base();
            return p;
        }
        let q = self.alloc(Layout::from_size_align_unchecked(n, l.align()));
        std::ptr::copy_nonoverlapping(p, q, l.size().min(n));
        q
    }
}

#[global_allocator]
static A: Bump = Bump;
