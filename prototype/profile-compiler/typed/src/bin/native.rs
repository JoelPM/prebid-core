//! Times the typed guests natively (no wasm) on hostgo's payloads, as guest/src/bin/native.rs does
//! for the generated ones. Usage: cargo run --release --bin native -- ../out/payload
use std::time::Instant;

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
        let req = std::fs::read(format!("{dir}/pubmatic-lt-req.json")).unwrap();
        let end = Instant::now() + std::time::Duration::from_secs(secs.parse().unwrap());
        while Instant::now() < end {
            for _ in 0..1000 {
                out.clear();
                typed_guest::pubmatic::make_requests(&req, &mut out);
                std::hint::black_box(&out);
            }
        }
        return;
    }
    for b in ["openx", "pubmatic"] {
        let (mr, mb): (Mr, Mb) = match b {
            "openx" => (typed_guest::openx::make_requests, typed_guest::openx::make_bids),
            _ => (typed_guest::pubmatic::make_requests, typed_guest::pubmatic::make_bids),
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
        }
    }
}
