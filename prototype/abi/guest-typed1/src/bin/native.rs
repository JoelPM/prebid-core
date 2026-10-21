//! Times the generated typed guest natively on hostgo's payloads (as typed-ref/src/bin/native.rs does for the
//! hand-written one) and reports shape misses per call. Usage: cargo run --release --bin native -- ../out/payload
use std::time::Instant;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

// counts allocations, to report allocations per call
struct Count;
static ALLOCS: AtomicU64 = AtomicU64::new(0);
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static A: Count = Count;

fn time<F: FnMut()>(label: &str, mut f: F) -> f64 {
    for _ in 0..2000 {
        f();
    }
    let mut best = f64::MAX;
    for _ in 0..5 {
        let n = 20000;
        let t = Instant::now();
        for _ in 0..n {
            f();
        }
        best = best.min(t.elapsed().as_secs_f64() * 1e6 / n as f64);
    }
    println!("  {label:<40} {best:7.2} us");
    best
}

type Mr = fn(&[u8], &mut Vec<u8>);
type Mb = fn(&[u8], &[u8], &mut Vec<u8>);

fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let mut out = Vec::new();
    if let Some(secs) = std::env::args().nth(2) {
        // profiling loop: pubmatic lt make_requests for <secs> (macOS: `sample <pid>`)
        // profiling loop: pubmatic lt <mr|mb> for <secs> (macOS: `sample <pid>`)
        let rd = |s: &str| std::fs::read(format!("{dir}/{}-lt-{s}.json", std::env::args().nth(4).unwrap_or("pubmatic".into()))).unwrap();
        let (req, body, resp) = (rd("req"), rd("out"), rd("resp"));
        let mb = std::env::args().nth(3).as_deref() == Some("mb");
        let end = Instant::now() + std::time::Duration::from_secs(secs.parse().unwrap());
        while Instant::now() < end {
            for _ in 0..1000 {
                out.clear();
                let ox = std::env::args().nth(4).as_deref() == Some("openx");
                match (mb, ox) {
                    (true, true) => guest_typed1::openx::make_bids(&body, &resp, &mut out),
                    (false, true) => guest_typed1::openx::make_requests(&req, &mut out),
                    (true, false) => guest_typed1::pubmatic::make_bids(&body, &resp, &mut out),
                    (false, false) => guest_typed1::pubmatic::make_requests(&req, &mut out),
                }
                std::hint::black_box(&out);
            }
        }
        return;
    }
    for b in ["openx", "pubmatic"] {
        let (mr, mb): (Mr, Mb) = match b {
            "openx" => (guest_typed1::openx::make_requests, guest_typed1::openx::make_bids),
            _ => (guest_typed1::pubmatic::make_requests, guest_typed1::pubmatic::make_bids),
        };
        for name in ["lt", "heavy"] {
            let rd = |s: &str| std::fs::read(format!("{dir}/{b}-{name}-{s}.json")).unwrap();
            let (req, body, resp) = (rd("req"), rd("out"), rd("resp"));
            println!("{b} / {name}");
            let a = time("make_requests (incl. parse, emit)", || {
                out.clear();
                mr(&req, &mut out);
                std::hint::black_box(&out);
            });
            let c = time("make_bids (incl. parse)", || {
                out.clear();
                mb(&body, &resp, &mut out);
                std::hint::black_box(&out);
            });
            println!("  {:<40} {:7.2} us", "mr + mb", a + c);
            prebid_core_rt2::OFF_SHAPE.with(|c| c.set(0));
            out.clear();
            mr(&req, &mut out);
            out.clear();
            mb(&body, &resp, &mut out);
            println!("  {:<40} {:7}", "shape misses per mr + mb", prebid_core_rt2::OFF_SHAPE.with(|c| c.get()));
            out.clear();
            let a0 = ALLOCS.load(Ordering::Relaxed);
            mr(&req, &mut out);
            let a1 = ALLOCS.load(Ordering::Relaxed);
            out.clear();
            mb(&body, &resp, &mut out);
            let a2 = ALLOCS.load(Ordering::Relaxed);
            println!("  {:<40} {:7} / {}", "allocations per mr / mb", a1 - a0, a2 - a1);
        }
    }
}
